import { PageEmbeddingRepo } from './page-embedding.repo';
import type { KyselyDB } from '../../types/kysely.types';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

/**
 * Unit test for the pure access-scoping branch of searchByEmbedding: when the
 * caller has NO accessible spaces (`spaceIds` empty), the method must early-
 * return [] WITHOUT touching the database. We inject a db whose query builder
 * throws if invoked, so any DB access fails the test.
 *
 * NOTE: the dimension-mixing case (filter by model_dimensions) needs a live
 * pgvector-enabled Postgres and is intentionally NOT covered here — it requires
 * a real DB and is out of scope for this pure unit test.
 */
describe('PageEmbeddingRepo.searchByEmbedding', () => {
  it('early-returns [] for empty spaceIds without any DB call', async () => {
    const throwingDb = {
      selectFrom: () => {
        throw new Error('DB should not be queried for empty spaceIds');
      },
    } as unknown as KyselyDB;

    const repo = new PageEmbeddingRepo(throwingDb);
    const result = await repo.searchByEmbedding('ws-1', [0.1, 0.2, 0.3], [], 10);
    expect(result).toEqual([]);
  });
});

/**
 * Recording Kysely (DummyDriver wired to the Postgres query compiler): compiles
 * queries to SQL + bound parameters without a live database, so we can assert the
 * shape of the raw-SQL `hybridSearch` emits. Mirrors the pattern used by
 * page.repo.embeddable.spec.ts.
 */
function makeRecordingDb() {
  const compiled: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new (class extends DummyDriver {
          async acquireConnection() {
            return {
              executeQuery: async (q: {
                sql: string;
                parameters: readonly unknown[];
              }) => {
                compiled.push({ sql: q.sql, parameters: q.parameters });
                return { rows: [] };
              },
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              streamQuery: async function* () {},
            } as any;
          }
        })(),
      createIntrospector: (d: Kysely<any>) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, compiled };
}

/**
 * #571 regression guard: the RAG hybrid retrieval MUST filter the semantic
 * (vector) arm by the ACTIVE embedding fingerprint AND model_dimensions, exactly
 * like the search subsystem's `vectorCandidateArm`. Without the fingerprint
 * predicate, a cross-provider embedding transition (same dimension, different
 * generation, no reindex) would silently fuse the query against STALE rows and
 * degrade cosine quality. This asserts the compiled SQL of the semantic CTE
 * carries `pe.fingerprint = $N` and that the active fingerprint is bound as a
 * parameter — deleting the filter reddens the test (non-vacuous).
 */
describe('PageEmbeddingRepo.hybridSearch fingerprint filter (#571)', () => {
  it('emits the fingerprint + model_dimensions predicate on the semantic arm and binds the active fingerprint', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    const FP = 'fp-active-generation-abc';
    await repo.hybridSearch(
      'ws-1',
      [0.1, 0.2, 0.3],
      'query text',
      ['space-1', 'space-2'],
      50,
      FP,
    );

    expect(compiled).toHaveLength(1);
    const { sql, parameters } = compiled[0];

    // The semantic CTE must carry BOTH same-generation filters, mirroring
    // vectorCandidateArm. Whitespace is preserved verbatim from the raw template.
    expect(sql).toMatch(/pe\.fingerprint\s*=\s*\$\d+/);
    expect(sql).toMatch(/pe\.model_dimensions\s*=\s*\$\d+/);
    // The ACTIVE fingerprint must be bound as a parameter, so the read filters
    // against exactly the generation the query vector was produced for.
    expect(parameters).toContain(FP);
    // model_dimensions is filtered by the query vector's own dimension (3 here).
    expect(parameters).toContain(3);

    // The lexical (full-text) arm must NOT be fingerprint-scoped: the fts column
    // is generation-independent. Exactly ONE fingerprint predicate (semantic arm).
    const fpPredicates = sql.match(/fingerprint\s*=\s*\$\d+/g) ?? [];
    expect(fpPredicates).toHaveLength(1);
  });

  it('early-returns [] for empty spaceIds without compiling any query', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    const result = await repo.hybridSearch(
      'ws-1',
      [0.1, 0.2, 0.3],
      'query text',
      [],
      50,
      'fp-active-generation-abc',
    );

    expect(result).toEqual([]);
    expect(compiled).toHaveLength(0);
  });
});

/**
 * #599 — FINGERPRINT-SCOPED deleteByPage. The indexer's delete+insert replace must
 * only ever remove the generation it is REWRITING while a swap is in flight;
 * removing every row of the page would delete its ACTIVE-generation rows too and
 * drop the page out of semantic search for the whole reindex window (acceptance 3).
 * The PURGE paths (page deleted / emptied) keep the unscoped behaviour.
 */
describe('PageEmbeddingRepo.deleteByPage fingerprint scope (#599)', () => {
  it('adds a fingerprint IN (...) predicate when a scope is supplied', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteByPage('page-1', 'ws-1', undefined, ['fp-target']);

    expect(compiled).toHaveLength(1);
    const { sql, parameters } = compiled[0];
    // NOTE: the recording Kysely has no camelCase plugin, so identifiers compile
    // as the TS names ("pageEmbeddings"); the real app maps them to snake_case.
    expect(sql).toMatch(/delete from "pageEmbeddings"/i);
    expect(sql).toMatch(/"fingerprint" in \(\$\d+\)/i);
    expect(parameters).toContain('fp-target');
  });

  it('deletes EVERY row of the page when no scope is supplied (purge path)', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteByPage('page-1', 'ws-1');

    expect(compiled).toHaveLength(1);
    // No fingerprint predicate at all -> every generation of this page is purged.
    expect(compiled[0].sql).not.toMatch(/fingerprint/i);
  });
});

/**
 * #599 — the GENERATIONAL GC. `deleteOtherGenerations` must reclaim every row that
 * belongs to neither of the kept generations, INCLUDING legacy NULL-fingerprint
 * rows: `fingerprint NOT IN (...)` alone evaluates to NULL (not true) for them, so
 * they would survive forever without the explicit `IS NULL` arm.
 */
describe('PageEmbeddingRepo.deleteOtherGenerations (#599)', () => {
  it('deletes rows outside the kept generations AND the legacy NULL-fingerprint rows', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteOtherGenerations('ws-1', ['fp-active', 'fp-target']);

    expect(compiled).toHaveLength(1);
    const { sql, parameters } = compiled[0];
    expect(sql).toMatch(/delete from "pageEmbeddings"/i);
    expect(sql).toMatch(/"workspaceId" = \$\d+/i);
    // Both generations are kept...
    expect(sql).toMatch(/"fingerprint" not in \(\$\d+, \$\d+\)/i);
    // ...and NULL rows (a very old generation) are explicitly reclaimed.
    expect(sql).toMatch(/"fingerprint" is null/i);
    expect(parameters).toContain('fp-active');
    expect(parameters).toContain('fp-target');
  });

  it('with nothing to keep, every row of the workspace is a stale generation', async () => {
    const { db, compiled } = makeRecordingDb();
    const repo = new PageEmbeddingRepo(db as unknown as KyselyDB);

    await repo.deleteOtherGenerations('ws-1', []);

    expect(compiled).toHaveLength(1);
    expect(compiled[0].sql).toMatch(/delete from "pageEmbeddings"/i);
    // No generation is kept -> no NOT IN filter: every row is an old generation.
    expect(compiled[0].sql).not.toMatch(/not in/i);
  });
});
