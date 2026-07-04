/**
 * Perf-metrics contract (#355). These names/labels are FIXED by the already
 * deployed scrape+dashboard infra (VictoriaMetrics scraping docmost:9464,
 * Grafana dashboards, alerts). Do NOT rename them.
 */
export const METRIC_HTTP_REQUEST_DURATION = 'http_request_duration_seconds';
export const METRIC_DB_QUERY_DURATION = 'db_query_duration_seconds';
export const METRIC_BULLMQ_QUEUE_DEPTH = 'bullmq_queue_depth';
export const METRIC_BULLMQ_JOB_DURATION = 'bullmq_job_duration_seconds';
export const METRIC_COLLAB_STORE_DURATION = 'collab_store_duration_seconds';

// Histogram buckets (seconds). Chosen to give useful p50/p95/p99 resolution
// for typical web/DB latencies without exploding series cardinality.
export const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
export const DB_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];
export const COLLAB_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
export const JOB_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

/**
 * Extract the first SQL token (select/insert/update/delete/...) from a query,
 * lower-cased, to use as a BOUNDED label for db_query_duration_seconds. Using
 * the full query text would blow up label cardinality; the leading keyword is a
 * finite set. Unknown/empty queries collapse to `other`.
 */
export function firstSqlToken(sql: string | undefined): string {
  if (!sql) return 'other';
  // Skip leading whitespace / comments and grab the first word.
  const match = /^[\s(]*([a-zA-Z]+)/.exec(sql);
  if (!match) return 'other';
  const token = match[1].toLowerCase();
  const known = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'with',
    'begin',
    'commit',
    'rollback',
    'alter',
    'create',
    'drop',
    'truncate',
    'explain',
  ]);
  return known.has(token) ? token : 'other';
}

/**
 * Whether an HTTP response must be EXCLUDED from http_request_duration_seconds.
 *
 * SSE/streaming responses (the AI-chat `text/event-stream`) keep the connection
 * open for the whole conversation, so Fastify's onResponse fires only when the
 * client disconnects — recording the connection lifetime, not a response time,
 * which would poison p95/p99. We skip by content-type (authoritative) with a
 * route-suffix fallback for the two known stream endpoints.
 */
export function isStreamingResponse(
  contentType: unknown,
  route: string | undefined,
): boolean {
  if (
    typeof contentType === 'string' &&
    contentType.toLowerCase().includes('text/event-stream')
  ) {
    return true;
  }
  // Fallback: the AI-chat stream routes (/api/ai-chat/stream,
  // /api/shares/ai/stream) both end in `/stream`.
  if (route && route.endsWith('/stream')) return true;
  return false;
}
