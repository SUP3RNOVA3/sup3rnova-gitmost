import { ServiceUnavailableException } from '@nestjs/common';

// Control the SDK's auth() so the start/callback flows are observable without a
// live authorization server. Replaced per-test via `mockAuth`.
const mockAuth = jest.fn();
jest.mock('@ai-sdk/mcp', () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { McpOauthService } from './mcp-oauth.service';
import {
  McpGrantExpiredError,
  McpGrantUnavailableError,
} from './mcp-oauth.errors';

/**
 * #687 — OAuth flow + runtime token service. These are the acceptance criteria
 * as OBSERVABLE properties (AGENTS #8): the real single-flight refresh, the real
 * failure classification, the real FSM transitions and the real Redis-down 503.
 */

/** A fake token-endpoint Response (only the fields doRefresh reads). */
function tokenResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function connectedGrant(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'srv-1',
    clientId: 'client-1',
    clientSecretEnc: null,
    authorizationServer: 'https://as.example.com',
    authorizationEndpoint: 'https://as.example.com/authorize',
    tokenEndpoint: 'https://as.example.com/token',
    accessTokenEnc: 'enc:AT',
    refreshTokenEnc: 'enc:RT',
    expiresAt: new Date(Date.now() - 1000), // already expired -> forces refresh
    status: 'connected',
    errorDetail: null,
    ...overrides,
  };
}

function build() {
  const grant = { current: connectedGrant() as any };
  const grantRepo = {
    findByServerId: jest.fn(async () => grant.current),
    upsertStart: jest.fn(async () => undefined),
    updateTokens: jest.fn(async () => 1),
    markStatus: jest.fn(async () => 1),
    delete: jest.fn(async () => undefined),
  };
  const redis = {
    set: jest.fn(async () => 'OK'),
    multi: jest.fn(),
  };
  const redisService = { getOrThrow: () => redis } as any;
  const secretBox = {
    // Reversible, deterministic stand-ins so token round-trips are checkable.
    encryptSecret: (p: string) => `enc:${p}`,
    decryptSecret: (b: string) => b.replace(/^enc:/, ''),
  } as any;
  const env = {
    getAppUrl: () => 'https://app.example.com',
    isMcpPersonalServersEnabled: () => true,
  } as any;

  const svc = new McpOauthService(redisService, grantRepo as any, secretBox, env);
  return { svc, grantRepo, redis, grant };
}

const server = { id: 'srv-1', workspaceId: 'ws-1', url: 'https://mcp.example.com' };

beforeEach(() => {
  mockAuth.mockReset();
});

describe('ensureAccessToken — proactive refresh + classification', () => {
  it('returns the stored access token without refreshing when it is fresh', async () => {
    const { svc, grant } = build();
    grant.current = connectedGrant({
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const fetchFn = jest.fn();
    (svc as any).fetchFn = fetchFn;

    await expect(svc.ensureAccessToken(server)).resolves.toBe('AT');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('SECURITY: runtime tokens() exposes ONLY the access token, never refresh_token', async () => {
    // Load-bearing design decision (spec): handing the SDK a refresh_token would
    // activate its OWN refresh branch, and the AS's one-time-use rotation would
    // make two concurrent clients of one grant lose the live grant. Refresh MUST
    // stay in our single-flight, so tokens() must never leak refresh_token.
    const { svc, grant } = build();
    grant.current = connectedGrant({
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const provider = svc.createRuntimeProvider(server);
    const toks = await provider.tokens();
    expect(toks).toBeDefined();
    expect(toks!.access_token).toBe('AT');
    expect('refresh_token' in (toks as object)).toBe(false);
    expect((toks as any).refresh_token).toBeUndefined();
  });

  it('criterion 7: expired access -> refreshes, persists the new token, no error', async () => {
    const { svc, grantRepo } = build();
    const fetchFn = jest.fn(async () =>
      tokenResponse(200, {
        access_token: 'AT2',
        refresh_token: 'RT2',
        expires_in: 3600,
      }),
    );
    (svc as any).fetchFn = fetchFn;

    await expect(svc.ensureAccessToken(server)).resolves.toBe('AT2');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(grantRepo.updateTokens).toHaveBeenCalledWith('srv-1', {
      accessTokenEnc: 'enc:AT2',
      refreshTokenEnc: 'enc:RT2',
      expiresAt: expect.any(Date),
    });
    // Stays connected: NO status transition on a successful refresh.
    expect(grantRepo.markStatus).not.toHaveBeenCalled();
  });

  it('LOW: a hostile empty refresh_token does NOT overwrite the live one', async () => {
    const { svc, grantRepo } = build();
    // AS returns a new access token but an EMPTY refresh_token (a string, but not
    // a usable token). We must persist the new access yet KEEP the old refresh.
    (svc as any).fetchFn = jest.fn(async () =>
      tokenResponse(200, {
        access_token: 'AT2',
        refresh_token: '',
        expires_in: 3600,
      }),
    );

    await expect(svc.ensureAccessToken(server)).resolves.toBe('AT2');
    // 'RT' is the pre-existing refresh (grant.refreshTokenEnc = 'enc:RT'); it is
    // re-encrypted unchanged, NOT replaced by enc:'' (which would break the next
    // refresh with invalid_grant -> spurious re-consent).
    expect(grantRepo.updateTokens).toHaveBeenCalledWith('srv-1', {
      accessTokenEnc: 'enc:AT2',
      refreshTokenEnc: 'enc:RT',
      expiresAt: expect.any(Date),
    });
    expect(grantRepo.markStatus).not.toHaveBeenCalled();
  });

  it('criterion 5: AS 503 -> grant STAYS connected, throws unavailable', async () => {
    const { svc, grantRepo } = build();
    const fetchFn = jest.fn(async () => tokenResponse(503, {}));
    (svc as any).fetchFn = fetchFn;

    await expect(svc.ensureAccessToken(server)).rejects.toBeInstanceOf(
      McpGrantUnavailableError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(grantRepo.markStatus).not.toHaveBeenCalled();
  });

  it('network error -> grant STAYS connected, throws unavailable', async () => {
    const { svc, grantRepo } = build();
    (svc as any).fetchFn = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(svc.ensureAccessToken(server)).rejects.toBeInstanceOf(
      McpGrantUnavailableError,
    );
    expect(grantRepo.markStatus).not.toHaveBeenCalled();
  });

  it('FSM connected->expired: invalid_grant -> expired + throws expired', async () => {
    const { svc, grantRepo } = build();
    (svc as any).fetchFn = jest.fn(async () =>
      tokenResponse(400, { error: 'invalid_grant' }),
    );
    await expect(svc.ensureAccessToken(server)).rejects.toBeInstanceOf(
      McpGrantExpiredError,
    );
    expect(grantRepo.markStatus).toHaveBeenCalledWith(
      'srv-1',
      'expired',
      expect.stringContaining('invalid_grant'),
    );
  });

  it('invalid_client -> expired', async () => {
    const { svc, grantRepo } = build();
    (svc as any).fetchFn = jest.fn(async () =>
      tokenResponse(401, { error: 'invalid_client' }),
    );
    await expect(svc.ensureAccessToken(server)).rejects.toBeInstanceOf(
      McpGrantExpiredError,
    );
    expect(grantRepo.markStatus).toHaveBeenCalledWith(
      'srv-1',
      'expired',
      expect.any(String),
    );
  });

  it('criterion 6: two concurrent refreshers -> exactly ONE AS request', async () => {
    const { svc, grantRepo } = build();
    let calls = 0;
    (svc as any).fetchFn = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          calls += 1;
          setTimeout(
            () =>
              resolve(
                tokenResponse(200, {
                  access_token: 'AT2',
                  refresh_token: 'RT2',
                  expires_in: 3600,
                }),
              ),
            10,
          );
        }),
    );

    const [a, b] = await Promise.all([
      svc.ensureAccessToken(server),
      svc.ensureAccessToken(server),
    ]);
    expect(a).toBe('AT2');
    expect(b).toBe('AT2');
    expect(calls).toBe(1);
    // One persisted rotation (both callers shared the single flight).
    expect(grantRepo.updateTokens).toHaveBeenCalledTimes(1);
  });
});

describe('startAuthorization — FSM start->pending + Redis-down 503', () => {
  // Simulate the SDK driving the provider through DCR/discovery/startAuthorization.
  function primeAuthRedirect() {
    mockAuth.mockImplementation(async (provider: any) => {
      provider.saveClientInformation({
        client_id: 'client-1',
        client_secret: 'secret-1',
      });
      provider.saveAuthorizationServerInformation({
        authorizationServerUrl: 'https://as.example.com',
        tokenEndpoint: 'https://as.example.com/token',
      });
      const st = provider.state();
      provider.saveState(st);
      provider.saveCodeVerifier('verifier-xyz');
      await provider.redirectToAuthorization(
        new URL('https://as.example.com/authorize?client_id=client-1'),
      );
      return 'REDIRECT';
    });
  }

  it('persists a pending grant + one-time state, returns the authorize URL', async () => {
    const { svc, grantRepo, redis } = build();
    primeAuthRedirect();

    const res = await svc.startAuthorization('user-1', server);
    expect(res.authorizeUrl).toContain('https://as.example.com/authorize');
    // State written FIRST (SET ... EX 600 NX).
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('mcp-oauth:state:'),
      expect.stringContaining('"userId":"user-1"'),
      'EX',
      600,
      'NX',
    );
    // Grant upserted as pending with the DCR/AS pins (client_secret encrypted).
    expect(grantRepo.upsertStart).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv-1',
        clientId: 'client-1',
        clientSecretEnc: 'enc:secret-1',
        authorizationServer: 'https://as.example.com',
        tokenEndpoint: 'https://as.example.com/token',
      }),
    );
  });

  it('criterion 10: Redis down -> 503 with the cause, NO grant write', async () => {
    const { svc, grantRepo, redis } = build();
    primeAuthRedirect();
    redis.set.mockRejectedValueOnce(new Error('Redis connection refused'));

    await expect(svc.startAuthorization('user-1', server)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(grantRepo.upsertStart).not.toHaveBeenCalled();
  });
});

describe('completeCallback — FSM pending->connected / pending->error', () => {
  it('AUTHORIZED -> saveTokens persisted + status connected', async () => {
    const { svc, grantRepo } = build();
    grantRepo.findByServerId.mockResolvedValue(
      connectedGrant({ status: 'pending', accessTokenEnc: null }) as any,
    );
    mockAuth.mockImplementation(async (provider: any) => {
      await provider.saveTokens({
        access_token: 'AT9',
        token_type: 'Bearer',
        refresh_token: 'RT9',
        expires_in: 3600,
      });
      return 'AUTHORIZED';
    });

    await expect(
      svc.completeCallback(server, 'code-1', 'state-1', 'verifier-xyz'),
    ).resolves.toBe('connected');
    expect(grantRepo.updateTokens).toHaveBeenCalledWith('srv-1', {
      accessTokenEnc: 'enc:AT9',
      refreshTokenEnc: 'enc:RT9',
      expiresAt: expect.any(Date),
    });
    expect(grantRepo.markStatus).toHaveBeenCalledWith('srv-1', 'connected', null);
  });

  it('exchange throws -> status error with detail', async () => {
    const { svc, grantRepo } = build();
    grantRepo.findByServerId.mockResolvedValue(
      connectedGrant({ status: 'pending' }) as any,
    );
    mockAuth.mockRejectedValue(new Error('bad_verifier'));

    await expect(
      svc.completeCallback(server, 'code-1', 'state-1', 'verifier-xyz'),
    ).resolves.toBe('error');
    expect(grantRepo.markStatus).toHaveBeenCalledWith(
      'srv-1',
      'error',
      expect.stringContaining('bad_verifier'),
    );
  });
});

describe('consumeState — one-time gash', () => {
  it('returns the payload from a MULTI get+del', async () => {
    const { svc, redis } = build();
    redis.multi.mockReturnValue({
      get: () => ({
        del: () => ({
          exec: async () => [
            [null, JSON.stringify({ userId: 'u', serverId: 's', codeVerifier: 'v' })],
            [null, 1],
          ],
        }),
      }),
    });
    await expect(svc.consumeState('abc')).resolves.toEqual({
      userId: 'u',
      serverId: 's',
      codeVerifier: 'v',
    });
  });

  it('criterion 8 (replay): absent key -> null (already gashed)', async () => {
    const { svc, redis } = build();
    redis.multi.mockReturnValue({
      get: () => ({
        del: () => ({ exec: async () => [[null, null], [null, 0]] }),
      }),
    });
    await expect(svc.consumeState('abc')).resolves.toBeNull();
  });
});

describe('disconnect / resetGrant — FSM -> none', () => {
  it('disconnect deletes the grant row', async () => {
    const { svc, grantRepo } = build();
    await svc.disconnect('srv-1');
    expect(grantRepo.delete).toHaveBeenCalledWith('srv-1');
  });

  it('resetGrant deletes the grant row', async () => {
    const { svc, grantRepo } = build();
    await svc.resetGrant('srv-1');
    expect(grantRepo.delete).toHaveBeenCalledWith('srv-1');
  });
});
