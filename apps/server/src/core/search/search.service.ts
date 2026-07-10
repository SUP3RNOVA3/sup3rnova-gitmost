import { Injectable } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import {
  SearchLookupResponseDto,
  SearchResponseDto,
} from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

// Build a safe prefix tsquery string from a raw user query.
//
// The previous inline form `tsquery(query.trim() + '*')` passed user input
// (including to_tsquery operators like `&`, `|`, `!`, `<->`, `*`, backslashes)
// straight through. pg-tsquery would then emit operator fragments that
// `to_tsquery('english', ...)` can reject as a syntax error, turning a search
// into a 500. We strip everything that is not a letter, number or whitespace
// BEFORE handing the text to pg-tsquery, so adversarial input degrades to a
// neutral (possibly empty) query instead of throwing, while normal word queries
// (incl. accented / non-Latin words) are unaffected.
export function buildTsQuery(raw: string): string {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    // Keep Unicode letters/numbers and whitespace; drop everything else.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  return tsquery(cleaned + '*');
}

// Escape the LIKE metacharacters (`%`, `_`, `\`) in a raw user query so every
// character — including `.`, `-`, `_`, `%`, `/` — is matched LITERALLY by a
// `col LIKE '%' || q || '%'` predicate. Without this, a query of `%` or `_`
// would match every row (see the #443 acceptance table). The backslash is the
// escape char (Postgres LIKE default), so it must be escaped first.
export function escapeLikePattern(raw: string): string {
  return (raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

// Ranking tiers for the agent-lookup mode (#443), highest first. A hit's tier
// is the strongest way it matched; ties inside a tier break on a secondary
// signal (FTS rank, or first-match position). The numeric `score` returned to
// the caller is derived from (tier, secondary) and is meaningful ONLY for
// ordering within a single response.
export enum SearchLookupTier {
  // Title equals the query, case-insensitively.
  TITLE_EXACT = 3,
  // Query is a substring of the title.
  TITLE_SUBSTRING = 2,
  // Query matched in the text (substring or FTS).
  TEXT = 1,
}

export interface RankableHit {
  tier: SearchLookupTier;
  // Secondary in-tier signal, higher = better (e.g. ts_rank, or a
  // position-derived closeness score). Defaults to 0.
  secondary?: number;
}

// Map (tier, secondary) → a 0..1 float used ONLY to sort one response.
//
// Formula: score = (tier + squash(secondary)) / (maxTier + 1), where
//   squash(x) = x / (1 + x)  maps any non-negative secondary into [0, 1)
// so a stronger tier ALWAYS outranks a weaker one regardless of the secondary
// value, and within a tier a larger secondary sorts higher. maxTier is the top
// enum value (TITLE_EXACT = 3), so the divisor keeps the result in (0, 1].
export function computeLookupScore(hit: RankableHit): number {
  const maxTier = SearchLookupTier.TITLE_EXACT;
  const secondary = Math.max(0, hit.secondary ?? 0);
  const squashed = secondary / (1 + secondary);
  return (hit.tier + squashed) / (maxTier + 1);
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

  async searchPage(
    searchParams: SearchDTO,
    opts: {
      userId?: string;
      workspaceId: string;
    },
  ): Promise<{ items: SearchResponseDto[] | SearchLookupResponseDto[] }> {
    const { query } = searchParams;

    if (query.length < 1) {
      return { items: [] };
    }

    // Opt-in agent-lookup mode (#443). Guarded by the `substring` flag so the
    // web-UI (which never sets it) keeps byte-identical FTS behaviour below.
    if (searchParams.substring) {
      return this.searchPageLookup(searchParams, opts);
    }

    const searchQuery = buildTsQuery(query);

    let queryResults = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
          'rank',
        ),
        sql<string>`ts_headline('english', text_content, to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        ),
      ])
      .where(
        'tsv',
        '@@',
        sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .limit(searchParams.limit || 25)
      .offset(searchParams.offset || 0);

    if (!searchParams.shareId) {
      queryResults = queryResults.select((eb) => this.pageRepo.withSpace(eb));
    }

    if (searchParams.spaceId) {
      // search by spaceId
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.userId && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.userId) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [] };
      }

      const isRestricted =
        await this.pagePermissionRepo.hasRestrictedAncestor(share.pageId);
      if (isRestricted) {
        return { items: [] };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList = await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          {
            includeContent: false,
          },
        );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    //@ts-ignore
    let results: any[] = await queryResults.execute();

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && results.length > 0) {
      const pageIds = results.map((r: any) => r.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
          // #348 — enables the workspace-level short-circuit when not space-scoped.
          workspaceId: opts.workspaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      results = results.filter((r: any) => accessibleSet.has(r.id));
    }

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      if (result.highlight) {
        result.highlight = result.highlight
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result;
    });

    return { items: searchResults };
  }

  /**
   * Agent-lookup search (#443, opt-in via `SearchDTO.substring`).
   *
   * ADDITIVE to the FTS path: runs a substring branch (title + optionally
   * text_content, LIKE with metacharacters escaped) MERGED with the existing
   * FTS branch, so technical tokens that the `english` tokenizer mangles
   * (`backup-srv.local`, `10.0.12.5`, `WB-MGE-30D86B`) are still found — even
   * when `buildTsQuery()` returns '' for a dotted/numeric query. Results carry a
   * location (`path`), a windowed `snippet` and a per-response `score`.
   *
   * The whole method is only reached when `substring: true`; the web-UI never
   * sets it, so its behaviour is unchanged.
   */
  private async searchPageLookup(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<{ items: SearchLookupResponseDto[] }> {
    const rawQuery = searchParams.query.trim();
    if (!rawQuery) {
      return { items: [] };
    }

    const limit = Math.min(Math.max(searchParams.limit || 10, 1), 50);

    // Normalize the query the same way as the FTS / suggest path: f_unaccent +
    // lower, done in SQL. `q` is the escaped LIKE pattern body (literal chars).
    const likeBody = escapeLikePattern(rawQuery);
    // Compare against `LOWER(f_unaccent(col))`; unaccent+lower the needle too.
    const needle = sql<string>`LOWER(f_unaccent(${rawQuery}))`;
    const likePattern = sql<string>`LOWER(f_unaccent(${'%' + likeBody + '%'}))`;
    const tsQuery = buildTsQuery(rawQuery);
    const hasTsQuery = tsQuery.length > 0;

    // --- Resolve the space scope. ---------------------------------------------
    // Mirrors searchPage: explicit spaceId, else the authenticated user's member
    // spaces. The share path is not exposed to this opt-in mode.
    let spaceIds: string[] = [];
    if (searchParams.spaceId) {
      spaceIds = [searchParams.spaceId];
    } else if (opts.userId) {
      spaceIds = await this.spaceMemberRepo.getUserSpaceIds(opts.userId);
    } else {
      return { items: [] };
    }
    if (spaceIds.length === 0) {
      return { items: [] };
    }

    // --- Optional parentPageId subtree scope (inclusive). ---------------------
    // Reuse the same recursive-descendants pattern used for share-scope.
    let descendantIds: string[] | null = null;
    if (searchParams.parentPageId) {
      const descendants = await this.pageRepo.getPageAndDescendants(
        searchParams.parentPageId,
        { includeContent: false },
      );
      descendantIds = descendants.map((p: any) => p.id);
      if (descendantIds.length === 0) {
        return { items: [] };
      }
    }

    // --- Candidate query: substring (title + text) UNION FTS. -----------------
    // We compute everything the ranker needs in SQL and pull only small columns
    // (never the whole text_content) into Node:
    //   - titleExact / titleSub: tier signals
    //   - textMatchPos: 1-based position of the first text match (0 = none)
    //   - ftsRank: ts_rank for the FTS secondary signal (0 when no tsquery)
    //   - snippet: windowed ~500 chars around the first text match, or a leading
    //     text window (title-only hit), or an extended ts_headline fallback.
    const N_BEFORE = 60; // chars of context before the first match
    const SNIPPET_LEN = 500;

    let candidates = this.db
      .selectFrom('pages')
      .select([
        'pages.id as id',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.parentPageId as parentPageId',
        // Tier signals.
        sql<boolean>`LOWER(f_unaccent(coalesce(pages.title, ''))) = ${needle}`.as(
          'titleExact',
        ),
        sql<boolean>`LOWER(f_unaccent(coalesce(pages.title, ''))) LIKE ${likePattern} ESCAPE '\\'`.as(
          'titleSub',
        ),
        // 1-based position of the first text match (0 = no text match).
        sql<number>`strpos(LOWER(f_unaccent(coalesce(pages.text_content, ''))), ${needle})`.as(
          'textMatchPos',
        ),
        // FTS secondary signal (0 when the tsquery is empty).
        hasTsQuery
          ? sql<number>`ts_rank(pages.tsv, to_tsquery('english', f_unaccent(${tsQuery})))`.as(
              'ftsRank',
            )
          : sql<number>`0`.as('ftsRank'),
        // Windowed snippet, computed entirely in SQL. Priority:
        //  1. window around the first text match;
        //  2. otherwise (titleOnly: no snippet; else) a leading window of the
        //     page text (title-only hit);
        //  3. otherwise an extended ts_headline for pure-FTS hits.
        //
        // #443 snippet-position fix: the match position (`strpos`) is computed in
        // the LOWER(f_unaccent(...)) space, but f_unaccent is NOT length-
        // preserving (ß→ss, æ→ae, …→..., ½→ 1/2, full-width forms), so slicing
        // the ORIGINAL text at that position was misaligned — a single expanding
        // char before the match shifted the window (or ran it past end → empty).
        // We now slice from the SAME LOWER(f_unaccent(...)) string so position
        // and slice share one coordinate space. DELIBERATE trade-off: the snippet
        // loses original case/diacritics — acceptable for an agent-facing snippet
        // (position accuracy over original-glyph fidelity). The ts_headline branch
        // matches over the ORIGINAL text itself, so it is unaffected and kept as-is.
        searchParams.titleOnly
          ? sql<string>`''`.as('snippet')
          : sql<string>`
          coalesce(
            case
              when strpos(LOWER(f_unaccent(coalesce(pages.text_content, ''))), ${needle}) > 0
                then substring(
                  LOWER(f_unaccent(coalesce(pages.text_content, '')))
                  from greatest(1, strpos(LOWER(f_unaccent(coalesce(pages.text_content, ''))), ${needle}) - ${N_BEFORE})
                  for ${SNIPPET_LEN}
                )
              when coalesce(pages.text_content, '') <> ''
                then substring(LOWER(f_unaccent(pages.text_content)) from 1 for 300)
              ${
                hasTsQuery
                  ? sql`else ts_headline('english', coalesce(pages.text_content, ''), to_tsquery('english', f_unaccent(${tsQuery})), 'MinWords=25, MaxWords=40, MaxFragments=3')`
                  : sql``
              }
            end,
            ''
          )
        `.as('snippet'),
      ])
      .where('pages.deletedAt', 'is', null)
      .where('pages.spaceId', 'in', spaceIds);

    if (descendantIds) {
      candidates = candidates.where('pages.id', 'in', descendantIds);
    }

    // Match predicate: title substring OR (unless titleOnly) text substring OR
    // (unless titleOnly) FTS. The substring branch runs even when the tsquery is
    // empty — that is the dotted/numeric-token case the FTS path misses.
    candidates = candidates.where((eb) => {
      const ors = [
        eb(
          sql`LOWER(f_unaccent(coalesce(pages.title, '')))`,
          'like',
          sql`${likePattern} ESCAPE '\\'`,
        ),
      ];
      if (!searchParams.titleOnly) {
        ors.push(
          eb(
            sql`LOWER(f_unaccent(coalesce(pages.text_content, '')))`,
            'like',
            sql`${likePattern} ESCAPE '\\'`,
          ),
        );
        if (hasTsQuery) {
          ors.push(
            sql<boolean>`pages.tsv @@ to_tsquery('english', f_unaccent(${tsQuery}))` as any,
          );
        }
      }
      return eb.or(ors);
    });

    // Pull a generous candidate set (before permission filtering + limit).
    // Cap it so a pathological match set cannot blow up memory; 200 >> limit
    // (max 50) leaves ample headroom for the post-permission truncation.
    //
    // #443 cap-ordering fix: the 200-cap MUST be deterministic and relevance-
    // biased. Without an ORDER BY, Postgres returns an ARBITRARY 200 rows, so on
    // a broad match set (common word / short substring) a strong TITLE_EXACT hit
    // could be among the dropped rows while 200 low-tier TEXT hits fill the cap.
    // We order by the SAME SQL tier proxies the Node ranker uses — title-exact,
    // then title-substring, then fts-rank (nulls last), then earliest text-match
    // position — so the cap keeps the strongest candidates. The Node-side final
    // tier sort + slice(0, limit) below still runs and stays authoritative; this
    // ORDER BY only decides WHICH candidates survive the 200-cap.
    // NB: a BARE integer literal in ORDER BY is read by Postgres as an ordinal
    // column position (`ORDER BY 0` → "position 0 is not in select list"), so the
    // no-tsquery fallback is `0::float`, not `0`.
    const ftsRankExpr = hasTsQuery
      ? sql`ts_rank(pages.tsv, to_tsquery('english', f_unaccent(${tsQuery})))`
      : sql`0::float`;
    const candidatesCapped = candidates
      // Raw-SQL ORDER BY expressions: pass the full `<expr> <dir>` as ONE arg
      // (the two-arg form treats a raw-SQL second arg as an ORDER BY position).
      .orderBy(
        sql`(LOWER(f_unaccent(coalesce(pages.title, ''))) = ${needle}) desc`,
      )
      .orderBy(
        sql`(LOWER(f_unaccent(coalesce(pages.title, ''))) LIKE ${likePattern} ESCAPE '\\') desc`,
      )
      .orderBy(sql`${ftsRankExpr} desc nulls last`)
      // Earlier text match first; strpos returns 0 for "no match", which would
      // sort BEFORE a real (>=1) position under plain ASC, so push 0 to the end.
      .orderBy(
        sql`case when strpos(LOWER(f_unaccent(coalesce(pages.text_content, ''))), ${needle}) = 0 then 2147483647 else strpos(LOWER(f_unaccent(coalesce(pages.text_content, ''))), ${needle}) end asc`,
      );

    let rows: any[] = await candidatesCapped.limit(200).execute();

    if (rows.length === 0) {
      return { items: [] };
    }

    // --- Permissions BEFORE limit. --------------------------------------------
    // Apply the existing page-level post-filter to the MERGED set, then rank and
    // only THEN truncate to `limit` — never lose the permission filter.
    if (opts.userId) {
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: rows.map((r) => r.id),
          userId: opts.userId,
          spaceId: searchParams.spaceId,
          workspaceId: opts.workspaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      rows = rows.filter((r) => accessibleSet.has(r.id));
    }

    if (rows.length === 0) {
      return { items: [] };
    }

    // --- Tiered ranking + dedup. ----------------------------------------------
    // Rows are already unique by id (single pages scan), so no cross-branch
    // dedup is needed here; the tier captures the strongest match reason.
    const ranked = rows.map((r) => {
      let tier: SearchLookupTier;
      let secondary: number;
      if (r.titleExact) {
        tier = SearchLookupTier.TITLE_EXACT;
        secondary = Number(r.ftsRank) || 0;
      } else if (r.titleSub) {
        tier = SearchLookupTier.TITLE_SUBSTRING;
        secondary = Number(r.ftsRank) || 0;
      } else {
        tier = SearchLookupTier.TEXT;
        // Prefer earlier text matches; map position → closeness in (0, 1].
        const pos = Number(r.textMatchPos) || 0;
        secondary =
          pos > 0 ? 1 / (1 + (pos - 1) / 100) : Number(r.ftsRank) || 0;
      }
      return { row: r, tier, score: computeLookupScore({ tier, secondary }) };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, limit);

    // --- Batch ancestor path (ONE recursive CTE, not N+1). --------------------
    const pathById = await this.buildAncestorPaths(top.map((t) => t.row.id));

    const items: SearchLookupResponseDto[] = top.map((t) => ({
      id: t.row.id,
      slugId: t.row.slugId,
      title: t.row.title,
      parentPageId: t.row.parentPageId ?? null,
      path: pathById.get(t.row.id) ?? [],
      snippet: (t.row.snippet ?? '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      score: t.score,
    }));

    return { items };
  }

  /**
   * Batch ancestor-titles helper (#443): ONE recursive CTE seeded with ALL hit
   * ids, walking UP parentPageId. Returns a map hitId → ancestor titles ordered
   * root → direct parent (the hit's own title is excluded). Root pages map to
   * an empty array. Avoids the N+1 of a per-page breadcrumb call.
   */
  private async buildAncestorPaths(
    hitIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (hitIds.length === 0) return result;

    // ancestry(hit_id, page_id, title, parent_page_id, depth): seed one row per
    // hit at depth 0 (the hit itself), then walk to parents (increasing depth).
    const rows = await this.db
      .withRecursive('ancestry', (db) =>
        db
          .selectFrom('pages')
          .select([
            'pages.id as hitId',
            'pages.id as pageId',
            'pages.title as title',
            'pages.parentPageId as parentPageId',
            sql<number>`0`.as('depth'),
          ])
          .where('pages.id', 'in', hitIds)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .innerJoin('ancestry as a', 'p.id', 'a.parentPageId')
              .select([
                'a.hitId as hitId',
                'p.id as pageId',
                'p.title as title',
                'p.parentPageId as parentPageId',
                sql<number>`a.depth + 1`.as('depth'),
              ]),
          ),
      )
      .selectFrom('ancestry')
      .select(['hitId', 'title', 'depth'])
      // depth 0 is the hit itself — excluded from the path.
      .where('depth', '>', 0)
      .orderBy('hitId')
      // Larger depth = closer to the space root. Ordering DESC gives
      // root → parent once collected.
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

      // Template picker: restrict to pages flagged as templates.
      if (suggestion.onlyTemplates) {
        pageSearch = pageSearch.where('isTemplate', '=', true);
      }

      // search all spaces the user has access to, prioritizing the current space
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

      // Filter by page-level permissions
      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
            // #348 — workspace-level short-circuit for the suggest path.
            workspaceId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
