import { createServer, Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { getMetricsRegistry, isMetricsEnabled } from './metrics.registry';

/**
 * Start the Prometheus scrape endpoint on a SEPARATE port (default 9464,
 * overridable via `METRICS_PORT`). This is a bare node:http server, NOT part of
 * the Fastify app, so `/metrics` never exists on the public :3000 listener.
 *
 * Returns the http.Server (so callers can close it on shutdown) or null when
 * metrics are disabled.
 */
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

  return server;
}
