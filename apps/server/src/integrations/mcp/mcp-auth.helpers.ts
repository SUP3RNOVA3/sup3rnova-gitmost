// Pure, self-contained helpers for the embedded /mcp per-request auth flow. They
// are deliberately framework-free (no Nest, no DI, no concrete service imports)
// so they can be unit-tested in isolation WITHOUT loading the heavy auth/space
// dependency graph, and reused by McpService. Nothing here logs the token or the
// Authorization header.
//
// /mcp accepts EXACTLY ONE credential: a Bearer api_key JWT (an agent's key).
// There is NO HTTP Basic email:password, NO human ACCESS session token, and NO
// env credential fallback — an agent authenticates only with an api_key.
import { UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { JwtType } from '../../core/auth/dto/jwt-payload';

// The per-session DocmostMcpConfig shape understood by @docmost/mcp: the per-user
// getToken variant (the token minted/verified for THIS request). The optional
// `sandbox` sink (blob store for the stash tool) and the `onMetric` sink are
// injected by McpService after the auth decision.
export type DocmostMcpConfig = {
  apiUrl: string;
  getToken: () => Promise<string>;
} & {
  sandbox?: {
    put: (
      buf: Buffer,
      mime: string,
    ) => { uri: string; sha256: string; size: number };
    // Optional live/evict probes the package uses to keep stashPage's mirror
    // counts honest under the store's FIFO eviction (mirror of the package's
    // sink type); older bindings omit them.
    has?: (uri: string) => boolean;
    evict?: (uri: string) => void;
  };
  // Dependency-neutral metrics sink injected by McpService (mirror of the
  // package's onMetric). The package emits generic (name, value, labels)
  // samples; McpService maps them onto the prom-client registry. Undefined
  // when metrics are disabled → the package no-ops.
  onMetric?: (
    name: string,
    value: number,
    labels?: Record<string, string>,
  ) => void;
};

export interface ResolvedMcpAuth {
  config: DocmostMcpConfig;
  // Opaque identity key bound to the MCP session for anti-fixation, or
  // undefined when no per-user identity applies.
  identity?: string;
}

// Narrow collaborator interfaces so this module never imports the concrete
// TokenService/WorkspaceRepo classes (which drag in the heavy auth/space graph).
// McpService passes its injected instances; tests pass stubs. Decouples the
// testable decision logic from Nest DI wiring.
export interface McpAuthDeps {
  apiUrl: string;
  findWorkspace: () => Promise<{ id: string } | undefined>;
  // Bearer api_key verification. Verifies signature/exp/type AND (in the
  // McpService wiring) the api_key row-check + workspace binding, mirroring
  // jwt.strategy so a revoked/expired/foreign-workspace key is rejected.
  verifyAccessJwt: (token: string) => Promise<{ sub?: string; email?: string }>;
}

/**
 * Constant-time comparison of the optional shared X-MCP-Token guard. A header
 * value may arrive as string | string[] (multiple X-MCP-Token headers), so we
 * normalise to the first string. crypto.timingSafeEqual avoids leaking the
 * token's length via early-exit string comparison; it requires equal buffer
 * lengths, so a length mismatch is treated as a non-match WITHOUT calling
 * timingSafeEqual (which throws on unequal lengths). A non-string / undefined
 * value is never a match.
 *
 * Pure and framework-free so it is unit-testable; McpService.handle delegates to
 * it for the X-MCP-Token shared guard.
 */
export function sharedTokenMatches(
  expected: string,
  provided: string | string[] | undefined,
): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  // Early-return before timingSafeEqual, which throws on unequal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// The decoded payload for the /mcp Bearer allowlist. Carries the `type`
// discriminator and the API-key `apiKeyId`, on top of the base token fields.
export interface McpBearerPayload {
  type?: JwtType;
  sub?: string;
  email?: string;
  workspaceId?: string;
  sessionId?: string;
  apiKeyId?: string;
}

// Minimal structural shape of the TokenService.verifyJwtOneOf method.
export interface OneOfJwtVerifier {
  verifyJwtOneOf: (
    token: string,
    allowed: JwtType[],
  ) => Promise<McpBearerPayload>;
}

/**
 * Bind a TokenService-like verifier into a one-arg `verifyJwtOneOf(token)` that
 * pins the /mcp Bearer ALLOWLIST to exactly {API_KEY}. This is the single place
 * the /mcp Bearer path pins the token type: the /mcp Bearer slot legitimately
 * accepts ONLY an API_KEY token (an agent's key), and NOTHING else — an ACCESS
 * (human session) token, collab/exchange/attachment/etc. are all rejected with
 * the generic type error. The allowlist is fixed here rather than at the call
 * site, and the signature is verified exactly once (see verifyMcpBearer).
 */
export function bindMcpBearerVerifier(
  tokenService: OneOfJwtVerifier,
): (token: string) => Promise<McpBearerPayload> {
  return (token: string) =>
    tokenService.verifyJwtOneOf(token, [JwtType.API_KEY]);
}

// Deps for the /mcp Bearer router. `verifyJwtOneOf` is the one-arg verifier bound
// above (allowlist {API_KEY}); `validateApiKey` is the SHARED api-key row-check.
export interface McpBearerDeps {
  verifyJwtOneOf: (token: string) => Promise<McpBearerPayload>;
  // The workspace id of THIS MCP instance, when the caller can resolve it (the
  // community build is single-workspace, so McpService passes its default
  // workspace's id). When provided, the token's `workspaceId` claim MUST equal
  // it, mirroring jwt.strategy so a valid API_KEY token from a DIFFERENT
  // workspace cannot be replayed against this instance. Optional so callers /
  // tests that genuinely cannot resolve an instance workspace are unchanged.
  expectedWorkspaceId?: string;
  // Row-check for an API_KEY principal — the SAME validator REST uses. Throws
  // UnauthorizedException on a definite deny; PROPAGATES an infra error (→ 5xx),
  // never masking it as a 401.
  validateApiKey: (payload: McpBearerPayload) => Promise<unknown>;
}

/**
 * Verify a /mcp Bearer api_key token and run the shared row-check. The signature
 * is verified EXACTLY ONCE (verifyJwtOneOf, allowlist pinned to {API_KEY}).
 *
 *   - bind to THIS instance's workspace FIRST (a token for another workspace is
 *     rejected before touching the DB), THEN run the shared `validateApiKey`
 *     row-check. No session/login involvement (an API key is not a login).
 *
 * Throws UnauthorizedException on any auth failure (uniform generic message — no
 * enumeration of why); propagates an infra error from `validateApiKey` as itself.
 */
export async function verifyMcpBearer(
  token: string,
  deps: McpBearerDeps,
): Promise<{ sub?: string; email?: string }> {
  const generic = 'Invalid or expired token';
  const payload = await deps.verifyJwtOneOf(token);

  // Defence in depth: the allowlist already pins the type to API_KEY, so a
  // non-API_KEY payload cannot reach here — reject it uniformly if it ever does.
  if (payload.type !== JwtType.API_KEY) {
    throw new UnauthorizedException(generic);
  }
  if (!payload.sub || !payload.workspaceId) {
    throw new UnauthorizedException(generic);
  }
  // Instance-binding: reject an API_KEY token minted for a different workspace
  // before touching the DB.
  if (
    deps.expectedWorkspaceId &&
    payload.workspaceId !== deps.expectedWorkspaceId
  ) {
    throw new UnauthorizedException(generic);
  }
  // Shared row-check. A definite deny throws Unauthorized; an infra error
  // propagates (→ 5xx), which the caller must NOT convert to a 401.
  await deps.validateApiKey(payload);
  return { sub: payload.sub };
}

/**
 * The outcome of McpService.handle's pre-hijack gauntlet, as a pure value the
 * caller acts on. Either send a JSON error with a fixed status (`respond`), or
 * proceed to hijack the response and delegate to the MCP transport (`hijack`).
 * Keeping this a pure decision (no FastifyReply, no res.hijack) makes the
 * status/body mapping unit-testable, and guarantees no error path can leak the
 * token or Authorization header — the body is only ever a fixed string or the
 * UnauthorizedException's own message.
 */
export type McpHandleDecision =
  | { kind: 'respond'; status: number; body: { error: string } }
  | { kind: 'hijack' };

/**
 * Pure mapping of McpService.handle's auth/enablement gauntlet to a response
 * decision. Precedence mirrors handle():
 *   1. shared X-MCP-Token mismatch -> 401 {error:'Unauthorized'} (no hijack).
 *   2. workspace MCP disabled      -> 403 {error:'MCP is disabled ...'}.
 *   3. resolveSessionConfig threw:
 *        - an UnauthorizedException -> 401 with err.message (a SPECIFIC reason;
 *          never the token/header — the message is the only thing surfaced).
 *        - any other error          -> 500 generic 'Internal server error'.
 *   4. otherwise (auth resolved)   -> hijack and delegate to the transport.
 */
export function mapAuthResultToResponse(input: {
  sharedTokenOk: boolean;
  enabled: boolean;
  error?: unknown;
}): McpHandleDecision {
  if (!input.sharedTokenOk) {
    return { kind: 'respond', status: 401, body: { error: 'Unauthorized' } };
  }

  if (!input.enabled) {
    return {
      kind: 'respond',
      status: 403,
      body: { error: 'MCP is disabled for this workspace' },
    };
  }

  if (input.error !== undefined) {
    if (input.error instanceof UnauthorizedException) {
      return {
        kind: 'respond',
        status: 401,
        body: { error: input.error.message },
      };
    }
    return {
      kind: 'respond',
      status: 500,
      body: { error: 'Internal server error' },
    };
  }

  return { kind: 'hijack' };
}

/** Extract a Bearer token from an Authorization header (case-insensitive). */
export function extractBearer(
  authHeader: string | undefined,
): string | undefined {
  const [type, token] = authHeader?.split(' ') ?? [];
  return type?.toLowerCase() === 'bearer' ? token : undefined;
}

/**
 * Pure decision logic for the /mcp per-session identity. /mcp accepts EXACTLY
 * ONE credential: a Bearer api_key JWT.
 *
 *   1. Authorization: Bearer <api_key> -> verify (signature/exp/type + the
 *      shared api-key row-check, wired in `verifyAccessJwt`), run under it.
 *   2. anything else                   -> 401 (api_key only).
 *
 * Throws UnauthorizedException on failure; never returns/logs the token or the
 * Authorization header. Every Bearer auth failure surfaces the SAME generic 401
 * (anti-enumeration); an UNEXPECTED (infra) error is rethrown AS ITSELF so the
 * surface maps it to 5xx, never masking a DB/Redis outage as a bad token.
 */
export async function resolveMcpSessionConfig(
  authHeader: string | undefined,
  deps: McpAuthDeps,
): Promise<ResolvedMcpAuth> {
  const { apiUrl } = deps;

  const bearer = extractBearer(authHeader);
  if (bearer) {
    let payload: { sub?: string; email?: string };
    try {
      payload = await deps.verifyAccessJwt(bearer);
    } catch (err) {
      // Anti-enumeration: EVERY auth failure surfaces the SAME generic 401 —
      // expired/revoked/wrong-type/unknown are indistinguishable to the caller
      // (its reaction is identical either way). But an UNEXPECTED (infra) error
      // is NOT an auth verdict: rethrow it AS ITSELF so the surface maps it to
      // 5xx (mapAuthResultToResponse), never masking a DB/Redis outage as a bad
      // token. verifyMcpBearer throws UnauthorizedException on a definite deny
      // and lets an infra error from validateApiKey propagate.
      if (err instanceof UnauthorizedException) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      throw err;
    }
    return {
      config: { apiUrl, getToken: async () => bearer },
      identity: `bearer:${payload.sub ?? payload.email ?? 'unknown'}`,
    };
  }

  // No usable credential: /mcp requires a Bearer api_key and nothing else.
  throw new UnauthorizedException(
    'MCP requires a Bearer api_key token (Authorization: Bearer <api_key>).',
  );
}

// Re-export JwtType so callers binding `verifyAccessJwt` know which type to
// enforce, without importing it separately.
export { JwtType };
