import { createServer, Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { getMetricsRegistry, isMetricsEnabled } from './metrics.registry';

/**
 * Start the Prometheus scrape endpoint on a SEPARATE port, taken from
 * `METRICS_PORT`. There is NO default port: when `METRICS_PORT` is unset the
 * whole metrics subsystem is OFF and this returns null. This is a bare node:http
 * server, NOT part of the Fastify app, so `/metrics` never exists on the public
 * :3000 listener.
 *
 * Returns the http.Server (so callers can close it on shutdown) or null when
 * metrics are disabled. The reference is also kept module-side so the Nest
 * lifecycle (see MetricsModule) can close it on application shutdown without
 * threading the handle back through the non-DI bootstrap.
 */
let metricsServer: Server | null = null;

export function startMetricsServer(): Server | null {
  if (!isMetricsEnabled()) return null;

  const logger = new Logger('MetricsServer');
  const register = getMetricsRegistry();
  if (!register) return null;

  const port = Number(process.env.METRICS_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    logger.warn(
      `Invalid METRICS_PORT="${process.env.METRICS_PORT}", metrics endpoint not started`,
    );
    return null;
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        const body = await register.metrics();
        res.setHeader('Content-Type', register.contentType);
        res.statusCode = 200;
        res.end(body);
      } catch (err) {
        res.statusCode = 500;
        res.end(String((err as Error)?.message ?? 'error'));
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  // Bind on all interfaces: the scraper (VictoriaMetrics) reaches this from
  // another container as docmost:9464. The port is not published to the host.
  server.listen(port, '0.0.0.0', () => {
    logger.log(`Metrics endpoint listening on :${port}/metrics`);
  });

  server.on('error', (err) => {
    logger.error(`Metrics server error: ${err?.message}`);
  });

  metricsServer = server;
  return server;
}

/**
 * Close the metrics scrape server if one is running. Idempotent and safe to call
 * when metrics are disabled (no server was ever started). Wired into Nest's
 * shutdown lifecycle so the listener is not left dangling on shutdown.
 */
export function closeMetricsServer(): Promise<void> {
  const server = metricsServer;
  metricsServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
