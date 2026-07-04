import { FastifyReply, FastifyRequest } from 'fastify';
import { isStreamingResponse } from './metrics.constants';
import { observeHttp } from './metrics.registry';

/**
 * Resolve the BOUNDED route label for an HTTP response.
 *
 * HARD REQUIREMENT (#355): use the ROUTE TEMPLATE (`/pages/:id`), NEVER the raw
 * URL (`/pages/abc-123`), so label cardinality stays finite. Fastify exposes the
 * matched template on `req.routeOptions.url`. On 404s (no route matched) that is
 * missing → collapse to the literal `unknown`.
 */
export function resolveRouteLabel(req: FastifyRequest): string {
  const url = req.routeOptions?.url;
  return typeof url === 'string' && url.length > 0 ? url : 'unknown';
}

/**
 * Fastify onResponse handler that records http_request_duration_seconds.
 * No-op when metrics are disabled (the hook is only registered when enabled,
 * but the observe helpers are also guarded). Never throws into the response
 * pipeline — telemetry must not break request handling.
 */
export function recordHttpResponse(
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  try {
    const route = resolveRouteLabel(req);

    // Exclude SSE/streaming responses: onResponse fires at connection close for
    // those, so it would record the stream lifetime and poison p95/p99.
    const contentType = reply.getHeader('content-type');
    if (isStreamingResponse(contentType, route)) return;

    observeHttp(
      req.method,
      route,
      reply.statusCode,
      // Fastify measures elapsed time in ms; the metric is in seconds.
      reply.elapsedTime / 1000,
    );
  } catch {
    // Swallow: a telemetry failure must never affect the served response.
  }
}
