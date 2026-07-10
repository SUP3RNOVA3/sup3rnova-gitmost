import { type Kysely, sql } from 'kysely';

/**
 * #443 — trigram indexes for the opt-in agent-lookup search mode.
 *
 * The lookup mode adds a substring branch that runs leading-wildcard
 * `LOWER(f_unaccent(col)) LIKE '%q%'` predicates on pages.title and
 * pages.text_content. A leading wildcard cannot use a b-tree index, so without a
 * GIN trigram index each such predicate is a sequential scan.
 *
 *  - TITLE: the lookup-mode title predicate is `LOWER(f_unaccent(title)) LIKE
 *    '%q%'` (coalesce-free, so it can use a functional index), which is IDENTICAL
 *    to the one added for /search/suggest (#348). #348's perf-indexes migration
 *    already created `idx_pages_title_trgm` on `(LOWER(f_unaccent(title)))
 *    gin_trgm_ops`, so the title predicate is already covered — we do NOT
 *    re-create that index here (it would be redundant).
 *
 *  - TEXT_CONTENT: NEW. The substring branch scans text_content when the query
 *    is not titleOnly. text_content is the large column, so a GIN trigram index
 *    on it is the meaningful acceleration for the lookup mode. The lookup search
 *    is ALWAYS space-scoped (spaceId or the user's member spaces), so on small
 *    instances a per-space sequential scan is tolerable — but the index turns the
 *    `%q%` text predicate into a Bitmap Index Scan and removes the only
 *    unbounded-per-space cost of the feature. We add it. The trade-off is disk +
 *    write amplification on page edits (GIN trigram indexes are larger and slower
 *    to update than b-trees); on the small instances this fork targets that cost
 *    is acceptable and the read win on agent lookups is the priority.
 *
 * DEPLOY-TIME LOCK WARNING: plain (non-CONCURRENT) CREATE INDEX — Kysely runs
 * each migration in a transaction, so CONCURRENTLY is impossible. The build takes
 * a SHARE lock that BLOCKS writes on `pages` for its duration. The text_content
 * GIN build is the slow one and can take minutes on a large tenant. For large
 * installations, run this in a maintenance window or build the index out-of-band
 * with CREATE INDEX CONCURRENTLY before deploying (then `IF NOT EXISTS` no-ops
 * here). Small/typical tenants are unaffected.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // The title predicate is served by #348's idx_pages_title_trgm — see header.
  // Only the text_content index is introduced here.

  // text_content trigram index. Its expression is coalesce-free —
  // `LOWER(f_unaccent(text_content))` — to EXACTLY match the coalesce-free
  // lookup-mode text substring predicate in search.service.ts, so Postgres can
  // use it (a `coalesce(...)` mismatch would silently fall back to a Seq Scan).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_text_content_trgm
      ON pages USING gin ((LOWER(f_unaccent(text_content))) gin_trgm_ops)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Only drop the index this migration introduced. idx_pages_title_trgm is owned
  // by the #348 perf-indexes migration, so leave it for that migration's down().
  await sql`DROP INDEX IF EXISTS idx_pages_text_content_trgm`.execute(db);
}
