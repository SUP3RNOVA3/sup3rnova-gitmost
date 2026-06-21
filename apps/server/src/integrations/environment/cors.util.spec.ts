import { buildCorsAllowlist, isOriginAllowed } from './cors.util';

const WEBVIEW_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
];

describe('isOriginAllowed', () => {
  const allowlist = buildCorsAllowlist({
    appUrl: 'https://app.example',
    configuredOrigins: ['https://other.example'],
  });

  it('allows requests with no Origin header', () => {
    expect(isOriginAllowed(undefined, allowlist)).toBe(true);
    expect(isOriginAllowed('', allowlist)).toBe(true);
  });

  it('allows an exact allowlisted origin', () => {
    expect(isOriginAllowed('https://app.example', allowlist)).toBe(true);
    expect(isOriginAllowed('https://other.example', allowlist)).toBe(true);
  });

  it('allows each native WebView origin', () => {
    for (const origin of WEBVIEW_ORIGINS) {
      expect(isOriginAllowed(origin, allowlist)).toBe(true);
    }
  });

  it('rejects a foreign credentialed origin', () => {
    // With credentials:true a foreign credentialed origin must be rejected.
    expect(isOriginAllowed('https://evil.example', allowlist)).toBe(false);
  });

  it('rejects a trailing-slash mismatch', () => {
    expect(isOriginAllowed('https://app.example/', allowlist)).toBe(false);
  });

  it('rejects a host-case mismatch', () => {
    expect(isOriginAllowed('https://APP.example', allowlist)).toBe(false);
  });

  it('allows no-Origin but rejects cross-origin with an empty allowlist', () => {
    const empty: ReadonlySet<string> = new Set<string>();
    expect(isOriginAllowed(undefined, empty)).toBe(true);
    expect(isOriginAllowed('https://app.example', empty)).toBe(false);
  });
});

describe('buildCorsAllowlist', () => {
  it('contains the app URL, each configured origin, and all WebView origins', () => {
    const allowlist = buildCorsAllowlist({
      appUrl: 'https://app.example',
      configuredOrigins: ['https://a.example', 'https://b.example'],
    });

    expect(allowlist.has('https://app.example')).toBe(true);
    expect(allowlist.has('https://a.example')).toBe(true);
    expect(allowlist.has('https://b.example')).toBe(true);
    for (const origin of WEBVIEW_ORIGINS) {
      expect(allowlist.has(origin)).toBe(true);
    }
  });

  it('deduplicates when a configured origin coincides with the app URL', () => {
    const allowlist = buildCorsAllowlist({
      appUrl: 'https://app.example',
      configuredOrigins: ['https://app.example'],
    });

    // app URL + 4 WebView origins, the duplicate configured origin collapses.
    expect(allowlist.size).toBe(1 + WEBVIEW_ORIGINS.length);
  });

  it('always includes the four WebView origins even with no configured origins', () => {
    const allowlist = buildCorsAllowlist({
      appUrl: 'https://app.example',
      configuredOrigins: [],
    });

    for (const origin of WEBVIEW_ORIGINS) {
      expect(allowlist.has(origin)).toBe(true);
    }
  });
});
