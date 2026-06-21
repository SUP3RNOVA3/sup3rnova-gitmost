/**
 * Canonical service-worker routing predicates.
 *
 * IMPORTANT: With vite-plugin-pwa using Workbox `generateSW`, the
 * `runtimeCaching[].urlPattern` functions are serialized standalone into the
 * generated service worker and CANNOT reference imported symbols. The matching
 * logic is therefore duplicated as inline regex literals in
 * apps/client/vite.config.ts. This module is the testable source of truth, and
 * the two MUST be kept in sync. This duplication is intentional and is the
 * documented Workbox limitation.
 *
 * Matching is anchored to a path SEGMENT boundary (`^/<seg>(/|$)`) so that
 * sibling paths like `/apidocs`, `/collaborators`, `/socket.iox` are NOT
 * wrongly treated as API/realtime traffic.
 */

/**
 * True when `pathname` is the `/api` segment or anything beneath it.
 * `/api` and `/api/...` -> true; `/apidocs`, `/apixyz` -> false.
 */
export function isApiPath(pathname: string): boolean {
  return /^\/api(\/|$)/.test(pathname);
}

/**
 * True when `pathname` is the `/collab` or `/socket.io` segment (or beneath it).
 * `/collab`, `/collab/x`, `/socket.io`, `/socket.io/abc` -> true;
 * `/collaborators`, `/collabx`, `/socket.iox` -> false.
 */
export function isCollabOrSocketPath(pathname: string): boolean {
  return /^\/(collab|socket\.io)(\/|$)/.test(pathname);
}
