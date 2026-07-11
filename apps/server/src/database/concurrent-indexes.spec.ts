import * as path from 'path';
import { readFileSync } from 'fs';

// Mock ONLY kysely's `sql.raw(...).execute()` so we can observe what
// ensureConcurrentIndexes runs and how it handles failures, without a DB.
const execMock = jest.fn((_db: unknown) => Promise.resolve(undefined));
const rawMock = jest.fn((_stmt: string) => ({ execute: execMock }));
jest.mock('kysely', () => {
  const actual = jest.requireActual('kysely');
  return { ...actual, sql: { ...actual.sql, raw: rawMock } };
});

import { CONCURRENT_INDEXES, ensureConcurrentIndexes } from './concurrent-indexes';

describe('ensureConcurrentIndexes', () => {
  const fakeDb = { __topLevelKysely: true } as never;

  beforeEach(() => {
    execMock.mockReset().mockResolvedValue(undefined);
    rawMock.mockClear();
  });

  it('runs every registered index CONCURRENTLY, IF NOT EXISTS, outside a transaction', async () => {
    const onLog = jest.fn();
    await ensureConcurrentIndexes(fakeDb, onLog);

    expect(rawMock).toHaveBeenCalledTimes(CONCURRENT_INDEXES.length);
    for (const call of rawMock.mock.calls) {
      const stmt = call[0] as string;
      expect(stmt).toContain('CREATE INDEX CONCURRENTLY');
      expect(stmt).toContain('IF NOT EXISTS');
    }
    // Executed against the top-level db (a transaction would forbid CONCURRENTLY).
    for (const call of execMock.mock.calls) {
      expect(call[0]).toBe(fakeDb);
    }
    expect(onLog).toHaveBeenCalledTimes(CONCURRENT_INDEXES.length);
  });

  it('is best-effort: a failing index does not abort the rest and is reported', async () => {
    // Fail the FIRST index; the remaining ones must still be attempted.
    execMock
      .mockRejectedValueOnce(new Error('relation "pages" does not exist'))
      .mockResolvedValue(undefined);
    const onLog = jest.fn();

    await expect(
      ensureConcurrentIndexes(fakeDb, onLog),
    ).resolves.toBeUndefined();

    expect(execMock).toHaveBeenCalledTimes(CONCURRENT_INDEXES.length);
    // The failure surfaced with an error argument for the caller to log.
    const errored = onLog.mock.calls.filter((c) => c[1] !== undefined);
    expect(errored).toHaveLength(1);
    expect(String(errored[0][1])).toContain('does not exist');
  });
});

// DRIFT GUARD: each CONCURRENT_INDEXES entry pre-builds an index that a plain
// migration ALSO creates with `IF NOT EXISTS`. If the two expressions diverge,
// Postgres would treat them as different indexes and the pre-build would NOT
// make the migration a no-op. Assert the migration files still contain each
// index's functional expression.
describe('CONCURRENT_INDEXES parity with the migrations', () => {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = [
    '20260705T120000-perf-indexes.ts',
    '20260706T120000-search-lookup-trgm.ts',
  ].map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'));
  const allMigrationSrc = files.join('\n');

  it.each(CONCURRENT_INDEXES.map((i) => [i.name, i]))(
    'migration source still creates %s with the same expression',
    (_name, idx) => {
      // Extract the `USING gin ((...expr...) gin_trgm_ops)` tail from the
      // canonical create and assert the migration source contains it verbatim.
      const m = (idx as { create: string }).create.match(
        /ON \w+ (USING gin .+)$/,
      );
      expect(m).not.toBeNull();
      const expr = (m as RegExpMatchArray)[1];
      expect(allMigrationSrc).toContain(expr);
      // And the migration must build it by the SAME index name.
      expect(allMigrationSrc).toContain(
        `CREATE INDEX IF NOT EXISTS ${(idx as { name: string }).name}`,
      );
    },
  );
});
