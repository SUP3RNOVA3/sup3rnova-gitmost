import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { join } from 'path';
import * as fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { EnvironmentService } from '../environment/environment.service';
import { resolveClientDistPath } from '../../common/helpers/client-version';

/**
 * Resolve the response headers for a statically served client asset.
 *
 * Extracted from the @fastify/static `setHeaders` callback so the cache
 * classification stays a pure, unit-testable function (see
 * static.module.spec.ts).
 *
 * `Vary: Accept-Encoding` is emitted for every static response because
 * @fastify/static negotiates a precompressed .br/.gz neighbour by the client's
 * Accept-Encoding but does NOT set Vary itself. Without it a shared/proxy cache
 * keyed on the URL alone could store the brotli variant and later serve it to a
 * client that only sent `Accept-Encoding: identity`/gzip → an undecodable body.
 * This matters most for the immutable /assets/ files, which proxies may keep
 * for a year.
 */
export function resolveStaticAssetHeaders(
  filePath: string,
): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Accept-Encoding' };

  // Content-hashed files under /assets/ never change for a given URL, so they
  // can be cached forever and skip revalidation entirely.
  if (filePath.includes('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
    return headers;
  }

  // index.html is rewritten at boot (window.CONFIG injection) and on every
  // deploy — it must be revalidated on every load.
  if (filePath.endsWith('index.html')) {
    headers['cache-control'] = 'no-cache, no-store, must-revalidate';
    return headers;
  }

  // Everything else (locales, vad, icons, manifest) is NOT content-hashed and
  // changes between deploys, so it keeps @fastify/static's default
  // etag/last-modified revalidation — do NOT mark it immutable.
  return headers;
}

@Module({})
export class StaticModule implements OnModuleInit {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly environmentService: EnvironmentService,
  ) {}

  public async onModuleInit() {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();

    const clientDistPath = resolveClientDistPath();

    const indexFilePath = join(clientDistPath, 'index.html');

    if (fs.existsSync(clientDistPath) && fs.existsSync(indexFilePath)) {
      const indexTemplateFilePath = join(clientDistPath, 'index-template.html');
      const windowVar = '<!--window-config-->';

      const configString = {
        ENV: this.environmentService.getNodeEnv(),
        APP_URL: this.environmentService.getAppUrl(),
        CLOUD: this.environmentService.isCloud(),
        COMPACT_PAGE_TREE: this.environmentService.isCompactPageTreeEnabled(),
        FILE_UPLOAD_SIZE_LIMIT:
          this.environmentService.getFileUploadSizeLimit(),
        FILE_IMPORT_SIZE_LIMIT:
          this.environmentService.getFileImportSizeLimit(),
        DRAWIO_URL: this.environmentService.getDrawioUrl(),
        SUBDOMAIN_HOST: this.environmentService.isCloud()
          ? this.environmentService.getSubdomainHost()
          : undefined,
        COLLAB_URL: this.environmentService.getCollabUrl(),
        BILLING_TRIAL_DAYS: this.environmentService.isCloud()
          ? this.environmentService.getBillingTrialDays()
          : undefined,
        POSTHOG_HOST: this.environmentService.getPostHogHost(),
        POSTHOG_KEY: this.environmentService.getPostHogKey(),
        // #355 — mirrors the server-side CLIENT_TELEMETRY_ENABLED gate so the
        // client only collects/sends vitals when the operator opts in.
        CLIENT_TELEMETRY_ENABLED:
          this.environmentService.isClientTelemetryEnabled(),
        // #563 — mirrors LOCAL_FIRST_ENABLED so the client's page-meta boot
        // cache (instant chrome) is only active when the operator opts in.
        LOCAL_FIRST_ENABLED: this.environmentService.isLocalFirstEnabled(),
      };

      const windowScriptContent = `<script>window.CONFIG=${JSON.stringify(configString)};</script>`;

      if (!fs.existsSync(indexTemplateFilePath)) {
        fs.copyFileSync(indexFilePath, indexTemplateFilePath);
      }

      const html = fs.readFileSync(indexTemplateFilePath, 'utf8');
      const transformedHtml = html.replace(windowVar, windowScriptContent);

      fs.writeFileSync(indexFilePath, transformedHtml);

      const RENDER_PATH = '*';

      await app.register(fastifyStatic, {
        root: clientDistPath,
        wildcard: false,
        // Serve the build-time .br/.gz neighbour when the client accepts it
        // (see vite-plugin-compression2 in apps/client/vite.config.ts).
        preCompressed: true,
        // @fastify/static's default cacheControl:true writes its own
        // Cache-Control (from maxAge, default 0) AFTER the setHeaders callback,
        // silently overwriting the immutable header that resolveStaticAssetHeaders
        // sets — disable it so setHeaders/resolveStaticAssetHeaders own the header.
        cacheControl: false,
        setHeaders: (res, filePath) => {
          for (const [name, value] of Object.entries(
            resolveStaticAssetHeaders(filePath),
          )) {
            res.setHeader(name, value);
          }
        },
      });

      app.get(RENDER_PATH, (req: any, res: any) => {
        const stream = fs.createReadStream(indexFilePath);
        res
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .type('text/html')
          .send(stream);
      });
    }
  }
}
