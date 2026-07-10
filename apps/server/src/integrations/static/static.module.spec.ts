import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
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

// Integration test proving the ACTUAL response header emitted by @fastify/static
// with the exact registration options StaticModule uses. This is the regression
// guard for #452: without `cacheControl: false`, @fastify/static writes its own
// `Cache-Control: public, max-age=0` AFTER the setHeaders callback, overwriting
// the immutable header — the /assets/ assertion below would then fail.
describe('static.module @fastify/static registration (integration)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'static-module-spec-'));
    fs.mkdirSync(join(tmpDir, 'assets'), { recursive: true });
    fs.mkdirSync(join(tmpDir, 'locales'), { recursive: true });
    fs.writeFileSync(
      join(tmpDir, 'assets', 'index-a1b2c3.js'),
      'console.log(1);',
    );
    fs.writeFileSync(join(tmpDir, 'locales', 'en.json'), '{"hello":"world"}');

    app = Fastify();
    // Mirror StaticModule.onModuleInit's registration options exactly.
    await app.register(fastifyStatic, {
      root: tmpDir,
      wildcard: false,
      preCompressed: true,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        for (const [name, value] of Object.entries(
          resolveStaticAssetHeaders(filePath),
        )) {
          res.setHeader(name, value);
        }
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves a hashed /assets/ file with an immutable, 1-year cache-control', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/assets/index-a1b2c3.js',
    });
    expect(res.statusCode).toBe(200);
    const cacheControl = res.headers['cache-control'];
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });

  it('serves a non-hashed /locales/ file WITHOUT an immutable cache-control', async () => {
    const res = await app.inject({ method: 'GET', url: '/locales/en.json' });
    expect(res.statusCode).toBe(200);
    // resolveStaticAssetHeaders sets no cache-control here and cacheControl:false
    // stops @fastify/static from adding one, so the browser revalidates by
    // etag/last-modified — either an absent header or one without `immutable`.
    const cacheControl = res.headers['cache-control'];
    if (cacheControl !== undefined) {
      expect(cacheControl).not.toContain('immutable');
    }
  });
});
