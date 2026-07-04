import { type Kysely, sql } from 'kysely';

/**
 * #348 — targeted hot-path indexes.
 *
 * 1. GIN trigram indexes for `/search/suggest`. That endpoint runs a
 *    leading-wildcard `LOWER(f_unaccent(col)) LIKE '%q%'` per keystroke, which
 *    is a sequential scan without a trigram index. The index EXPRESSIONS below
 *    are `LOWER(f_unaccent(title|name))`, matching the predicates in
 *    search.service.ts exactly so the planner uses them (verified with EXPLAIN:
 *    the suggest predicate resolves to a Bitmap Index Scan on these indexes).
 *
 *    IMMUTABLE-wrapper fix (required for the index to build): `f_unaccent` was
 *    defined as `SELECT unaccent('unaccent', $1)` (the two-arg, dictionary-named
 *    unaccent). That body CANNOT be used in an index expression: when Postgres
 *    inlines the IMMUTABLE SQL wrapper while building the index it fails to
 *    resolve the two-arg call (`function unaccent(unknown, text) does not exist`,
 *    the `'unaccent'` literal loses its regdictionary coercion). The single-arg
 *    `unaccent($1)` is the same operation (the default text-search dictionary IS
 *    `unaccent`; verified byte-equal on accented samples), and — crucially —
 *    SCHEMA-QUALIFIED as `public.unaccent($1)` it inlines cleanly, so the index
 *    builds. We therefore `CREATE OR REPLACE` `f_unaccent` to the qualified
 *    single-arg body. This is output-identical for every existing caller (the
 *    tsvector trigger, the main `tsv @@` search, and the suggest LIKE), so no
 *    reindex/backfill is needed; `down()` restores the original two-arg body.
 *    (The `unaccent` extension is installed in `public` in this codebase, which
 *    is why `public.unaccent` is the correct qualification.)
 *
 * 2. Composite indexes for two ORDER-BY-only-on-id queries that currently sort
 *    on top of a created_at index:
 *    - page_history: `findPageHistoryByPageId` does WHERE page_id ORDER BY id
 *      DESC, but only `(page_id, created_at DESC)` exists → extra sort.
 *    - comments: `findPageComments` does WHERE page_id ORDER BY id ASC, but only
 *      `(page_id)` exists → extra sort.
 *
 * DEPLOY-TIME LOCK WARNING: these are plain (non-CONCURRENT) CREATE INDEX
 * statements — CONCURRENTLY is impossible because Kysely runs each migration in a
 * transaction. They take a SHARE lock that BLOCKS writes (INSERT/UPDATE/DELETE) on
 * pages/users/groups/comments/page_history for the duration of the build. The two
 * GIN trigram builds on pages.title / users.name are the slow ones and can take
 * minutes on a large tenant → a write-outage window during the deploy migration.
 * For large installations, run this migration in a maintenance window, or build
 * the trigram indexes out-of-band with CREATE INDEX CONCURRENTLY before deploying
 * (then this migration's `IF NOT EXISTS` is a no-op). Small/typical tenants are
 * unaffected.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Index-compatible, output-identical redefinition of f_unaccent (see header).
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT public.unaccent($1);
    $func$
  `.execute(db);

  // Search-suggest trigram indexes. Expressions match search.service.ts.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pages_title_trgm
      ON pages USING gin ((LOWER(f_unaccent(title))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_name_trgm
      ON users USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_name_trgm
      ON groups USING gin ((LOWER(f_unaccent(name))) gin_trgm_ops)
  `.execute(db);

  // page_history: WHERE page_id ORDER BY id DESC (findPageHistoryByPageId).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_history_page_id
      ON page_history (page_id, id DESC)
  `.execute(db);

  // comments: WHERE page_id ORDER BY id ASC (findPageComments).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_comments_page_id_id
      ON comments (page_id, id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop the expression indexes before restoring the function body.
  await sql`DROP INDEX IF EXISTS idx_pages_title_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_users_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_groups_name_trgm`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_page_history_page_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_comments_page_id_id`.execute(db);

  // Restore the original two-arg (dictionary-named) f_unaccent body.
  await sql`
    CREATE OR REPLACE FUNCTION f_unaccent(text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE PARALLEL SAFE STRICT
    AS $func$
      SELECT unaccent('unaccent', $1);
    $func$
  `.execute(db);
}
