import { Injectable } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import {
  SearchResponseDto,
  SearchResultDto,
} from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { RawBuilder, sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  ParsedQuery,
  ParsedTerm,
  parseSearchQuery,
  SearchBooleanMode,
  SearchMatchMode,
  hasPositiveRecall,
} from './search-query-parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

// The FTS text-search configuration used on BOTH the stored side (pages.tsv via
// its trigger, see migration 20260707T120000) and the query side here. #529
// acceptance #13 invariant: column config and query config always change as a
// pair — flip this only alongside the migration.
const TS_CONFIG = 'ru_en';

// RRF constant (Cormack et al. 2009; the Elasticsearch/OpenSearch default). RRF
// fuses RANKS (not raw scores) so the incomparable ts_rank_cd (lexical) and the
// substring tier scales never need normalizing — that is the whole point.
const RRF_K = 60;

// Legacy prefix-tsquery builder (kept for the /suggest path + back-compat unit
// tests). The #529 engine below no longer uses it — it parses the query into an
// AST instead — but `buildTsQuery` remains exported and behaviour-identical.
//
// Strips everything that is not a letter/number/space BEFORE handing text to
// pg-tsquery so adversarial to_tsquery operators degrade to a neutral query
// instead of a 500.
export function buildTsQuery(raw: string): string {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  return tsquery(cleaned + '*');
}

// Escape the LIKE metacharacters (`%`, `_`, `\`) so every character is matched
// LITERALLY by a `col LIKE '%' || q || '%'` predicate. Without this a query of
// `%` or `_` would match every row.
export function escapeLikePattern(raw: string): string {
  return (raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

// Substring tier (highest first), used to rank the substring branch before RRF.
export enum SearchLookupTier {
  TITLE_EXACT = 3,
  TITLE_SUBSTRING = 2,
  TEXT = 1,
}

// Env-tunable fusion window: the top-N candidates (by RRF) that pagination can
// reach. The tail beyond it is unreachable (truncatedAtCap:true). Default 500.
function getCandidateCap(): number {
  const raw = Number(process.env.SEARCH_CANDIDATE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

// Global AND/OR toggle: SEARCH_MODE overrides the request `mode` default. Both
// are valid on the ru_en tsv — this is a parser toggle, NOT a config rollback.
function defaultBooleanMode(): SearchBooleanMode {
  return process.env.SEARCH_MODE === 'and' ? 'and' : 'or';
}

@Injectable()
export class SearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
  ) {}

  // === #529 SQL fragment builders (parameterized AST, never string-concat) =====

  // to_tsquery for a single FTS term. The term's own (already metachar-stripped)
  // words are joined with `&` and given a `:*` suffix for the prefix branch. The
  // whole lexeme string is a BOUND parameter to to_tsquery — no user operator can
  // reach the parser.
  private ftsTermTsq(term: ParsedTerm): RawBuilder<unknown> {
    const words = term.text.split(/\s+/).filter(Boolean);
    const suffix = term.branch === 'ftsPrefix' ? ':*' : '';
    const lexeme = words.map((w) => w + suffix).join(' & ');
    return sql`to_tsquery(${TS_CONFIG}, f_unaccent(${lexeme}))`;
  }

  private phraseTermTsq(term: ParsedTerm): RawBuilder<unknown> {
    return sql`phraseto_tsquery(${TS_CONFIG}, f_unaccent(${term.text}))`;
  }

  private termTsq(term: ParsedTerm): RawBuilder<unknown> {
    return term.branch === 'phrase'
      ? this.phraseTermTsq(term)
      : this.ftsTermTsq(term);
  }

  // Fold FTS/phrase term tsqueries into ONE tsquery via the SQL `||` operator
  // (AND via `&&` when mode is 'and'). Returns null when there are no such terms.
  private combineTsq(
    terms: ParsedTerm[],
    mode: SearchBooleanMode,
  ): RawBuilder<unknown> | null {
    const ftsTerms = terms.filter((t) => t.branch !== 'substring');
    if (ftsTerms.length === 0) return null;
    const op = mode === 'and' ? sql`&&` : sql`||`;
    let acc: RawBuilder<unknown> = sql`(${this.termTsq(ftsTerms[0])})`;
    for (let i = 1; i < ftsTerms.length; i++) {
      acc = sql`(${acc}) ${op} (${this.termTsq(ftsTerms[i])})`;
    }
    return acc;
  }

  // A LIKE '%needle%' pattern in the LOWER(f_unaccent(...)) space. Coalesce-free
  // so it can use the trigram GIN indexes (a coalesce wrapper would force a seq
  // scan). NULL title/text simply doesn't match, exactly as '' wouldn't.
  private likePattern(term: ParsedTerm): RawBuilder<unknown> {
    const body = '%' + escapeLikePattern(term.text) + '%';
    return sql`LOWER(f_unaccent(${body}))`;
  }

  private substringPred(
    term: ParsedTerm,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const pat = this.likePattern(term);
    const title = sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`;
    if (titleOnly) return sql`(${title})`;
    const text = sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`;
    return sql`(${title} OR ${text})`;
  }

  // Whole-candidate match predicate for a single term (required / excluded
  // predicates, and per-hit matchedTerms).
  private termMatchPred(
    term: ParsedTerm,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    if (term.branch === 'substring') return this.substringPred(term, titleOnly);
    return sql`(pages.tsv @@ ${this.termTsq(term)})`;
  }

  // The positive RECALL predicate: OR (or AND, per mode) of every positive term's
  // match — the FTS terms via one combined tsquery, the substring terms via LIKE.
  private positiveRecall(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    const tsq = this.combineTsq(parsed.positive, parsed.mode);
    if (tsq) parts.push(sql`(pages.tsv @@ (${tsq}))`);
    for (const t of parsed.positive.filter((x) => x.branch === 'substring')) {
      parts.push(this.substringPred(t, titleOnly));
    }
    if (parts.length === 0) return sql`false`;
    const op = parsed.mode === 'and' ? sql` AND ` : sql` OR `;
    return sql`(${sql.join(parts, op)})`;
  }

  // The full candidate WHERE: positive recall AND every required AND none of the
  // excluded. Required terms with no positive term ARE the recall (A2).
  private candidatePredicate(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const preds: RawBuilder<unknown>[] = [];
    if (parsed.positive.length > 0) {
      preds.push(this.positiveRecall(parsed, titleOnly));
    }
    for (const t of parsed.required) {
      preds.push(this.termMatchPred(t, titleOnly));
    }
    for (const t of parsed.excluded) {
      preds.push(sql`NOT ${this.termMatchPred(t, titleOnly)}`);
    }
    if (preds.length === 0) return sql`false`;
    return sql`(${sql.join(preds, sql` AND `)})`;
  }

  // ts_rank_cd over the positive FTS tsquery. NULL when the query has no FTS
  // positive term (pure-substring query) — the row is then absent from the FTS
  // RRF branch.
  private ftsScoreExpr(parsed: ParsedQuery): RawBuilder<unknown> {
    const tsq = this.combineTsq(parsed.positive, parsed.mode);
    if (!tsq) return sql`NULL::float`;
    return sql`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_rank_cd(pages.tsv, (${tsq})) ELSE NULL END`;
  }

  // Substring tier (3 title-exact / 2 title-substring / 1 text) or NULL when the
  // row matched no positive substring term. Drives the substring RRF branch.
  private subTierExpr(
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): RawBuilder<unknown> {
    const subTerms = parsed.positive.filter((t) => t.branch === 'substring');
    if (subTerms.length === 0) return sql`NULL::int`;
    const exact: RawBuilder<unknown>[] = [];
    const titleSub: RawBuilder<unknown>[] = [];
    const textSub: RawBuilder<unknown>[] = [];
    for (const t of subTerms) {
      const needle = sql`LOWER(f_unaccent(${t.text}))`;
      const pat = this.likePattern(t);
      exact.push(sql`LOWER(f_unaccent(pages.title)) = ${needle}`);
      titleSub.push(sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`);
      textSub.push(
        sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`,
      );
    }
    const exactOr = sql`(${sql.join(exact, sql` OR `)})`;
    const titleOr = sql`(${sql.join(titleSub, sql` OR `)})`;
    const textOr = titleOnly
      ? sql`false`
      : sql`(${sql.join(textSub, sql` OR `)})`;
    return sql`CASE WHEN ${exactOr} THEN 3 WHEN ${titleOr} THEN 2 WHEN ${textOr} THEN 1 ELSE NULL END`;
  }

  // === Main entry (A6 unified path) ==========================================

  async searchPage(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<SearchResponseDto> {
    const rawQuery = (searchParams.query ?? '').trim();
    const mode = defaultBooleanMode();
    const match = (searchParams.match as SearchMatchMode) ?? 'auto';
    const parsed = parseSearchQuery(rawQuery, { match, mode });
    const titleOnly = Boolean(searchParams.titleOnly);
    const limit = Math.min(Math.max(searchParams.limit || 25, 1), 100);
    const offset = Math.max(searchParams.offset || 0, 0);
    const cap = getCandidateCap();

    const queryMeta = {
      raw: parsed.raw,
      parsed: {
        positive: parsed.positive.map((t) => t.text),
        required: parsed.required.map((t) => t.text),
        excluded: parsed.excluded.map((t) => t.text),
        reason: parsed.reason,
      },
      mode: parsed.mode,
      match,
    };

    const empty = (reason?: string): SearchResponseDto => ({
      items: [],
      total: 0,
      hasMore: false,
      truncatedAtCap: false,
      offset,
      query: reason
        ? { ...queryMeta, parsed: { ...queryMeta.parsed, reason } }
        : queryMeta,
    });

    // Only-negation / empty query: never run an expensive NOT-only scan (A2).
    if (!hasPositiveRecall(parsed)) {
      return empty(parsed.reason);
    }

    // --- Resolve scope (A6). --------------------------------------------------
    const scope = await this.resolveScope(searchParams, opts);
    if (scope.kind === 'none') return empty();

    // --- Optional parentPageId subtree scope. ---------------------------------
    let descendantIds: string[] | null = null;
    if (searchParams.parentPageId) {
      const descendants = await this.pageRepo.getPageAndDescendants(
        searchParams.parentPageId,
        { includeContent: false },
      );
      descendantIds = descendants.map((p: any) => p.id);
      if (descendantIds.length === 0) return empty();
    }

    // --- Build the shared candidate WHERE fragment. ---------------------------
    const scopePreds: RawBuilder<unknown>[] = [sql`pages.deleted_at IS NULL`];
    if (scope.kind === 'spaces') {
      scopePreds.push(
        sql`pages.space_id = ANY(${scope.spaceIds}::uuid[])`,
        sql`pages.workspace_id = ${scope.workspaceId}`,
      );
    } else {
      // share: an explicit (already permission-filtered) id set.
      scopePreds.push(
        sql`pages.id = ANY(${scope.pageIds}::uuid[])`,
        sql`pages.workspace_id = ${scope.workspaceId}`,
      );
    }
    if (searchParams.creatorId) {
      scopePreds.push(sql`pages.creator_id = ${searchParams.creatorId}`);
    }
    if (descendantIds) {
      scopePreds.push(sql`pages.id = ANY(${descendantIds}::uuid[])`);
    }
    const scopeSql = sql`(${sql.join(scopePreds, sql` AND `)})`;
    const candidateSql = sql`(${scopeSql} AND ${this.candidatePredicate(parsed, titleOnly)})`;

    // --- Ranked candidate ids (ALL matches, RRF order). -----------------------
    // Two independent branches ranked SEPARATELY (FTS by ts_rank_cd, substring by
    // tier) then fused with RRF: score = Σ 1/(k + rank_branch). Deterministic
    // ORDER BY rrf DESC, id so pagination never dupes/skips (A4, acceptance #8).
    const rankedRows = await sql<{ id: string }>`
      WITH candidates AS (
        SELECT pages.id AS id,
               ${this.ftsScoreExpr(parsed)} AS fts_score,
               ${this.subTierExpr(parsed, titleOnly)} AS sub_tier
        FROM pages
        WHERE ${candidateSql}
      ),
      ranked AS (
        SELECT id, fts_score, sub_tier,
               row_number() OVER (ORDER BY fts_score DESC NULLS LAST, id) AS rn_fts,
               row_number() OVER (ORDER BY sub_tier DESC NULLS LAST, id) AS rn_sub
        FROM candidates
      )
      SELECT id
      FROM ranked
      ORDER BY
        (CASE WHEN fts_score IS NOT NULL THEN 1.0/(${RRF_K} + rn_fts) ELSE 0 END)
        + (CASE WHEN sub_tier IS NOT NULL THEN 1.0/(${RRF_K} + rn_sub) ELSE 0 END) DESC,
        id ASC
    `.execute(this.db);

    let orderedIds = rankedRows.rows.map((r) => r.id);

    // --- Permission filter (fail-closed, exact total). ------------------------
    // filterAccessiblePageIds runs the #348 hasRestricted pre-check internally:
    // no restricted pages in scope → returns the ids untouched (fast path, total
    // stays trivially exact); otherwise a SQL anti-join drops hidden pages. An
    // error PROPAGATES (500) — it never degrades to an empty lexical result, so
    // hidden-page cardinality never leaks into `total`. The share path is already
    // permission-filtered by getPageAndDescendantsExcludingRestricted.
    if (opts.userId && scope.kind === 'spaces' && orderedIds.length > 0) {
      const accessible = await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: orderedIds,
        userId: opts.userId,
        spaceId: searchParams.spaceId,
        workspaceId: opts.workspaceId,
      });
      const accessibleSet = new Set(accessible);
      orderedIds = orderedIds.filter((id) => accessibleSet.has(id));
    }

    const total = orderedIds.length;
    const truncatedAtCap = total > cap;
    const window = orderedIds.slice(0, cap);
    const pageIds = window.slice(offset, offset + limit);
    const hasMore = offset + pageIds.length < window.length;

    if (pageIds.length === 0) {
      return { items: [], total, hasMore, truncatedAtCap, offset, query: queryMeta };
    }

    // --- Detail fetch for the page slice only (ts_headline/snippet are costly, so
    //     compute them ONLY for the returned rows), preserving RRF order. -------
    const items = await this.fetchDetails(pageIds, parsed, titleOnly);

    return { items, total, hasMore, truncatedAtCap, offset, query: queryMeta };
  }

  // Resolve the search scope: explicit space, the authed user's member spaces, or
  // a public share's descendant id set (permission-filtered). Mirrors the legacy
  // branch logic (A6) but returns a small tagged union.
  private async resolveScope(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<
    | { kind: 'none' }
    | { kind: 'spaces'; spaceIds: string[]; workspaceId: string }
    | { kind: 'ids'; pageIds: string[]; workspaceId: string }
  > {
    if (searchParams.spaceId) {
      return {
        kind: 'spaces',
        spaceIds: [searchParams.spaceId],
        workspaceId: opts.workspaceId,
      };
    }

    if (opts.userId && !searchParams.shareId) {
      const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
      if (spaceIds.length === 0) return { kind: 'none' };
      return { kind: 'spaces', spaceIds, workspaceId: opts.workspaceId };
    }

    if (searchParams.shareId && !opts.userId) {
      const share = await this.shareRepo.findById(searchParams.shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { kind: 'none' };
      }
      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) return { kind: 'none' };

      const pageIds: string[] = [];
      if (share.includeSubPages) {
        // A6: exclude restricted descendants + honour a restricted ancestor.
        const pageList =
          await this.pageRepo.getPageAndDescendantsExcludingRestricted(
            share.pageId,
            { includeContent: false },
          );
        pageIds.push(...pageList.map((p) => p.id));
      } else {
        pageIds.push(share.pageId);
      }
      if (pageIds.length === 0) return { kind: 'none' };
      return { kind: 'ids', pageIds, workspaceId: opts.workspaceId };
    }

    return { kind: 'none' };
  }

  // Fetch the display superset (A7) for the given page ids, in the given order.
  private async fetchDetails(
    pageIds: string[],
    parsed: ParsedQuery,
    titleOnly: boolean,
  ): Promise<SearchResultDto[]> {
    const tsq = this.combineTsq(parsed.positive, parsed.mode);
    // rank/highlight are FTS-only (null for substring-only hits — the web already
    // falls back). ts_headline runs over the ORIGINAL text.
    const rankExpr = tsq
      ? sql<number>`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_rank_cd(pages.tsv, (${tsq})) ELSE NULL END`
      : sql<number>`NULL::float`;
    const highlightExpr = tsq
      ? sql<string>`CASE WHEN pages.tsv @@ (${tsq}) THEN ts_headline(${TS_CONFIG}, coalesce(pages.text_content, ''), (${tsq}), 'MinWords=9, MaxWords=10, MaxFragments=3') ELSE NULL END`
      : sql<string>`NULL::text`;

    // Windowed plain snippet: leading window, else the FTS headline (plain).
    const snippetExpr = titleOnly
      ? sql<string>`''`
      : sql<string>`coalesce(
          case
            when coalesce(pages.text_content, '') <> ''
              then substring(LOWER(f_unaccent(pages.text_content)) from 1 for 300)
            ${
              tsq
                ? sql`else ts_headline(${TS_CONFIG}, coalesce(pages.text_content, ''), (${tsq}), 'MinWords=25, MaxWords=40, MaxFragments=3')`
                : sql``
            }
          end, '')`;

    // matchedFields: title / text.
    const titleMatchParts: RawBuilder<unknown>[] = [];
    const textMatchParts: RawBuilder<unknown>[] = [];
    if (tsq) {
      titleMatchParts.push(
        sql`to_tsvector(${TS_CONFIG}, f_unaccent(coalesce(pages.title, ''))) @@ (${tsq})`,
      );
      if (!titleOnly) {
        textMatchParts.push(
          sql`(pages.tsv @@ (${tsq}) AND NOT to_tsvector(${TS_CONFIG}, f_unaccent(coalesce(pages.title, ''))) @@ (${tsq}))`,
        );
      }
    }
    for (const t of parsed.positive.filter((x) => x.branch === 'substring')) {
      const pat = this.likePattern(t);
      titleMatchParts.push(
        sql`LOWER(f_unaccent(pages.title)) LIKE ${pat} ESCAPE '\\'`,
      );
      if (!titleOnly) {
        textMatchParts.push(
          sql`LOWER(f_unaccent(pages.text_content)) LIKE ${pat} ESCAPE '\\'`,
        );
      }
    }
    const titleMatchExpr = titleMatchParts.length
      ? sql<boolean>`(${sql.join(titleMatchParts, sql` OR `)})`
      : sql<boolean>`false`;
    const textMatchExpr = textMatchParts.length
      ? sql<boolean>`(${sql.join(textMatchParts, sql` OR `)})`
      : sql<boolean>`false`;

    // Per-term matched flags (positive + required), assembled into matchedTerms.
    // NB: aliases must be UNDERSCORE-FREE — the app's Kysely runs the
    // CamelCasePlugin, which would rewrite a `t_0` result key to `t0`. `tmatch0`
    // survives the round-trip unchanged.
    const allTerms = [...parsed.positive, ...parsed.required];
    const termCols = allTerms.map(
      (t, i) =>
        sql`(${this.termMatchPred(t, titleOnly)}) AS "tmatch${sql.raw(String(i))}"`,
    );

    let q = this.db
      .selectFrom('pages')
      .select([
        'pages.id as id',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.icon as icon',
        'pages.parentPageId as parentPageId',
        'pages.creatorId as creatorId',
        'pages.spaceId as spaceId',
        'pages.createdAt as createdAt',
        'pages.updatedAt as updatedAt',
        rankExpr.as('rank'),
        highlightExpr.as('highlight'),
        snippetExpr.as('snippet'),
        titleMatchExpr.as('titleMatch'),
        textMatchExpr.as('textMatch'),
      ])
      .select((eb) => this.pageRepo.withSpace(eb))
      .where(sql<boolean>`pages.id = ANY(${pageIds}::uuid[])` as any);

    if (termCols.length > 0) {
      q = q.select(termCols as any);
    }

    const rows: any[] = await q.execute();

    const byId = new Map<string, any>(rows.map((r) => [r.id, r]));
    const pathById = await this.buildAncestorPaths(pageIds);

    const items: SearchResultDto[] = [];
    for (const id of pageIds) {
      const r = byId.get(id);
      if (!r) continue;
      const matchedFields: string[] = [];
      if (r.titleMatch) matchedFields.push('title');
      if (r.textMatch) matchedFields.push('text');
      const matchedTerms: string[] = [];
      allTerms.forEach((t, i) => {
        if (r[`tmatch${i}`]) matchedTerms.push(t.text);
      });
      const rank = r.rank == null ? null : Number(r.rank);
      const highlight = r.highlight
        ? String(r.highlight)
            .replace(/\r\n|\r|\n/g, ' ')
            .replace(/\s+/g, ' ')
        : null;
      const snippet = (r.snippet ?? '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      items.push({
        id: r.id,
        pageId: r.id,
        slugId: r.slugId,
        icon: r.icon,
        title: r.title,
        space: r.space,
        creatorId: r.creatorId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        rank,
        highlight,
        snippet,
        path: pathById.get(id) ?? [],
        // A per-response ordering proxy for legacy consumers; falls back to rank.
        score: rank ?? 0,
        matchedFields,
        matchedTerms: Array.from(new Set(matchedTerms)),
      });
    }
    return items;
  }

  /**
   * Batch ancestor-titles helper: ONE recursive CTE seeded with ALL hit ids,
   * walking UP parentPageId. Returns hitId → ancestor titles ordered root →
   * direct parent (the hit's own title excluded).
   *
   * A8 fix: the recursive walk now skips soft-deleted ancestors (`deleted_at IS
   * NULL`) and stays within the hit's own space, so a deleted or cross-space
   * ancestor's title can no longer leak into `path`.
   */
  private async buildAncestorPaths(
    hitIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (hitIds.length === 0) return result;

    const rows = await this.db
      .withRecursive('ancestry', (db) =>
        db
          .selectFrom('pages')
          .select([
            'pages.id as hitId',
            'pages.id as pageId',
            'pages.title as title',
            'pages.parentPageId as parentPageId',
            'pages.spaceId as spaceId',
            sql<number>`0`.as('depth'),
          ])
          .where('pages.id', 'in', hitIds)
          .where('pages.deletedAt', 'is', null)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .innerJoin('ancestry as a', 'p.id', 'a.parentPageId')
              // A8: don't cross into a deleted ancestor or another space.
              .where('p.deletedAt', 'is', null)
              .whereRef('p.spaceId', '=', 'a.spaceId')
              .select([
                'a.hitId as hitId',
                'p.id as pageId',
                'p.title as title',
                'p.parentPageId as parentPageId',
                'a.spaceId as spaceId',
                sql<number>`a.depth + 1`.as('depth'),
              ]),
          ),
      )
      .selectFrom('ancestry')
      .select(['hitId', 'title', 'depth'])
      .where('depth', '>', 0)
      .orderBy('hitId')
      .orderBy('depth', 'desc')
      .execute();

    for (const r of rows as any[]) {
      const list = result.get(r.hitId) ?? [];
      list.push(r.title);
      result.set(r.hitId, list);
    }
    return result;
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .limit(limit);

      if (suggestion.onlyTemplates) {
        pageSearch = pageSearch.where('isTemplate', '=', true);
      }

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
            workspaceId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
