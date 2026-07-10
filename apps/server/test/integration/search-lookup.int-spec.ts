import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { SearchService } from 'src/core/search/search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
} from './db';

/**
 * #443 — agent-lookup search mode, acceptance on the REAL DB schema.
 *
 * Exercises SearchService.searchPage(..., { substring: true }) against a
 * migrated Postgres: substring matching of technical tokens the FTS tokenizer
 * mangles (backup-srv.local, 10.0.12.5, WB-MGE-30D86B, "Теги: Docker"), the
 * populated path + snippet, parentPageId subtree scoping, titleOnly, the empty
 * result, LIKE-metacharacter escaping (`%`/`_` must NOT match everything), the
 * permission post-filter applied BEFORE the limit, and the web-UI path staying
 * on the legacy FTS shape when `substring` is absent.
 *
 * The tsv column is populated by the pages_tsvector_trigger on insert, so the
 * FTS branch is exercised too.
 */
describe('SearchService agent-lookup mode [integration]', () => {
  let db: Kysely<any>;
  let service: SearchService;
  let workspaceId: string;
  let spaceId: string;

  // Direct page insert (the shared createPage seeder omits text_content /
  // parent_page_id, both of which this mode depends on). Returns the id.
  async function insertPage(args: {
    title: string;
    textContent?: string;
    parentPageId?: string | null;
    spaceId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: `slug-${id.slice(0, 12)}`,
        title: args.title,
        textContent: args.textContent ?? null,
        parentPageId: args.parentPageId ?? null,
        spaceId: args.spaceId ?? spaceId,
        workspaceId,
      })
      .execute();
    return id;
  }

  // Build a SearchService wired to the real DB + a real PageRepo (only its
  // recursive-descendants method is used by this mode, and it needs only `db`),
  // with lightweight stubs for the space-membership and permission repos so a
  // test can drive scope + the permission post-filter explicitly.
  function buildService(opts?: {
    userSpaceIds?: string[];
    // ids to KEEP after the permission post-filter; undefined = keep all.
    accessibleIds?: string[];
  }): SearchService {
    const pageRepo = new PageRepo(db as any, null as any, null as any);
    const spaceMemberRepo = {
      getUserSpaceIds: async () => opts?.userSpaceIds ?? [spaceId],
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) =>
        opts?.accessibleIds
          ? pageIds.filter((id) => opts.accessibleIds!.includes(id))
          : pageIds,
    };
    return new SearchService(
      db as any,
      pageRepo as any,
      {} as any, // shareRepo — unused by the lookup path
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );
  }

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
    service = buildService();
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('finds `backup-srv.local` by the fragment `srv.local`', async () => {
    const pageId = await insertPage({
      title: 'backup-srv.local',
      textContent: 'A backup server node.',
    });

    const { items } = (await service.searchPage(
      { query: 'srv.local', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;

    expect(items.map((i: any) => i.id)).toContain(pageId);
    const hit = items.find((i: any) => i.id === pageId);
    expect(hit.title).toBe('backup-srv.local');
    // slugId must never be part of the server response shape.
    expect('slugId' in hit).toBe(true); // server carries it; MCP strips it
  });

  it('finds a page whose TEXT contains `10.0.12.5` by the fragment `10.0.12` (empty-tsquery case)', async () => {
    const pageId = await insertPage({
      title: 'Server inventory',
      textContent: 'The backup box lives at IP: 10.0.12.5. Debian 12, backups.',
    });

    const { items } = (await service.searchPage(
      { query: '10.0.12', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;

    const hit = items.find((i: any) => i.id === pageId);
    expect(hit).toBeDefined();
    // The windowed snippet must include the matched text.
    expect(hit.snippet).toContain('10.0.12.5');
  });

  it('finds `WB-MGE-30D86B` (alphanumeric token with dashes) by title', async () => {
    const pageId = await insertPage({
      title: 'WB-MGE-30D86B',
      textContent: 'Device page.',
    });

    const { items } = (await service.searchPage(
      { query: 'WB-MGE-30D86B', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;

    const hit = items.find((i: any) => i.id === pageId);
    expect(hit).toBeDefined();
    // Exact title match → top tier (TITLE_EXACT=3) → score in [0.75, 1].
    expect(hit.score).toBeGreaterThanOrEqual(0.75);
    // And it is the top-ranked hit of its own result set.
    expect(items[0].id).toBe(pageId);
  });

  it('finds every page whose text literally contains `Теги: Docker`', async () => {
    const a = await insertPage({
      title: 'Container host A',
      textContent: 'Some notes.\nТеги: Docker, compose\nmore.',
    });
    const b = await insertPage({
      title: 'Container host B',
      textContent: 'Prelude.\nТеги: Docker\nepilogue.',
    });
    const noise = await insertPage({
      title: 'Unrelated',
      textContent: 'Теги: Kubernetes',
    });

    const { items } = (await service.searchPage(
      { query: 'Теги: Docker', spaceId, substring: true, limit: 50 } as any,
      { workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).not.toContain(noise);
  });

  it('populates a non-empty `path` for a nested hit and `[]` for a root hit', async () => {
    const root = await insertPage({ title: 'Infrastructure' });
    const mid = await insertPage({ title: 'Datacenter A', parentPageId: root });
    const leaf = await insertPage({
      title: 'unique-nested-host',
      parentPageId: mid,
    });

    const { items } = (await service.searchPage(
      { query: 'unique-nested-host', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;

    const hit = items.find((i: any) => i.id === leaf);
    expect(hit.path).toEqual(['Infrastructure', 'Datacenter A']);

    const rootHits = (await service.searchPage(
      { query: 'Infrastructure', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;
    const rootHit = rootHits.items.find((i: any) => i.id === root);
    expect(rootHit.path).toEqual([]);
  });

  it('scopes to a subtree with parentPageId (cutting off sibling branches)', async () => {
    const branchA = await insertPage({ title: 'BranchA-root' });
    const inA = await insertPage({
      title: 'scoped-target-xyz',
      parentPageId: branchA,
    });
    const branchB = await insertPage({ title: 'BranchB-root' });
    const inB = await insertPage({
      title: 'scoped-target-xyz',
      parentPageId: branchB,
    });

    const { items } = (await service.searchPage(
      {
        query: 'scoped-target-xyz',
        spaceId,
        substring: true,
        parentPageId: branchA,
      } as any,
      { workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    expect(ids).toContain(inA);
    expect(ids).not.toContain(inB);
  });

  it('includes the parent page itself in the parentPageId subtree', async () => {
    const parent = await insertPage({ title: 'self-included-parent' });
    await insertPage({ title: 'child-of-self', parentPageId: parent });

    const { items } = (await service.searchPage(
      {
        query: 'self-included-parent',
        spaceId,
        substring: true,
        parentPageId: parent,
      } as any,
      { workspaceId },
    )) as any;

    expect(items.map((i: any) => i.id)).toContain(parent);
  });

  it('titleOnly does NOT match on text_content', async () => {
    const pageId = await insertPage({
      title: 'Plain title',
      textContent: 'body mentions the-secret-token here',
    });

    const withText = (await service.searchPage(
      { query: 'the-secret-token', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;
    expect(withText.items.map((i: any) => i.id)).toContain(pageId);

    const titleOnly = (await service.searchPage(
      {
        query: 'the-secret-token',
        spaceId,
        substring: true,
        titleOnly: true,
      } as any,
      { workspaceId },
    )) as any;
    expect(titleOnly.items.map((i: any) => i.id)).not.toContain(pageId);
  });

  // #443 Fix #1 regression: f_unaccent is NOT length-preserving, so an
  // expanding char (ß→ss, …→...) BEFORE the match shifted the strpos position
  // relative to the ORIGINAL text and the snippet slice ran past end → empty.
  // The position and the slice now share the LOWER(f_unaccent(...)) space, so
  // the window is aligned and always contains the matched (unaccented) token.
  it('returns a populated snippet when an unaccent-EXPANDING char precedes the match', async () => {
    // 300 × `ß` (each f_unaccent-expands to `ss`) before the needle. Under the
    // old code strpos returned a position ~593 in the expanded space but the
    // slice ran over the ORIGINAL (~360 char) text → empty snippet, match lost.
    const prefix = 'ß'.repeat(300);
    const pageId = await insertPage({
      title: 'Expanding-unaccent page',
      textContent: `${prefix} needle-token-xyz trailing.`,
    });

    const { items } = (await service.searchPage(
      { query: 'needle-token-xyz', spaceId, substring: true } as any,
      { workspaceId },
    )) as any;

    const hit = items.find((i: any) => i.id === pageId);
    expect(hit).toBeDefined();
    // Snippet must be non-empty AND contain the matched token (unaccented form).
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(hit.snippet).toContain('needle-token-xyz');
  });

  // #443 Fix #2 regression: >200 matching pages for a broad substring, with
  // exactly ONE exact-title hit. Without an ORDER BY on the 200-cap the exact
  // hit could be among the arbitrarily-dropped rows; the ORDER BY keeps the
  // strongest candidates so it must survive the cap and rank at the top.
  it('keeps an exact-title hit through the 200-cap on a >200-row match set', async () => {
    const isoSpace = (await createSpace(db, workspaceId)).id;
    const svc = buildService({ userSpaceIds: [isoSpace] });

    // 250 low-tier TEXT hits: the shared substring `capword` appears only in the
    // body, never the title, so each is a TEXT-tier match (weakest tier).
    for (let i = 0; i < 250; i++) {
      await insertPage({
        title: `filler-page-${i}`,
        textContent: `body contains capword here #${i}`,
        spaceId: isoSpace,
      });
    }
    // Exactly one EXACT-title hit for the same query token.
    const exact = await insertPage({
      title: 'capword',
      textContent: 'unrelated body text',
      spaceId: isoSpace,
    });

    const { items } = (await svc.searchPage(
      { query: 'capword', spaceId: isoSpace, substring: true, limit: 10 } as any,
      { workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    // The exact-title hit must survive the 200-cap and appear in the top `limit`.
    expect(ids).toContain(exact);
    // And, being TITLE_EXACT, it must be the single strongest hit.
    expect(items[0].id).toBe(exact);
  });

  // #443 Fix #3: titleOnly matches only the title, so it must not leak the page
  // body as the snippet (the old "first 300 chars of text_content" fallback).
  it('titleOnly does NOT return a text-body snippet', async () => {
    const pageId = await insertPage({
      title: 'titleonly-snippet-page',
      textContent: 'SECRET-BODY-CONTENT-NOT-IN-TITLE that must not leak.',
    });

    const { items } = (await service.searchPage(
      {
        query: 'titleonly-snippet-page',
        spaceId,
        substring: true,
        titleOnly: true,
      } as any,
      { workspaceId },
    )) as any;

    const hit = items.find((i: any) => i.id === pageId);
    expect(hit).toBeDefined();
    // The body text must not appear in the snippet; titleOnly → empty snippet.
    expect(hit.snippet).not.toContain('SECRET-BODY-CONTENT-NOT-IN-TITLE');
    expect(hit.snippet).toBe('');
  });

  it('returns [] (not an error) for a query that matches nothing', async () => {
    const { items } = (await service.searchPage(
      {
        query: 'zzz-no-such-string-anywhere-42',
        spaceId,
        substring: true,
      } as any,
      { workspaceId },
    )) as any;
    expect(items).toEqual([]);
  });

  it('a `%` query does NOT match everything (LIKE metacharacter escaped)', async () => {
    // Fresh space so we can assert on total counts without cross-test noise.
    const isoSpace = (await createSpace(db, workspaceId)).id;
    const svc = buildService({ userSpaceIds: [isoSpace] });
    await insertPage({ title: 'alpha', spaceId: isoSpace });
    await insertPage({ title: 'beta', spaceId: isoSpace });
    const literal = await insertPage({
      title: '100%-coverage',
      spaceId: isoSpace,
    });

    const { items } = (await svc.searchPage(
      { query: '%', spaceId: isoSpace, substring: true, limit: 50 } as any,
      { workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    // `%` is a literal → matches only the page that actually contains '%'.
    expect(ids).toContain(literal);
    expect(ids).not.toContain(
      items.find((i: any) => i.title === 'alpha')?.id,
    );
    expect(items.length).toBe(1);
  });

  it('an `_` query does NOT match everything (LIKE metacharacter escaped)', async () => {
    const isoSpace = (await createSpace(db, workspaceId)).id;
    const svc = buildService({ userSpaceIds: [isoSpace] });
    await insertPage({ title: 'gamma', spaceId: isoSpace });
    const literal = await insertPage({
      title: 'snake_case_name',
      spaceId: isoSpace,
    });

    const { items } = (await svc.searchPage(
      { query: '_', spaceId: isoSpace, substring: true, limit: 50 } as any,
      { workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    expect(ids).toContain(literal);
    expect(items.length).toBe(1);
  });

  it('applies the permission post-filter to the MERGED set BEFORE the limit', async () => {
    const isoSpace = (await createSpace(db, workspaceId)).id;
    const keep = await insertPage({
      title: 'perm-visible-target',
      spaceId: isoSpace,
    });
    const hidden = await insertPage({
      title: 'perm-hidden-target',
      spaceId: isoSpace,
    });

    // Authenticated (userId set) so the permission filter runs; only `keep` is
    // accessible. limit 1 must NOT be able to select `hidden`.
    const svc = buildService({
      userSpaceIds: [isoSpace],
      accessibleIds: [keep],
    });
    const { items } = (await svc.searchPage(
      {
        query: 'perm-',
        spaceId: isoSpace,
        substring: true,
        limit: 1,
      } as any,
      { userId: 'user-1', workspaceId },
    )) as any;

    const ids = items.map((i: any) => i.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(hidden);
  });

  it('web-UI path (no `substring` flag) keeps the legacy FTS response shape', async () => {
    await insertPage({
      title: 'legacy shape page',
      textContent: 'searchable legacyword content',
    });

    const { items } = (await service.searchPage(
      { query: 'legacyword', spaceId } as any,
      { userId: 'user-1', workspaceId },
    )) as any;

    // Legacy hits carry rank + highlight + space, and NO path/snippet/score.
    const hit = items[0];
    expect(hit).toBeDefined();
    expect('rank' in hit).toBe(true);
    expect('highlight' in hit).toBe(true);
    expect('path' in hit).toBe(false);
    expect('snippet' in hit).toBe(false);
    expect('score' in hit).toBe(false);
  });
});
