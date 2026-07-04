import {
  collectDefaultMetrics,
  Histogram,
  Gauge,
  Registry,
} from 'prom-client';
import {
  COLLAB_BUCKETS,
  DB_BUCKETS,
  HTTP_BUCKETS,
  JOB_BUCKETS,
  METRIC_BULLMQ_JOB_DURATION,
  METRIC_BULLMQ_QUEUE_DEPTH,
  METRIC_COLLAB_STORE_DURATION,
  METRIC_DB_QUERY_DURATION,
  METRIC_HTTP_REQUEST_DURATION,
} from './metrics.constants';

/**
 * Process-wide perf-metrics registry (#355).
 *
 * This is a plain module singleton (NOT a Nest provider) because the collectors
 * are cross-cutting: the Kysely `log` callback (built in a DI factory), the
 * Fastify onResponse hook (main.ts, before the Nest container hands out
 * providers) and the collab persistence extension all need the SAME instruments
 * without threading DI through them.
 *
 * HARD CONTRACT: when `METRICS_PORT` is unset the whole subsystem is OFF — the
 * registry is never created, `collectDefaultMetrics` never runs, and every
 * observe/set helper is a cheap no-op. Nothing is exposed on :3000.
 */

// Decided once at process start. Deliberately read here (not via
// EnvironmentService) so the toggle is identical for the DI and non-DI callers.
const enabled = Boolean(process.env.METRICS_PORT);

let registry: Registry | null = null;
let httpHist: Histogram<'method' | 'route' | 'status'> | null = null;
let dbHist: Histogram<'op'> | null = null;
let queueDepthGauge: Gauge<'queue'> | null = null;
let jobHist: Histogram<'queue'> | null = null;
let collabHist: Histogram | null = null;

function init(): void {
  if (registry || !enabled) return;

  registry = new Registry();

  // Node/runtime metrics: gives nodejs_eventloop_lag_p99_seconds, GC, heap, etc.
  collectDefaultMetrics({ register: registry });

  httpHist = new Histogram({
    name: METRIC_HTTP_REQUEST_DURATION,
    help: 'HTTP request duration in seconds, by method, route template and status',
    labelNames: ['method', 'route', 'status'],
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });

  dbHist = new Histogram({
    name: METRIC_DB_QUERY_DURATION,
    help: 'Database query duration in seconds, by leading SQL keyword',
    labelNames: ['op'],
    buckets: DB_BUCKETS,
    registers: [registry],
  });

  queueDepthGauge = new Gauge({
    name: METRIC_BULLMQ_QUEUE_DEPTH,
    help: 'Number of not-yet-finished BullMQ jobs per queue',
    labelNames: ['queue'],
    registers: [registry],
  });

  jobHist = new Histogram({
    name: METRIC_BULLMQ_JOB_DURATION,
    help: 'BullMQ job processing duration in seconds, per queue',
    labelNames: ['queue'],
    buckets: JOB_BUCKETS,
    registers: [registry],
  });

  collabHist = new Histogram({
    name: METRIC_COLLAB_STORE_DURATION,
    help: 'Collaboration onStoreDocument duration in seconds',
    buckets: COLLAB_BUCKETS,
    registers: [registry],
  });
}

// Runs once when this module is first imported. Safe to call again (idempotent).
init();

export function isMetricsEnabled(): boolean {
  return enabled;
}

/** The prom-client registry, or null when metrics are disabled. */
export function getMetricsRegistry(): Registry | null {
  return registry;
}

export function observeHttp(
  method: string,
  route: string,
  status: number,
  seconds: number,
): void {
  httpHist?.observe({ method, route, status }, seconds);
}

export function observeDbQuery(op: string, seconds: number): void {
  dbHist?.observe({ op }, seconds);
}

export function setQueueDepth(queue: string, depth: number): void {
  queueDepthGauge?.set({ queue }, depth);
}

export function observeJobDuration(queue: string, seconds: number): void {
  jobHist?.observe({ queue }, seconds);
}

export function observeCollabStore(seconds: number): void {
  collabHist?.observe(seconds);
}
