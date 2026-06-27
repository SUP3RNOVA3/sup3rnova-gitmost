import { jwtDecode } from "jwt-decode";

/**
 * Decide whether a collab token must be refreshed before reconnecting after an
 * onAuthenticationFailed event. Pure and side-effect free so the four token
 * states can be unit-tested directly:
 *   - no token              -> true  (fetch a fresh one and reconnect)
 *   - undecodable/malformed -> true  (jwtDecode throws -> refresh)
 *   - valid, not expired    -> false (token is still good; do NOT reconnect)
 *   - valid, expired        -> true  (refresh + reconnect)
 *
 * `nowMs` is injectable for deterministic tests; it defaults to `Date.now()`.
 */
export function collabTokenNeedsRefresh(
  token: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!token) return true;
  try {
    const payload = jwtDecode<{ exp: number }>(token);
    return nowMs / 1000 >= payload.exp;
  } catch {
    // malformed/undecodable token -> refresh
    return true;
  }
}
