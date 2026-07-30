/**
 * Typed OAuth-grant failures raised by the runtime token path (#687), so the
 * connect gate in `mcp-clients.service.ts` can map them to the precise
 * per-server outcome the user sees (`auth-expired` / `auth-unavailable`) instead
 * of a generic reason (AGENTS #10 — loud and specific).
 *
 * The server/workspace ids ride along for a NON-secret operator log line; tokens
 * and the code_verifier are NEVER carried on these errors.
 */

/**
 * Our own refresh got an explicit `invalid_grant` / `invalid_client` from the
 * token endpoint — the refresh token is dead. The grant has already been moved
 * to `expired`; the turn skips the server with `auth-expired`.
 */
export class McpGrantExpiredError extends Error {
  constructor(
    readonly serverId?: string,
    readonly workspaceId?: string,
  ) {
    super('external MCP OAuth grant expired (re-authorization required)');
    this.name = 'McpGrantExpiredError';
  }
}

/**
 * Our own refresh could not complete for a TRANSIENT reason (network, timeout,
 * 5xx AS) — the grant stays `connected` and the turn skips the server with
 * `auth-unavailable`; the next turn retries. NEVER forces a re-consent.
 */
export class McpGrantUnavailableError extends Error {
  constructor(
    readonly serverId?: string,
    readonly workspaceId?: string,
  ) {
    super('external MCP OAuth token temporarily unavailable');
    this.name = 'McpGrantUnavailableError';
  }
}

/**
 * Walk an error's `.cause` chain (bounded depth) looking for one of our typed
 * grant errors — @ai-sdk/mcp may wrap a thrown `tokens()` error before it
 * surfaces at the connect site, so a bare `instanceof` on the top-level error is
 * not enough.
 */
export function classifyGrantError(
  err: unknown,
  depth = 0,
): 'expired' | 'unavailable' | undefined {
  if (!err || typeof err !== 'object' || depth > 6) return undefined;
  if (err instanceof McpGrantExpiredError) return 'expired';
  if (err instanceof McpGrantUnavailableError) return 'unavailable';
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null) return classifyGrantError(cause, depth + 1);
  return undefined;
}
