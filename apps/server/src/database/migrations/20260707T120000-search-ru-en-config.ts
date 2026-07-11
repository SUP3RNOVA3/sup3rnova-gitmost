import { type Kysely, sql } from 'kysely';

/**
 * #529 Phase A1 — the `ru_en` text-search configuration + the config swap.
 *
 * WHY: the search stack was pinned to the `english` FTS config, which stems only
 * Latin words. On a Russian-language wiki that is a morphology black hole:
 * «ресторанов москвы» never matched a page titled «ресторан в москве». `ru_en`
 * layers the russian_stem over the Cyrillic token classes and english_stem over
 * the ascii ones, so BOTH languages get proper morphology from one config.
 *
 *   CREATE TEXT SEARCH CONFIGURATION ru_en (COPY = simple);
 *   ALTER ... asciiword/asciihword/hword_asciipart WITH english_stem;
 *   ALTER ... word/hword/hword_part           WITH russian_stem;
 *
 * `to_tsvector('ru_en', …)` with the LITERAL config name is IMMUTABLE, so it is
 * valid inside a trigger, a generated column and an index expression.
 *
 * THE INVARIANT (acceptance #13): the config of the STORED column and the config
 * of the QUERY must change together. This migration flips BOTH stored sides
 * (pages.tsv via its trigger + a reindex; page_embeddings.fts, the RAG lexical
 * leg, via its generated expression); the matching QUERY-side flips
 * (search.service.ts and page-embedding.repo.ts `hybridSearch`) ship in the SAME
 * commit. Trigram indexes are LOWER(f_unaccent(...)) and do NOT depend on the FTS
 * config, so they are untouched.
 *
 * REINDEX / LOCK MODEL (deploy-critical). This repo's Kysely Migrator runs the
 * whole pending set inside ONE transaction (migration.service.ts / migrate.ts set
 * no `disableTransactions`), and PostgresJSDialect has transactional DDL — so a
 * migration file CANNOT commit between batches, which means the issue's
 * "procedural batch job OUTSIDE the transaction + dual-config read window +
 * migration_complete gate" is not expressible in-migration here. That machinery
 * exists to bridge a reindex spread over MANY committed batches, during which some
 * rows are still `english` while others are already `ru_en`. Our reindex is ATOMIC
 * (one transaction): at COMMIT every row is `ru_en` at once, so no morphology-
 * desync window exists and no dual-config read path is required — the query config
 * flips to `ru_en` in the very same release. This is the deliberate, correct
 * adaptation to this framework (see the PR notes).
 *
 *   - pages.tsv: swapping the trigger is a cheap catalog change (no table lock),
 *     and the reindex is a single `UPDATE pages SET tsv = <ru_en expr>` — a
 *     ROW-level-lock backfill, NOT an ACCESS EXCLUSIVE rewrite (mirrors the
 *     existing space_id backfill in 20250725T052004).
 *   - page_embeddings.fts is a GENERATED STORED column; Postgres has no way to
 *     change a generated expression without DROP+ADD, which rewrites the table
 *     under ACCESS EXCLUSIVE. On a LARGE tenant run this in a maintenance window,
 *     or do it out-of-band before deploy: add a plain `fts_ruen` column, backfill
 *     with CREATE INDEX CONCURRENTLY-style batched UPDATEs, then swap — the
 *     IF-EXISTS guards here then no-op. Small/typical tenants (this fork's target)
 *     are fine with the in-migration rewrite. Same documented trade-off as the
 *     #443 trgm GIN migration (20260706T120000).
 */

// pages.tsv trigger body for a given FTS config — mirrors the latest form
// (20250729T213756): f_unaccent + a 1MB text cap on text_content, weights A/B.
function pagesTriggerSql(config: 'ru_en' | 'english') {
  return sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('${sql.raw(config)}', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('${sql.raw(config)}', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `;
}

async function swapPagesConfig(db: Kysely<any>, config: 'ru_en' | 'english') {
  // 1. Point the trigger at the target config (new/edited rows use it going
  //    forward). CREATE OR REPLACE FUNCTION takes only a brief catalog lock.
  await pagesTriggerSql(config).execute(db);

  // 2. Reindex existing rows: recompute tsv directly with the target config. A
  //    plain UPDATE — row locks, no ACCESS EXCLUSIVE. Equivalent to firing the
  //    trigger but cheaper (no self-update round trip).
  await sql`
    UPDATE pages
    SET tsv =
        setweight(to_tsvector('${sql.raw(config)}', f_unaccent(coalesce(title, ''))), 'A') ||
        setweight(to_tsvector('${sql.raw(config)}', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B')
  `.execute(db);
}

async function swapEmbeddingsFtsConfig(
  db: Kysely<any>,
  config: 'ru_en' | 'english',
) {
  // The generated `fts` expression can only change via DROP+ADD (a table
  // rewrite; see the lock note in the header). The GIN index depends on the
  // column, so it is dropped with it and recreated.
  await sql`DROP INDEX IF EXISTS idx_page_embeddings_fts`.execute(db);
  await sql`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS fts`.execute(db);
  await sql`
    ALTER TABLE page_embeddings
      ADD COLUMN fts tsvector
      GENERATED ALWAYS AS (to_tsvector('${sql.raw(config)}', f_unaccent(content))) STORED
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_page_embeddings_fts
      ON page_embeddings USING gin(fts)
  `.execute(db);
}

export async function up(db: Kysely<any>): Promise<void> {
  // Create the ru_en configuration (idempotent: drop first, nothing depends on it
  // yet at this point in up()).
  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS ru_en`.execute(db);
  await sql`CREATE TEXT SEARCH CONFIGURATION ru_en (COPY = simple)`.execute(db);
  // Latin token classes → english_stem.
  await sql`
    ALTER TEXT SEARCH CONFIGURATION ru_en
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart
      WITH english_stem
  `.execute(db);
  // Cyrillic / non-ascii token classes → russian_stem.
  await sql`
    ALTER TEXT SEARCH CONFIGURATION ru_en
      ALTER MAPPING FOR word, hword, hword_part
      WITH russian_stem
  `.execute(db);

  // Flip both stored sides to ru_en (query-side flips in the same commit).
  await swapPagesConfig(db, 'ru_en');
  await swapEmbeddingsFtsConfig(db, 'ru_en');
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse ORDER matters: the trigger and the generated column reference the
  // `ru_en` config by name, so they must be moved back to `english` BEFORE the
  // config can be dropped (a generated column that still depends on `ru_en` would
  // block the DROP with a dependency error).
  await swapEmbeddingsFtsConfig(db, 'english');
  await swapPagesConfig(db, 'english');
  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS ru_en`.execute(db);
}
