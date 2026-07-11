import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import { SearchService } from 'src/core/search/search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
} from './db';

/**
 * #529 Phase A — the lexical overhaul, on the REAL migrated schema (ru_en config).
 *
 * Covers every acceptance criterion of the issue: RU+EN morphology + OR default,
 * match=auto identifier routing, "phrase"/+/- operators, RRF ordering, exact
 * permission-filtered total (fail-closed) + pagination, only-negation / garbage
 * short-circuits, the A8 path fix, the response superset, and the RAG lockstep
 * config (acceptance #13).
 *
 * The tsv column is populated by the pages_tsvector_trigger (now ru_en), so the
 * FTS branch is exercised end to end.
 */
describe('SearchService #529 lexical overhaul [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  async function insertPage(args: {
    title: string;
    textContent?: string;
    parentPageId?: string | null;
    spaceId?: string;
    deletedAt?: Date | null;
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
        deletedAt: args.deletedAt ?? null,
      })
      .execute();
    return id;
  }

  // Service wired to the real DB + real PageRepo (recursive descendants) with
  // stubbed space-membership + permission repos so a test controls scope and the
  // permission filter explicitly. `accessibleIds` (when set) is the KEEP list.
  function buildService(opts?: {
    userSpaceIds?: string[];
    accessibleIds?: string[] | null;
    filterThrows?: boolean;
  }): SearchService {
    const pageRepo = new PageRepo(db as any, null as any, null as any);
    const spaceMemberRepo = {
      getUserSpaceIds: async () => opts?.userSpaceIds ?? [spaceId],
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: async () => false,
      filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => {
        if (opts?.filterThrows) throw new Error('permission query failed');
        return opts?.accessibleIds
          ? pageIds.filter((id) => opts.accessibleIds!.includes(id))
          : pageIds;
      },
    };
    return new SearchService(
      db as any,
      pageRepo as any,
      {} as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );
  }

  const search = (service: SearchService, params: any) =>
    service.searchPage(params, { userId: 'u-1', workspaceId }) as any;

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // 1. RU morphology + OR: «ресторанов москвы» finds «ресторан в москве».
  it('#1 russian morphology + OR: finds «ресторан в москве» for «ресторанов москвы»', async () => {
    const page = await insertPage({
      title: 'ресторан в москве',
      textContent: 'Лучший ресторан столицы.',
    });
    const res = await search(buildService(), {
      query: 'ресторанов москвы',
      spaceId,
    });
    expect(res.items.map((i: any) => i.id)).toContain(page);
    expect(res.total).toBeGreaterThanOrEqual(1);
  });

  // 2. OR non-empty: «Стамбул Роснефть».
  it('#2 OR yields a hit when only one term matches', async () => {
    const page = await insertPage({ title: 'Роснефть отчёт', textContent: 'x' });
    const res = await search(buildService(), {
      query: 'Стамбул Роснефть',
      spaceId,
    });
    expect(res.items.map((i: any) => i.id)).toContain(page);
  });

  // 3. Multi-word OR: a page matching >=1 term is returned.
  it('#3 «3D принтер» returns pages that matched at least one term', async () => {
    const models = await insertPage({
      title: 'Модели для печати 3D',
      textContent: 'коллекция моделей',
    });
    const wish = await insertPage({
      title: 'Хотеть напечатать на принтере',
      textContent: 'очередь печати',
    });
    const res = await search(buildService(), { query: '3D принтер', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(models); // matched "3D"
    expect(ids).toContain(wish); // matched "принтер"
    // matchedTerms is populated per hit.
    const hit = res.items.find((i: any) => i.id === wish);
    expect(hit.matchedTerms).toContain('принтер');
  });

  // 4. match=auto FTS stemming: «печат» must NOT drag in «впечатления».
  it('#4 «печат» (auto) matches «печать» but NOT «впечатления»', async () => {
    const good = await insertPage({
      title: 'Печать документов',
      textContent: 'настройка печати',
    });
    const bad = await insertPage({
      title: 'Впечатления от поездки',
      textContent: 'много впечатлений',
    });
    const res = await search(buildService(), { query: 'печат', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(good);
    expect(ids).not.toContain(bad);
  });

  // 5. Identifier → substring branch.
  it('#5 `10.31.41` (auto→substring) finds the page with that IP', async () => {
    const page = await insertPage({
      title: 'Сетевой узел',
      textContent: 'Адрес устройства: 10.31.41.7 в сети.',
    });
    const res = await search(buildService(), { query: '10.31.41', spaceId });
    const hit = res.items.find((i: any) => i.id === page);
    expect(hit).toBeDefined();
    expect(hit.matchedFields).toContain('text');
  });

  // 6. +required / -excluded.
  it('#6 `+кофейня -архив`: keeps «кофейня», drops pages with «архив»', async () => {
    const keep = await insertPage({ title: 'Кофейня в центре', textContent: 'уют' });
    const drop = await insertPage({
      title: 'Кофейня старый архив',
      textContent: 'архивные записи',
    });
    const res = await search(buildService(), { query: '+кофейня -архив', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
  });

  // 7. Phrase operator: only adjacent phrase hits survive.
  it('#7 `+"воздушный шар" кофе`: every hit contains the adjacent phrase', async () => {
    const adjacent = await insertPage({
      title: 'Воздушный шар и кофе',
      textContent: 'воздушный шар над городом, чашка кофе',
    });
    const nonAdjacent = await insertPage({
      title: 'Красный воздушный большой шар',
      textContent: 'воздушный красный шар и кофе рядом',
    });
    const res = await search(buildService(), {
      query: '+"воздушный шар" кофе',
      spaceId,
    });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(adjacent);
    // The non-adjacent page (words separated) must NOT match the phrase.
    expect(ids).not.toContain(nonAdjacent);
  });

  // 8. Pagination determinism + exact total.
  it('#8 >50 matches: total>50, hasMore, and offset paginates without dupes', async () => {
    const svc = buildService();
    const created: string[] = [];
    for (let i = 0; i < 60; i++) {
      created.push(
        await insertPage({
          title: `паджинация запись ${i}`,
          textContent: 'общий паджинационный маркер',
        }),
      );
    }
    const p1 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 0,
    });
    expect(p1.total).toBeGreaterThanOrEqual(60);
    expect(p1.hasMore).toBe(true);
    const p2 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 25,
    });
    const p3 = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 50,
    });
    const ids = [
      ...p1.items.map((i: any) => i.id),
      ...p2.items.map((i: any) => i.id),
      ...p3.items.map((i: any) => i.id),
    ];
    // No duplicates across the three pages.
    expect(new Set(ids).size).toBe(ids.length);
    // Deterministic: same query twice → identical order.
    const p1b = await search(svc, {
      query: 'паджинационный',
      spaceId,
      limit: 25,
      offset: 0,
    });
    expect(p1b.items.map((i: any) => i.id)).toEqual(p1.items.map((i: any) => i.id));
  });

  // 9. Only-negation.
  it('#9 `-архив` only-negation: total 0, reason only-negation, no throw', async () => {
    const res = await search(buildService(), { query: '-архив', spaceId });
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.query.parsed.reason).toBe('only-negation');
  });

  // 10. Garbage input.
  it('#10 garbage `%` / `_` / empty: total 0, does not match everything', async () => {
    await insertPage({ title: 'какая-то страница', textContent: 'текст' });
    for (const q of ['%', '_', '   ', '%%__']) {
      const res = await search(buildService(), { query: q, spaceId });
      expect(res.total).toBe(0);
      expect(res.items).toEqual([]);
    }
  });

  // 11. Permission-filtered total (fail-closed) + mutation guard.
  it('#11 a permission-hidden page is absent from items AND total', async () => {
    const visible = await insertPage({
      title: 'разрешённая пермишен-страница',
      textContent: 'пермишенмаркер',
    });
    const hidden = await insertPage({
      title: 'скрытая пермишен-страница',
      textContent: 'пермишенмаркер',
    });
    // Filter keeps only the visible page.
    const filtered = buildService({ accessibleIds: [visible] });
    const res = await search(filtered, { query: 'пермишенмаркер', spaceId });
    const ids = res.items.map((i: any) => i.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(hidden);
    // total is the POST-permission count — the hidden page does not leak into it.
    expect(res.total).toBe(1);

    // MUTATION: disable the guard (passthrough) → the hidden page reappears in
    // BOTH items and total. If this did NOT change, the guard is not load-bearing.
    const open = buildService({ accessibleIds: null });
    const res2 = await search(open, { query: 'пермишенмаркер', spaceId });
    expect(res2.items.map((i: any) => i.id)).toContain(hidden);
    expect(res2.total).toBe(2);
  });

  it('#11b a permission-query error PROPAGATES (fail-closed, never empty)', async () => {
    await insertPage({ title: 'failclosed маркер', textContent: 'failclosedmarker' });
    const svc = buildService({ filterThrows: true });
    await expect(
      search(svc, { query: 'failclosedmarker', spaceId }),
    ).rejects.toThrow(/permission query failed/);
  });

  // A8 path fix.
  it('#11c path: a soft-deleted / cross-space ancestor title does not leak', async () => {
    const otherSpace = (await createSpace(db, workspaceId)).id;
    const root = await insertPage({ title: 'Живой корень' });
    const deletedMid = await insertPage({
      title: 'УдалённыйПредок',
      parentPageId: root,
      deletedAt: new Date(),
    });
    const leaf = await insertPage({
      title: 'a8leaf уникальный',
      parentPageId: deletedMid,
      textContent: 'a8leafmarker',
    });
    const res = await search(buildService(), { query: 'a8leafmarker', spaceId });
    const hit = res.items.find((i: any) => i.id === leaf);
    expect(hit).toBeDefined();
    // The walk stops at the deleted ancestor — no deleted title in the path.
    expect(hit.path).not.toContain('УдалённыйПредок');
    expect(hit.path).not.toContain('Живой корень');

    // Cross-space parent must also not leak.
    const foreignParent = await insertPage({
      title: 'ЧужойСпейс',
      spaceId: otherSpace,
    });
    const crossLeaf = await insertPage({
      title: 'crossleaf узел',
      parentPageId: foreignParent,
      textContent: 'crossleafmarker',
    });
    const res2 = await search(buildService(), {
      query: 'crossleafmarker',
      spaceId,
    });
    const hit2 = res2.items.find((i: any) => i.id === crossLeaf);
    expect(hit2).toBeDefined();
    expect(hit2.path).not.toContain('ЧужойСпейс');
  });

  // 12. Web-UI superset.
  it('#12 web path (no flags) returns the OR result with the icon/space/highlight superset', async () => {
    const page = await insertPage({
      title: 'веб суперсет страница',
      textContent: 'суперсетмаркер контент',
    });
    const res = await search(buildService(), { query: 'суперсетмаркер', spaceId });
    const hit = res.items.find((i: any) => i.id === page);
    expect(hit).toBeDefined();
    // Superset fields the web-UI relies on.
    expect('icon' in hit).toBe(true);
    expect('space' in hit).toBe(true);
    expect('highlight' in hit).toBe(true);
    expect('rank' in hit).toBe(true);
    // Plus the new fields.
    expect('path' in hit).toBe(true);
    expect('snippet' in hit).toBe(true);
    expect('score' in hit).toBe(true);
    // FTS hit carries a non-null rank + highlight.
    expect(hit.rank).not.toBeNull();
  });

  // 13. RAG lockstep: the page_embeddings.fts generated column is ru_en.
  it('#13 page_embeddings.fts uses ru_en (cyrillic stemming) — RAG lockstep', async () => {
    const pageId = await insertPage({
      title: 'rag страница',
      textContent: 'ресторанов много',
    });
    // Insert a chunk row; the generated fts column is computed by Postgres.
    await sql`
      INSERT INTO page_embeddings
        (id, page_id, workspace_id, space_id, attachment_id, chunk_index,
         chunk_start, chunk_length, content, model_name, model_dimensions, embedding)
      VALUES
        (${randomUUID()}, ${pageId}, ${workspaceId}, ${spaceId}, NULL, 0,
         0, 20, ${'ресторанов москвы много'}, 'test-model', 3, '[0.1,0.2,0.3]'::vector)
    `.execute(db);
    // A ru_en query stems «москва» → «москв», matching the stored «москвы».
    // Under the old `english` config the cyrillic word would not stem and this
    // inflected-form query would miss — so this asserts the ru_en lockstep.
    const row = await sql<{ m: boolean }>`
      SELECT fts @@ to_tsquery('ru_en', f_unaccent('москва')) AS m
      FROM page_embeddings WHERE page_id = ${pageId}
    `.execute(db);
    expect(row.rows[0].m).toBe(true);
  });
});
