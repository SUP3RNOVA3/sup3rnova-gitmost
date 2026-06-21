// CORS trust boundary helpers. `buildCorsAllowlist` produces the exact set of
// origins the API trusts, and `isOriginAllowed` is the predicate the enableCors
// origin callback uses to accept/reject each request. With credentials:true a
// foreign credentialed origin must never be allowed, so anything not in the
// allowlist (apart from no-Origin requests) is rejected.

// Native WebView origins used by the Capacitor/Ionic mobile shell. Always
// trusted so the native client can call the API. CORS hardening of these is
// intentionally out of scope.
const NATIVE_WEBVIEW_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
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
