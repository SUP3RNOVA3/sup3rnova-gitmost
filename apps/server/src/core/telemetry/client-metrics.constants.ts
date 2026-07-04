/**
 * Server-side whitelist + limits for POST /api/telemetry/vitals (#355).
 *
 * The endpoint is PUBLIC (browsers post it, no auth) so it is a privacy and
 * abuse surface: everything not on these lists is silently DROPPED and the
 * request still returns 200 (never 400 — a 400 would make browsers retry).
 */

// The only metric names accepted. Anything else is dropped.
export const ALLOWED_METRIC_NAMES = new Set<string>([
  'INP',
  'LCP',
  'CLS',
  'TTFB',
  'editor_tx_ms',
  'page_open_ms',
  'longtask_ms',
]);

// The only rating values accepted (web-vitals). Anything else -> null.
export const ALLOWED_RATINGS = new Set<string>([
  'good',
  'needs-improvement',
  'poor',
]);

// Max events accepted per batch; the rest are ignored.
export const MAX_EVENTS_PER_BATCH = 50;

// Defence-in-depth body cap (~16KB). Fastify's global bodyLimit is far larger,
// so we re-check the parsed payload size here and drop oversized batches.
export const MAX_BODY_BYTES = 16 * 1024;

// attr is truncated to this many characters (attribution target only, no PII).
export const MAX_ATTR_LENGTH = 120;

// route label sanity cap (client sends a template like /s/:space/p/:slug).
export const MAX_ROUTE_LENGTH = 200;

export interface ClientMetricRow {
  name: string;
  value: number;
  rating: string | null;
  route: string | null;
  attr: string | null;
  docSize: number | null;
  workspaceId: string | null;
}

/**
 * Validate + normalise a single incoming event into a DB row, or return null to
 * DROP it. Pure so it is directly unit-testable. Enforces the name whitelist,
 * numeric value, rating whitelist, attr truncation and doc_size (int) coercion.
 */
export function sanitizeVitalEvent(
  raw: unknown,
  workspaceId: string | null,
): ClientMetricRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  const name = e.name;
  if (typeof name !== 'string' || !ALLOWED_METRIC_NAMES.has(name)) return null;

  const value =
    typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null;
  if (value === null) return null;

  const rating =
    typeof e.rating === 'string' && ALLOWED_RATINGS.has(e.rating)
      ? e.rating
      : null;

  let route: string | null = null;
  if (typeof e.route === 'string' && e.route.length > 0) {
    route = e.route.slice(0, MAX_ROUTE_LENGTH);
  }

  let attr: string | null = null;
  if (typeof e.attr === 'string' && e.attr.length > 0) {
    attr = e.attr.slice(0, MAX_ATTR_LENGTH);
  }

  let docSize: number | null = null;
  if (typeof e.docSize === 'number' && Number.isFinite(e.docSize)) {
    docSize = Math.trunc(e.docSize);
  } else if (typeof e.doc_size === 'number' && Number.isFinite(e.doc_size)) {
    // Accept snake_case too, in case a client sends the raw column name.
    docSize = Math.trunc(e.doc_size as number);
  }

  return { name, value, rating, route, attr, docSize, workspaceId };
}
