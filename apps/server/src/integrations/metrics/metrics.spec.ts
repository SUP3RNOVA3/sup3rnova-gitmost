import { FastifyRequest } from 'fastify';
import { resolveRouteLabel } from './http-metrics.hook';
import { firstSqlToken, isStreamingResponse } from './metrics.constants';

describe('resolveRouteLabel (histogram route label)', () => {
  it('uses the ROUTE TEMPLATE, never the raw URL', () => {
    // routeOptions.url is the matched template; url is the raw path with the id.
    const req = {
      url: '/api/pages/abc-123-def',
      routeOptions: { url: '/api/pages/:id' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('/api/pages/:id');
    expect(resolveRouteLabel(req)).not.toContain('abc-123-def');
  });

  it('falls back to "unknown" on a 404 (no matched route template)', () => {
    const req = {
      url: '/totally/unmatched/path',
      routeOptions: {},
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('unknown');
  });

  it('falls back to "unknown" when routeOptions is missing', () => {
    const req = { url: '/x' } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('unknown');
  });

  it.each([
    '/assets/index-CAbxDtto.js',
    '/assets/chunk-3OPIFGDE-CJOt9nr5.js',
    '/assets/excalidraw-menu-DpsI0kFW.js',
    '/vad/silero_vad_v5.onnx',
    '/brand/logo.svg',
    '/locales/en.json',
  ])('collapses hashed/static asset %p to "static" (#362 cardinality)', (url) => {
    // @fastify/static serves each file through a route whose matched url is the
    // raw (hashed) file path, so routeOptions.url is itself unbounded here.
    const req = {
      url,
      routeOptions: { url },
    } as unknown as FastifyRequest;
    const label = resolveRouteLabel(req);
    expect(label).toBe('static');
    expect(label).not.toContain('.js');
    expect(label).not.toContain('index-');
  });

  it('strips the query string before the static-prefix check', () => {
    const req = {
      url: '/assets/index-CAbxDtto.js?v=2',
      routeOptions: { url: '/assets/index-CAbxDtto.js' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('static');
  });

  it('does NOT collapse a real API route that merely mentions assets', () => {
    // A templated API route is kept as-is; only the static path PREFIXES collapse.
    const req = {
      url: '/api/pages/assets-guide',
      routeOptions: { url: '/api/pages/:id' },
    } as unknown as FastifyRequest;
    expect(resolveRouteLabel(req)).toBe('/api/pages/:id');
  });
});

describe('isStreamingResponse (SSE exclusion)', () => {
  it('excludes text/event-stream responses by content-type', () => {
    expect(isStreamingResponse('text/event-stream', '/api/ai-chat/stream')).toBe(
      true,
    );
    expect(isStreamingResponse('text/event-stream; charset=utf-8', '/x')).toBe(
      true,
    );
  });

  it('excludes known /stream routes by suffix as a fallback', () => {
    expect(isStreamingResponse('application/json', '/api/ai-chat/stream')).toBe(
      true,
    );
    expect(isStreamingResponse(undefined, '/api/shares/ai/stream')).toBe(true);
  });

  it('does not exclude ordinary JSON responses', () => {
    expect(isStreamingResponse('application/json', '/api/pages/:id')).toBe(
      false,
    );
    expect(isStreamingResponse(undefined, '/api/pages/:id')).toBe(false);
  });
});

describe('firstSqlToken (bounded db label)', () => {
  it('returns the lower-cased leading keyword', () => {
    expect(firstSqlToken('SELECT * FROM pages')).toBe('select');
    expect(firstSqlToken('  insert into x values (1)')).toBe('insert');
    expect(firstSqlToken('UPDATE pages SET a=1')).toBe('update');
    expect(firstSqlToken('delete from pages')).toBe('delete');
    expect(firstSqlToken('(SELECT 1)')).toBe('select');
  });

  it('collapses unknown/empty queries to "other"', () => {
    expect(firstSqlToken('')).toBe('other');
    expect(firstSqlToken(undefined)).toBe('other');
    expect(firstSqlToken('123 not sql')).toBe('other');
    expect(firstSqlToken('vacuum analyze')).toBe('other');
  });
});
