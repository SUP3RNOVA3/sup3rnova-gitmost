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
