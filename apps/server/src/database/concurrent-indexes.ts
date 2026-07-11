import { Kysely, sql } from 'kysely';

/**
 * Indexes that MUST be built with `CREATE INDEX CONCURRENTLY` so an auto-deploy
 * migration never takes a `SHARE` lock that blocks writes on a hot table
 * (`pages`) for the — potentially minutes-long — GIN trigram build (#495 item 12).
 *
 * Kysely runs each migration INSIDE a transaction (Postgres has transactional
 * DDL), and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so
 * these cannot live in an ordinary migration. Instead {@link ensureConcurrentIndexes}
 * builds them out-of-band (no transaction) BEFORE the migrator runs; the matching
 * migrations keep a plain `CREATE INDEX IF NOT EXISTS` as a backstop, which then
 * no-ops because the index already exists. So:
 *   - existing prod DB, incremental deploy: pre-build runs CONCURRENTLY (no write
 *     lock), migration's IF NOT EXISTS no-ops → the write-blocking build is gone;
 *   - fresh DB (or a DB that has not yet created `pages` / `f_unaccent`): the
 *     pre-build fails and is swallowed (best-effort), and the migration builds the
 *     index normally on an empty/small table where the lock is irrelevant.
 * Worst case therefore equals the previous behaviour; best case removes the lock.
 *
 * The `create` text is the CANONICAL definition — it MUST match the migration's
 * `IF NOT EXISTS` create expression exactly (same functional expression + opclass)
 * or Postgres would treat them as two different indexes.
 */
export const CONCURRENT_INDEXES: ReadonlyArray<{
  name: string;
  create: string;
}> = [
  {
    // #348 perf-indexes — pages.title trigram (coalesce-free functional expr).
    name: 'idx_pages_title_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_title_trgm ' +
      'ON pages USING gin ((LOWER(f_unaccent(title))) gin_trgm_ops)',
  },
  {
    // #348 perf-indexes — users.name trigram (member search-suggest).
    name: 'idx_users_name_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_trgm ' +
      'ON users USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)',
  },
  {
    // #443 search-lookup-trgm — pages.text_content trigram (the slow, large one).
    name: 'idx_pages_text_content_trgm',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_text_content_trgm ' +
      'ON pages USING gin ((LOWER(f_unaccent(text_content))) gin_trgm_ops)',
  },
];

/**
 * Best-effort, non-transactional pre-build of {@link CONCURRENT_INDEXES}. Run
 * BEFORE the migrator so the blocking `CREATE INDEX` in the corresponding
 * migration becomes an `IF NOT EXISTS` no-op.
 *
 * `db` MUST be the top-level Kysely instance (NOT a transaction): each statement
 * then executes on its own connection with no surrounding `BEGIN`, which is
 * required for `CONCURRENTLY`. Every statement is independent and swallowed on
 * error (a missing `pages`/`f_unaccent` on a fresh DB, an unsupported driver
 * path, a permissions gap): the migration backstop still builds the index, so a
 * failure here is never fatal. `onLog` reports progress/failures for the caller
 * to route to its logger.
 */
export async function ensureConcurrentIndexes(
  db: Kysely<any>,
  onLog?: (message: string, error?: unknown) => void,
): Promise<void> {
  for (const idx of CONCURRENT_INDEXES) {
    try {
      await sql.raw(idx.create).execute(db);
      onLog?.(`Concurrent index ensured: ${idx.name}`);
    } catch (error) {
      // Non-fatal by design — the migration's IF NOT EXISTS create is the
      // backstop. Common benign cause: the table/function does not exist yet on
      // a fresh DB (the migrations will build the index instead).
      onLog?.(
        `Concurrent index pre-build skipped for ${idx.name} ` +
          `(will fall back to the in-migration build)`,
        error,
      );
    }
  }
}
