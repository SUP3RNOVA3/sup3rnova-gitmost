import { Kysely, sql } from 'kysely';
import { getTestDb, destroyTestDb } from './db';
import * as migration from '../../src/database/migrations/20260707T120000-search-ru-en-config';

/**
 * #529 A1 — the ru_en config migration must be REVERSIBLE in the correct order:
 * down() moves pages.tsv + page_embeddings.fts back to `english` BEFORE dropping
 * the ru_en config (a generated column still depending on ru_en would block the
 * DROP). This roundtrips down()→up() on the already-migrated test DB and asserts
 * the config, the pages trigger and the fts generated expression each flip and
 * flip back — the deploy-critical property.
 */
describe('search ru_en config migration [integration]', () => {
  let db: Kysely<any>;

  const configExists = async () => {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_ts_config WHERE cfgname = 'ru_en'
    `.execute(db);
    return r.rows[0].n > 0;
  };

  const ftsDef = async () => {
    const r = await sql<{ def: string }>`
      SELECT pg_get_expr(adbin, adrelid) AS def
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE a.attname = 'fts' AND a.attrelid = 'page_embeddings'::regclass
    `.execute(db);
    return r.rows[0]?.def ?? '';
  };

  const triggerSrc = async () => {
    const r = await sql<{ src: string }>`
      SELECT prosrc AS src FROM pg_proc WHERE proname = 'pages_tsvector_trigger'
    `.execute(db);
    return r.rows[0]?.src ?? '';
  };

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    // Restore the migrated (ru_en) state for any later suite, then close.
    if (!(await configExists())) {
      await migration.up(db);
    }
    await destroyTestDb();
  });

  it('starts at ru_en (config present, trigger + fts on ru_en)', async () => {
    expect(await configExists()).toBe(true);
    expect(await ftsDef()).toContain('ru_en');
    expect(await triggerSrc()).toContain('ru_en');
  });

  it('down() reverts tsv + fts to english THEN drops the config', async () => {
    await migration.down(db);
    expect(await configExists()).toBe(false);
    expect(await ftsDef()).toContain('english');
    expect(await ftsDef()).not.toContain('ru_en');
    expect(await triggerSrc()).toContain('english');
  });

  it('up() re-applies ru_en cleanly (idempotent config create)', async () => {
    await migration.up(db);
    expect(await configExists()).toBe(true);
    expect(await ftsDef()).toContain('ru_en');
    expect(await triggerSrc()).toContain('ru_en');
  });
});
