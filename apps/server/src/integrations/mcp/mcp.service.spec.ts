import { UnauthorizedException } from '@nestjs/common';
import {
  resolveMcpSessionConfig,
  verifyMcpBearer,
  bindMcpBearerVerifier,
  sharedTokenMatches,
  extractBearer,
  mapAuthResultToResponse,
  McpAuthDeps,
} from './mcp-auth.helpers';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { McpService } from './mcp.service';

// The /mcp per-request auth decision logic is tested through the framework-free
// `resolveMcpSessionConfig` helper that McpService delegates to. McpService
// itself cannot be instantiated under jest because importing the heavy auth
// graph drags in the React email templates + queue constants graph; extracting
// the pure logic (and wiring it in) keeps it both tested AND used.
//
// /mcp accepts EXACTLY ONE credential: a Bearer api_key JWT. There is no HTTP
// Basic email:password, no human ACCESS session token, and no env service
// account — everything else is a 401.

function basicHeader(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

function makeDeps(over: Partial<McpAuthDeps> = {}): McpAuthDeps {
  return {
    apiUrl: 'http://127.0.0.1:3000/api',
    findWorkspace:
      over.findWorkspace ?? jest.fn().mockResolvedValue({ id: 'ws-1' }),
    // Default: a valid api_key verification returning a principal.
    verifyAccessJwt:
      over.verifyAccessJwt ??
      jest.fn().mockResolvedValue({ sub: 'svc-1', email: 'svc@e.com' }),
  };
}

describe('extractBearer', () => {
  it('extracts the token from a "Bearer <token>" header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme (lowercase + uppercase)', () => {
    // The split keeps the token as-is; only the scheme is compared lowercased.
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('BEARER abc')).toBe('abc');
  });

  it('returns undefined for a non-Bearer scheme (e.g. Basic)', () => {
    expect(extractBearer('Basic abc')).toBeUndefined();
  });

  it('returns undefined for an undefined header', () => {
    expect(extractBearer(undefined)).toBeUndefined();
  });
});

describe('resolveMcpSessionConfig (Bearer api_key ONLY)', () => {
  it('valid api_key Bearer -> verifies and returns a getToken config', async () => {
    const verifyAccessJwt = jest
      .fn()
      .mockResolvedValue({ sub: 'svc-9', email: 'svc@e.com' });
    const resolved = await resolveMcpSessionConfig(
      'Bearer some.api.key',
      makeDeps({ verifyAccessJwt }),
    );
    expect(verifyAccessJwt).toHaveBeenCalledWith('some.api.key');
    const cfg = resolved.config as { getToken: () => Promise<string> };
    await expect(cfg.getToken()).resolves.toBe('some.api.key');
    expect(resolved.identity).toBe('bearer:svc-9');
  });

  it('HTTP Basic email:password -> 401 (api_key only), verify NOT called', async () => {
    const verifyAccessJwt = jest.fn();
    await expect(
      resolveMcpSessionConfig(
        basicHeader('user@example.com', 'pw'),
        makeDeps({ verifyAccessJwt }),
      ),
    ).rejects.toThrow(/Bearer api_key/);
    // A Basic header is not a Bearer token, so the verifier is never consulted.
    expect(verifyAccessJwt).not.toHaveBeenCalled();
  });

  it('a Bearer token the {API_KEY} allowlist refuses (e.g. an ACCESS session JWT) -> generic 401', async () => {
    // In production verifyAccessJwt is verifyMcpBearer, whose bound verifier pins
    // the allowlist to {API_KEY}; a human ACCESS-session token is rejected there
    // with an UnauthorizedException. resolveMcpSessionConfig must surface the
    // UNIFORM generic 401 (anti-enumeration), not the specific reason.
    const verifyAccessJwt = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException('invalid token type'));
    await expect(
      resolveMcpSessionConfig(
        'Bearer human.access.jwt',
        makeDeps({ verifyAccessJwt }),
      ),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('no Authorization header -> 401, EVEN when MCP_DOCMOST_EMAIL/PASSWORD are set (no service-account fallback)', async () => {
    // Prove there is no env service-account fallback: with the old service-account
    // vars set, a credential-less request STILL 401s. The helper never reads env.
    const prevEmail = process.env.MCP_DOCMOST_EMAIL;
    const prevPassword = process.env.MCP_DOCMOST_PASSWORD;
    process.env.MCP_DOCMOST_EMAIL = 'svc@example.com';
    process.env.MCP_DOCMOST_PASSWORD = 'svcpw';
    try {
      const verifyAccessJwt = jest.fn();
      await expect(
        resolveMcpSessionConfig(undefined, makeDeps({ verifyAccessJwt })),
      ).rejects.toThrow(/Bearer api_key/);
      expect(verifyAccessJwt).not.toHaveBeenCalled();
    } finally {
      if (prevEmail === undefined) delete process.env.MCP_DOCMOST_EMAIL;
      else process.env.MCP_DOCMOST_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.MCP_DOCMOST_PASSWORD;
      else process.env.MCP_DOCMOST_PASSWORD = prevPassword;
    }
  });

  it('Bearer INFRA error -> propagates (NOT masked as 401)', async () => {
    // A non-UnauthorizedException (e.g. a DB outage in the api-key row-check) is
    // not an auth verdict: it must propagate so the surface maps it to 5xx.
    const verifyAccessJwt = jest
      .fn()
      .mockRejectedValue(new Error('connection terminated'));
    await expect(
      resolveMcpSessionConfig('Bearer x', makeDeps({ verifyAccessJwt })),
    ).rejects.toThrow('connection terminated');
  });

  it('different keys yield different identity keys (anti-fixation)', async () => {
    const a = await resolveMcpSessionConfig(
      'Bearer key-a',
      makeDeps({
        verifyAccessJwt: jest.fn().mockResolvedValue({ sub: 'svc-a' }),
      }),
    );
    const b = await resolveMcpSessionConfig(
      'Bearer key-b',
      makeDeps({
        verifyAccessJwt: jest.fn().mockResolvedValue({ sub: 'svc-b' }),
      }),
    );
    expect(a.identity).toBe('bearer:svc-a');
    expect(b.identity).toBe('bearer:svc-b');
    expect(a.identity).not.toBe(b.identity);
  });
});

describe('sharedTokenMatches (X-MCP-Token constant-time guard)', () => {
  it('equal token -> true', () => {
    expect(sharedTokenMatches('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('wrong token of the SAME length -> false (timingSafeEqual path)', () => {
    // Same length so it reaches timingSafeEqual; the bytes differ -> no match.
    expect(sharedTokenMatches('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('different-length token -> false WITHOUT throwing (early-return before timingSafeEqual)', () => {
    // timingSafeEqual throws on unequal-length buffers; the early length check
    // must short-circuit so a length mismatch is a clean non-match, not a throw.
    expect(() => sharedTokenMatches('expected', 'short')).not.toThrow();
    expect(sharedTokenMatches('expected', 'short')).toBe(false);
    expect(sharedTokenMatches('expected', 'a-much-longer-provided-value')).toBe(
      false,
    );
  });

  it('array-valued header -> uses the FIRST element', () => {
    // Multiple X-MCP-Token headers arrive as string[]; only the first is used.
    expect(sharedTokenMatches('tok', ['tok', 'ignored'])).toBe(true);
    expect(sharedTokenMatches('tok', ['wrong', 'tok'])).toBe(false);
  });

  it('undefined / non-string provided -> false', () => {
    expect(sharedTokenMatches('tok', undefined)).toBe(false);
    // An empty array yields provided[0] === undefined -> non-string -> false.
    expect(sharedTokenMatches('tok', [])).toBe(false);
    expect(sharedTokenMatches('tok', [undefined as unknown as string])).toBe(
      false,
    );
  });
});

describe('bindMcpBearerVerifier pins the {API_KEY} allowlist (#558)', () => {
  it('calls verifyJwtOneOf with exactly [API_KEY]', async () => {
    const verifyJwtOneOf = jest
      .fn()
      .mockResolvedValue({ type: JwtType.API_KEY, sub: 'u-1' });
    await bindMcpBearerVerifier({ verifyJwtOneOf })('the.jwt');
    expect(verifyJwtOneOf).toHaveBeenCalledWith('the.jwt', [JwtType.API_KEY]);
    // Pin the concrete enum value too — an ACCESS token is NOT accepted.
    expect(verifyJwtOneOf.mock.calls[0][1]).toEqual(['api_key']);
    expect(verifyJwtOneOf.mock.calls[0][1]).not.toContain('access');
  });
});

describe('verifyMcpBearer (API_KEY only)', () => {
  const apiKeyDeps = (over: any = {}) => ({
    verifyJwtOneOf: jest.fn(),
    expectedWorkspaceId: 'ws-1',
    validateApiKey: jest.fn(),
    ...over,
  });

  it('API_KEY -> row-checks via validateApiKey and returns the principal', async () => {
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-1',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn().mockResolvedValue({ user: { id: 'svc-1' } }),
    });
    const res = await verifyMcpBearer('tok', deps);
    expect(deps.validateApiKey).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sub: 'svc-1' });
  });

  it('API_KEY for ANOTHER workspace -> rejected before the row-check', async () => {
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-OTHER',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn(),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(deps.validateApiKey).not.toHaveBeenCalled();
  });

  it('API_KEY infra error from validateApiKey PROPAGATES (not masked)', async () => {
    const boom = new Error('db down');
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.API_KEY,
        sub: 'svc-1',
        workspaceId: 'ws-1',
        apiKeyId: 'k-1',
      }),
      validateApiKey: jest.fn().mockRejectedValue(boom),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBe(boom);
  });

  it('a non-API_KEY payload (defence in depth) -> 401 without touching validateApiKey', async () => {
    // The allowlist already pins the type to API_KEY, so verifyJwtOneOf would
    // reject an ACCESS token first; if a non-API_KEY payload ever reached here,
    // verifyMcpBearer must still deny it uniformly and never row-check it.
    const deps = apiKeyDeps({
      verifyJwtOneOf: jest.fn().mockResolvedValue({
        type: JwtType.ACCESS,
        sub: 'u-1',
        workspaceId: 'ws-1',
        sessionId: 'sess-1',
      }),
    });
    await expect(verifyMcpBearer('tok', deps)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(deps.validateApiKey).not.toHaveBeenCalled();
  });

  it('verifies the signature exactly ONCE (single verifyJwtOneOf)', async () => {
    const verifyJwtOneOf = jest.fn().mockResolvedValue({
      type: JwtType.API_KEY,
      sub: 'svc-1',
      workspaceId: 'ws-1',
      apiKeyId: 'k-1',
    });
    await verifyMcpBearer('tok', apiKeyDeps({ verifyJwtOneOf }));
    expect(verifyJwtOneOf).toHaveBeenCalledTimes(1);
  });
});

describe('mapAuthResultToResponse (handle status/body mapping)', () => {
  // The pure response decision extracted out of McpService.handle. It maps the
  // pre-hijack gauntlet (shared token, enablement, auth error) to either a fixed
  // JSON error response or the hijack path — never leaking the token/header.

  it('wrong X-MCP-Token -> 401 {error:"Unauthorized"} and NOT the hijack path', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: false, enabled: true });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
    });
  });

  it('workspace MCP disabled -> 403', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: true, enabled: false });
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.status).toBe(403);
      expect(d.body).toEqual({ error: 'MCP is disabled for this workspace' });
    }
  });

  it('an UnauthorizedException -> 401 with err.message; no token/header leaked', () => {
    // Construct an UnauthorizedException whose message is the SPECIFIC auth reason.
    const err = new UnauthorizedException('Invalid or expired token');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Invalid or expired token' },
    });
    // The surfaced body is ONLY the exception message — never the raw secret.
    if (d.kind === 'respond') {
      const serialized = JSON.stringify(d.body);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer ');
    }
  });

  it('a non-Unauthorized error -> 500 generic (no error detail surfaced)', () => {
    const err = new Error('db blew up: connection string secret');
    const d = mapAuthResultToResponse({
      sharedTokenOk: true,
      enabled: true,
      error: err,
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 500,
      body: { error: 'Internal server error' },
    });
    // The generic body must NOT echo the underlying error message.
    if (d.kind === 'respond') {
      expect(d.body.error).not.toContain('secret');
    }
  });

  it('happy path (auth resolved, no error) -> hijack', () => {
    const d = mapAuthResultToResponse({ sharedTokenOk: true, enabled: true });
    expect(d).toEqual({ kind: 'hijack' });
  });

  it('shared-token failure takes precedence over disabled/error', () => {
    // Even with a disabled workspace and an error, a bad shared token is the
    // first gate, so the response is the uniform 401 Unauthorized.
    const d = mapAuthResultToResponse({
      sharedTokenOk: false,
      enabled: false,
      error: new UnauthorizedException('should not surface'),
    });
    expect(d).toEqual({
      kind: 'respond',
      status: 401,
      body: { error: 'Unauthorized' },
    });
  });
});

// #486: onModuleDestroy tears down the live loopback CollabSessions so the
// embedded MCP's collab sockets do not keep docs pinned open on the collab
// server past process exit. The teardown goes through an overridable seam
// (destroyAllMcpSessions) so it can be spied without loading the ESM-only
// @docmost/mcp package.
describe('McpService.onModuleDestroy — CollabSession teardown (#486)', () => {
  function makeService(): McpService {
    // The constructor only stores its deps, so bare stubs suffice.
    return new McpService({} as any, {} as any, {} as any, {} as any);
  }

  it('destroys all sessions on shutdown', async () => {
    const svc = makeService();
    const destroy = jest.fn().mockResolvedValue(undefined);
    (svc as any).destroyAllMcpSessions = destroy;

    await svc.onModuleDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('swallows a teardown failure so shutdown never throws', async () => {
    const svc = makeService();
    (svc as any).destroyAllMcpSessions = jest
      .fn()
      .mockRejectedValue(new Error('collab teardown boom'));

    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});
