// CORS trust boundary helpers. `buildCorsAllowlist` produces the exact set of
// origins the API trusts, and `isOriginAllowed` is the predicate the enableCors
// origin callback uses to accept/reject each request. With credentials:true a
// foreign credentialed origin must never be allowed, so anything not in the
// allowlist (apart from no-Origin requests) is rejected.

// Native WebView origins used by the Capacitor/Ionic mobile shell. Always
// trusted so the native client can call the API.
//
//   - `capacitor://localhost` — iOS native custom scheme.
//   - `ionic://localhost`     — legacy native custom scheme.
//   - `https://localhost`     — Android default secure scheme.
//
// The cleartext `http://localhost` origin is intentionally NOT trusted: the
// Capacitor shell uses the secure scheme (capacitor.config.ts sets
// `cleartext: false` and does not override `androidScheme`, so Capacitor's
// default Android scheme is `https` => origin `https://localhost`), and iOS runs
// in hosted mode (`server.url` = CAP_SERVER_URL, whose origin is the app URL
// already in the allowlist). No native client legitimately uses
// `http://localhost`, so allowing it would only widen the credentialed-CORS
// surface to arbitrary local http content.
const NATIVE_WEBVIEW_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
] as const;

// Build the CORS allowlist: the app URL, all configured cross-origin clients,
// and the native WebView origins. Dedup is automatic via Set.
export function buildCorsAllowlist(input: {
  appUrl: string;
  configuredOrigins: readonly string[];
}): Set<string> {
  return new Set<string>([
    input.appUrl,
    ...input.configuredOrigins,
    ...NATIVE_WEBVIEW_ORIGINS,
  ]);
}

// Decide whether a request's Origin is allowed. A missing Origin header (curl,
// server-to-server, some native WebViews) is allowed; otherwise the origin must
// be present in the allowlist.
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: ReadonlySet<string>,
): boolean {
  if (!origin) return true;
  return allowlist.has(origin);
}
