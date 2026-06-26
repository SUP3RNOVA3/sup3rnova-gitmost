import { Kysely, sql } from 'kysely';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { getTestDb, destroyTestDb, createWorkspace } from './db';

/**
 * WorkspaceRepo.updateAiProviderSettings numeric round-trip (#189, #213).
 *
 * `chatContextWindow` is the first NUMERIC provider field routed through this
 * generic SQL layer. The patch builder must cast a JS number so it lands in
 * jsonb as a JSON NUMBER, not the JSON STRING `"200000"` — the client guards
 * (`typeof === "number"`) reject a string, silently killing the `/ max` badge
 * denominator. A plain `::text` cast (the prior code) regressed exactly this.
 * These specs are real SQL and assert both the JS value type and the on-disk
 * `jsonb_typeof`.
 */
describe('WorkspaceRepo.updateAiProviderSettings (numeric round-trip) [integration]', () => {
  let db: Kysely<any>;
  let repo: WorkspaceRepo;

  beforeAll(() => {
    db = getTestDb();
    repo = new WorkspaceRepo(db as any);
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('stores chatContextWindow as a JSON number (not a "200000" string)', async () => {
    const ws = await createWorkspace(db, { settings: undefined });

    const updated = await repo.updateAiProviderSettings(ws.id, {
      driver: 'openai',
      chatModel: 'gpt-4o',
      chatContextWindow: 200000,
    });

    // Returned row: the number survives as a real JS number, alongside the
    // string fields which stay strings.
    const provider = (updated.settings as any)?.ai?.provider;
    expect(provider.chatContextWindow).toBe(200000);
    expect(typeof provider.chatContextWindow).toBe('number');
    expect(provider.driver).toBe('openai');
    expect(provider.chatModel).toBe('gpt-4o');

    // On disk: the jsonb value is typed 'number' (the must-fix assertion), and
    // sibling string fields are typed 'string'.
    const typed = await db
      .selectFrom('workspaces')
      .select([
        sql<string>`jsonb_typeof(settings->'ai'->'provider'->'chatContextWindow')`.as(
          'windowType',
        ),
        sql<string>`jsonb_typeof(settings->'ai'->'provider'->'chatModel')`.as(
          'modelType',
        ),
      ])
      .where('id', '=', ws.id)
      .executeTakeFirstOrThrow();

    expect(typed.windowType).toBe('number');
    expect(typed.modelType).toBe('string');
  });

  it('re-reads chatContextWindow as a number after a partial-merge update', async () => {
    const ws = await createWorkspace(db, {
      settings: { ai: { provider: { driver: 'openai', chatModel: 'x' } } },
    });

    // Merge in only the numeric field; siblings must be preserved and the value
    // must still be a JSON number, not a string.
    await repo.updateAiProviderSettings(ws.id, { chatContextWindow: 128000 });

    const row = await db
      .selectFrom('workspaces')
      .select([
        'settings',
        sql<string>`jsonb_typeof(settings->'ai'->'provider'->'chatContextWindow')`.as(
          'windowType',
        ),
      ])
      .where('id', '=', ws.id)
      .executeTakeFirstOrThrow();

    expect(row.windowType).toBe('number');
    const provider = (row.settings as any)?.ai?.provider;
    expect(provider.chatContextWindow).toBe(128000);
    expect(provider.driver).toBe('openai');
    expect(provider.chatModel).toBe('x');
  });
});
