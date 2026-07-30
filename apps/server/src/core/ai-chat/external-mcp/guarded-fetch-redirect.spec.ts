// Neutralize the SSRF host guard so the INITIAL request to a loopback stub is
// allowed (loopback is normally blocked by the pre-flight). This isolates the
// property under test: guardedFetch must FORCE redirect:'error' so a server-side
// 3xx to an internal address is NEVER followed on a fresh, unpinned socket.
jest.mock('./ssrf-guard', () => ({
  isUrlAllowed: async () => ({ ok: true }),
  isIpAllowed: () => ({ ok: true }),
}));

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildPinnedDispatcher, guardedFetch } from './guarded-fetch';

/**
 * #699 HIGH (SSRF): the OAuth discovery/DCR/exchange/refresh calls (and the MCP
 * transport) all go through guardedFetch. Only the INITIAL URL is pre-flighted,
 * and undici skips the pinning connect.lookup for an IP-literal host — so a
 * `302 Location: http://169.254.169.254/…` would let fetch open a fresh, UNPINNED
 * socket to an internal address and leak the refresh POST body. The fix forces
 * `redirect:'error'` inside guardedFetch (after the spread, uncaller-overridable),
 * so any redirect REJECTS instead of being followed.
 */
describe('guardedFetch forces redirect:error (SSRF redirect-to-internal defense)', () => {
  let server: Server;
  let redirectHits = 0;
  let followTarget = 'http://169.254.169.254/latest/meta-data';
  let base: string;
  const dispatcher = buildPinnedDispatcher(2000);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        redirectHits += 1;
        res.writeHead(302, { Location: followTarget });
        res.end();
        return;
      }
      // A benign endpoint the test can redirect to (so "followed" is observable
      // as a 200 rather than a network error, proving the test would RED without
      // the fix — i.e. the redirect WAS followed).
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('followed');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    redirectHits = 0;
  });

  it('REJECTS a 302 that points at an internal IP literal (does not follow)', async () => {
    followTarget = 'http://169.254.169.254/latest/meta-data';
    await expect(
      guardedFetch(dispatcher, `${base}/redirect`),
    ).rejects.toThrow();
    // The redirect WAS served once, but never followed (redirect:'error').
    expect(redirectHits).toBe(1);
  });

  it('REJECTS a 302 even when it points back at the SAME (allowed) origin', async () => {
    // Proves the enforcement is "no redirects", not "no cross-origin redirects":
    // without the fix this would resolve to 200 "followed" (the RED-without-fix
    // signal); with the fix it rejects.
    followTarget = `${base}/benign`;
    await expect(
      guardedFetch(dispatcher, `${base}/redirect`),
    ).rejects.toThrow();
  });

  it('a direct (non-redirecting) request still succeeds through the guard', async () => {
    const res = await guardedFetch(dispatcher, `${base}/benign`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('followed');
  });
});
