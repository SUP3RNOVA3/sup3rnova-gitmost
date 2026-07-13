import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Registry,
} from 'prom-client';
import {
  COLLAB_BUCKETS,
  DB_BUCKETS,
  HTTP_BUCKETS,
  JOB_BUCKETS,
  MCP_TOOL_BUCKETS,
  METRIC_BULLMQ_JOB_DURATION,
  METRIC_BULLMQ_QUEUE_DEPTH,
  METRIC_COLLAB_AUTH_DURATION,
  METRIC_COLLAB_CONNECT_DURATION,
  METRIC_COLLAB_CONNECT_TIMEOUTS_TOTAL,
  METRIC_COLLAB_DOC_LOADS_TOTAL,
  METRIC_COLLAB_DOC_UNLOADS_TOTAL,
  METRIC_COLLAB_DOCS_OPEN,
  METRIC_COLLAB_LOAD_DURATION,
  METRIC_COLLAB_STORE_DURATION,
  METRIC_DB_QUERY_DURATION,
  METRIC_HTTP_REQUEST_DURATION,
  METRIC_MCP_TOOL_DURATION,
  METRIC_MCP_GETPAGE_CACHE_HITS_TOTAL,
  METRIC_MCP_GETPAGE_CACHE_MISSES_TOTAL,
  METRIC_API_KEY_AUTH_DENIED_TOTAL,
  sizeBucket,
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
// #402 — collab store now carries a size_bucket label (see sizeBucket()).
let collabHist: Histogram<'size_bucket'> | null = null;
// #402 collab-lifecycle + MCP instruments.
let collabLoadHist: Histogram<'size_bucket'> | null = null;
let docsOpenGauge: Gauge | null = null;
let docLoadsCounter: Counter | null = null;
let docUnloadsCounter: Counter | null = null;
let connectTimeoutsCounter: Counter | null = null;
let collabConnectHist: Histogram | null = null;
let collabAuthHist: Histogram | null = null;
let mcpToolHist: Histogram<'tool'> | null = null;
// #479 — getPage conversion-cache hit/miss counters.
let getPageCacheHitsCounter: Counter | null = null;
let getPageCacheMissesCounter: Counter | null = null;
// #558 — api-key auth denials, by bounded reason label.
let apiKeyAuthDeniedCounter: Counter<'reason'> | null = null;

// #402 — read-on-scrape source for collab_docs_open. The gauge is NEVER
// inc/dec'd (that drifts under crashes/handoffs); instead its collect() callback
// pulls the authoritative live count from here on every scrape. Registered once,
// gated, by the collaboration gateway via registerDocsOpenSource(). Null until
// then → the collect() is a no-op.
let docsOpenSource: (() => number) | null = null;

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
    help: 'Collaboration onStoreDocument duration in seconds, by document size bucket',
    labelNames: ['size_bucket'],
    buckets: COLLAB_BUCKETS,
    registers: [registry],
  });

  collabLoadHist = new Histogram({
    name: METRIC_COLLAB_LOAD_DURATION,
    help: 'Collaboration onLoadDocument DB-load duration in seconds, by document size bucket',
    labelNames: ['size_bucket'],
    buckets: COLLAB_BUCKETS,
    registers: [registry],
  });

  docsOpenGauge = new Gauge({
    name: METRIC_COLLAB_DOCS_OPEN,
    help: 'Number of collaboration documents currently open in memory',
    registers: [registry],
    // Read-on-scrape: pull the live count from the registered source (the
    // hocuspocus instance) so the value can never drift. No-op until a source
    // is registered.
    collect() {
      if (docsOpenSource) this.set(docsOpenSource());
    },
  });

  docLoadsCounter = new Counter({
    name: METRIC_COLLAB_DOC_LOADS_TOTAL,
    help: 'Total collaboration documents loaded into memory',
    registers: [registry],
  });

  docUnloadsCounter = new Counter({
    name: METRIC_COLLAB_DOC_UNLOADS_TOTAL,
    help: 'Total collaboration documents unloaded from memory',
    registers: [registry],
  });

  connectTimeoutsCounter = new Counter({
    name: METRIC_COLLAB_CONNECT_TIMEOUTS_TOTAL,
    help: 'Total collaboration connection setup timeouts',
    registers: [registry],
  });

  collabConnectHist = new Histogram({
    name: METRIC_COLLAB_CONNECT_DURATION,
    help: 'Collaboration connection acceptance duration in seconds (onConnect→connected)',
    buckets: COLLAB_BUCKETS,
    registers: [registry],
  });

  collabAuthHist = new Histogram({
    name: METRIC_COLLAB_AUTH_DURATION,
    help: 'Collaboration onAuthenticate duration in seconds',
    buckets: COLLAB_BUCKETS,
    registers: [registry],
  });

  mcpToolHist = new Histogram({
    name: METRIC_MCP_TOOL_DURATION,
    help: 'MCP tool-call duration in seconds, by tool name',
    labelNames: ['tool'],
    buckets: MCP_TOOL_BUCKETS,
    registers: [registry],
  });

  getPageCacheHitsCounter = new Counter({
    name: METRIC_MCP_GETPAGE_CACHE_HITS_TOTAL,
    help: 'Total getPage PM→Markdown conversions served from the cache (skipped)',
    registers: [registry],
  });

  getPageCacheMissesCounter = new Counter({
    name: METRIC_MCP_GETPAGE_CACHE_MISSES_TOTAL,
    help: 'Total getPage PM→Markdown conversions computed (cache misses)',
    registers: [registry],
  });

  apiKeyAuthDeniedCounter = new Counter({
    name: METRIC_API_KEY_AUTH_DENIED_TOTAL,
    help: 'Total api-key auth denials in ApiKeyService.validate, by bounded reason',
    labelNames: ['reason'],
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

export function observeCollabStore(bytes: number, seconds: number): void {
  collabHist?.observe({ size_bucket: sizeBucket(bytes) }, seconds);
}

export function observeCollabLoad(bytes: number, seconds: number): void {
  collabLoadHist?.observe({ size_bucket: sizeBucket(bytes) }, seconds);
}

/**
 * Register the live open-document count source for the collab_docs_open gauge.
 * Called ONCE, gated by isMetricsEnabled(), by the collaboration gateway. The
 * gauge reads this on every scrape (collect()); nothing inc/dec's it.
 */
export function registerDocsOpenSource(fn: () => number): void {
  docsOpenSource = fn;
}

export function incDocLoad(): void {
  docLoadsCounter?.inc();
}

export function incDocUnload(): void {
  docUnloadsCounter?.inc();
}

export function incConnectTimeout(): void {
  connectTimeoutsCounter?.inc();
}

export function observeCollabConnect(seconds: number): void {
  collabConnectHist?.observe(seconds);
}

export function observeCollabAuth(seconds: number): void {
  collabAuthHist?.observe(seconds);
}

export function incGetPageCacheHit(): void {
  getPageCacheHitsCounter?.inc();
}

export function incGetPageCacheMiss(): void {
  getPageCacheMissesCounter?.inc();
}

/**
 * #558 — record one api-key auth denial, labelled by its BOUNDED reason. A no-op
 * when metrics are disabled. `reason` MUST come from the fixed ApiKeyDenyReason
 * set (never free-form / attacker-controlled input) so the label cardinality
 * stays bounded. The apiKeyId is deliberately NOT a label — it is logged only in
 * the rate-limited WARN, after the JWT signature has been verified.
 */
export function incApiKeyAuthDenied(reason: string): void {
  apiKeyAuthDeniedCounter?.inc({ reason });
}

export function observeMcpTool(tool: string, seconds: number): void {
  // `tool` MUST be a bounded, registration-derived MCP tool name (the caller
  // guarantees it comes from the registered-tool set) — never free-form input —
  // so this label stays low-cardinality with no 'other' bucketing needed.
  mcpToolHist?.observe({ tool }, seconds);
}
