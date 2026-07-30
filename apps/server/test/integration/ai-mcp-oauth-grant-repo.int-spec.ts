import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AiMcpOauthGrantRepo } from '@docmost/db/repos/ai-chat/ai-mcp-oauth-grant.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
} from './db';

/**
 * #699 (#687) — OAuth grant persistence against real Postgres. Two properties
 * here are DB-observable and CANNOT be seen by a mocked unit test (AGENTS #8):
 *
 *  1. ON DELETE CASCADE: deleting the server destroys its grant row — no
 *     orphaned grant with a live encrypted refresh_token can survive the server
 *     (a mis-edited FK would leave an orphan while every unit test stays green).
 *  2. Anti-resurrection: `updateTokens`/`markStatus` are UPDATE-only — with no
 *     grant row they affect 0 rows and create NOTHING, so a mid-flow
 *     Disconnect/CASCADE can never be "resurrected" with fresh tokens.
 */
describe('AiMcpOauthGrantRepo [integration]', () => {
  let db: Kysely<any>;
  let serverRepo: AiMcpServerRepo;
  let grantRepo: AiMcpOauthGrantRepo;
  let ws: string;
  let userId: string;

  beforeAll(async () => {
    db = getTestDb();
    serverRepo = new AiMcpServerRepo(db as any);
    grantRepo = new AiMcpOauthGrantRepo(db as any);
    ws = (await createWorkspace(db)).id;
    userId = (await createUser(db, ws)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  const mkOauthServer = () =>
    serverRepo.insert({
      workspaceId: ws,
      userId,
      authType: 'oauth2',
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    });

  const seedGrant = async (serverId: string) => {
    await grantRepo.upsertStart({
      serverId,
      clientId: 'client-1',
      clientSecretEnc: 'enc:secret',
      authorizationServer: 'https://as.example.com',
      authorizationEndpoint: 'https://as.example.com/authorize',
      tokenEndpoint: 'https://as.example.com/token',
    });
    // Give it a "live" encrypted refresh token so the CASCADE actually removes a
    // credential-bearing row (the orphan-token risk under test).
    await grantRepo.updateTokens(serverId, {
      accessTokenEnc: 'enc:AT',
      refreshTokenEnc: 'enc:RT',
      expiresAt: new Date(Date.now() + 3600_000),
    });
  };

  it('MED: deleting the server CASCADEs its grant (no orphaned token row)', async () => {
    const server = await mkOauthServer();
    await seedGrant(server.id);

    // Precondition: the grant exists and carries a refresh token.
    const before = await grantRepo.findByServerId(server.id);
    expect(before).toBeDefined();
    expect(before?.refreshTokenEnc).toBe('enc:RT');

    // Delete the server row -> FK ON DELETE CASCADE removes the grant.
    await serverRepo.deleteForUser(server.id, ws, userId);

    const after = await grantRepo.findByServerId(server.id);
    expect(after).toBeUndefined();
  });

  it('MED: deleting the OWNER cascades server -> grant (no survivor)', async () => {
    const owner = (await createUser(db, ws)).id;
    const server = await serverRepo.insert({
      workspaceId: ws,
      userId: owner,
      authType: 'oauth2',
      name: `srv-${randomUUID()}`,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    });
    await seedGrant(server.id);
    expect(await grantRepo.findByServerId(server.id)).toBeDefined();

    // users.id ON DELETE CASCADE -> server row -> grant row.
    await db.deleteFrom('users').where('id', '=', owner).execute();

    expect(await grantRepo.findByServerId(server.id)).toBeUndefined();
  });

  it('MED: updateTokens/markStatus on a MISSING grant affect 0 rows and resurrect NOTHING', async () => {
    const server = await mkOauthServer();
    await seedGrant(server.id);
    // Disconnect: delete the grant mid-flow.
    await grantRepo.delete(server.id);
    expect(await grantRepo.findByServerId(server.id)).toBeUndefined();

    // A background refresh that resolved after the Disconnect must NOT re-create
    // the grant. UPDATE-only => 0 affected rows, and no row is inserted.
    const updated = await grantRepo.updateTokens(server.id, {
      accessTokenEnc: 'enc:AT2',
      refreshTokenEnc: 'enc:RT2',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(updated).toBe(0);

    const marked = await grantRepo.markStatus(server.id, 'expired', 'boom');
    expect(marked).toBe(0);

    // Still gone — no resurrection with fresh tokens.
    expect(await grantRepo.findByServerId(server.id)).toBeUndefined();
  });
});
