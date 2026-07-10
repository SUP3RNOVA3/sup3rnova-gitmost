import { resolveStaticAssetHeaders } from './static.module';

// Unit tests for the static-asset cache classifier extracted from the
// @fastify/static setHeaders callback (precedent: sandbox.controller.spec.ts).
describe('resolveStaticAssetHeaders', () => {
  it('marks a content-hashed /assets/ file immutable and sets Vary', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/assets/index-a1b2c3.js',
    );
    expect(headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('makes index.html always revalidate (never immutable)', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/index.html',
    );
    expect(headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate',
    );
    expect(headers['vary']).toBe('Accept-Encoding');
  });

  it('does NOT mark a non-hashed asset immutable but still sets Vary', () => {
    const headers = resolveStaticAssetHeaders(
      '/app/apps/client/dist/locales/en.json',
    );
    // No immutable cache-control — this path keeps @fastify/static's default
    // etag/last-modified revalidation.
    expect(headers['cache-control']).toBeUndefined();
    expect(headers['vary']).toBe('Accept-Encoding');
  });
});
