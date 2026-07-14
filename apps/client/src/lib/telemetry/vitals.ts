import {
  onCLS,
  onINP,
  onLCP,
  onTTFB,
  type CLSMetricWithAttribution,
  type INPMetricWithAttribution,
  type LCPMetricWithAttribution,
  type TTFBMetricWithAttribution,
} from "web-vitals/attribution";
import { isClientTelemetryEnabled } from "@/lib/config";
import { currentRouteTemplate } from "./route-template";

/**
 * Client perf-telemetry (#355): web-vitals + custom metrics buffered and posted
 * to POST /api/telemetry/vitals via sendBeacon.
 *
 * Design constraints from the issue:
 *  - Sampling is decided ONCE per session (25%), cached in sessionStorage,
 *    BEFORE any observer is subscribed. Non-sampled sessions send nothing.
 *  - Route labels are TEMPLATES only; attr is truncated to 120 chars; no page
 *    titles/slugs/text ever leave the browser.
 *  - Observers are passive and reporting is best-effort — telemetry must not
 *    degrade the perf it measures.
 */

const ENDPOINT = "/api/telemetry/vitals";
const SAMPLE_RATE = 0.25;
const SAMPLE_KEY = "gm_vitals_sampled";
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BUFFER = 40; // flush early if the buffer fills between timers
const MAX_ATTR_LENGTH = 120;
const EDITOR_TX_MIN_MS = 8; // only report editor transactions slower than this

const ALLOWED_NAMES = new Set([
  "INP",
  "LCP",
  "CLS",
  "TTFB",
  "editor_tx_ms",
  "page_open_ms",
  "longtask_ms",
  // #563 — page-meta boot-cache counters (value is always 1; they are counts).
  "page_meta_hit",
  "page_meta_miss",
  "page_meta_evict",
]);

interface VitalEvent {
  name: string;
  value: number;
  rating?: string;
  route?: string;
  attr?: string;
  docSize?: number;
}

let sampledCache: boolean | null = null;
let initialised = false;
let buffer: VitalEvent[] = [];
let longtaskSum = 0; // accumulated longtask duration (ms) for the current window

/**
 * Decide once per session whether this session is sampled. Cached in
 * sessionStorage so the choice is stable across reloads within the session and
 * identical for every observer/custom-metric caller.
 */
export function isVitalsSampled(): boolean {
  if (sampledCache !== null) return sampledCache;
  try {
    const stored = sessionStorage.getItem(SAMPLE_KEY);
    if (stored === "1") return (sampledCache = true);
    if (stored === "0") return (sampledCache = false);
    const sampled = Math.random() < SAMPLE_RATE;
    sessionStorage.setItem(SAMPLE_KEY, sampled ? "1" : "0");
    return (sampledCache = sampled);
  } catch {
    // sessionStorage unavailable (private mode / SSR): default to not sampled.
    return (sampledCache = false);
  }
}

/**
 * True only when telemetry is BOTH enabled by the operator (F1 flag) AND this
 * session is sampled. Callers outside initVitals (e.g. the editor dispatch
 * wrapper) use this to skip ALL instrumentation cost on disabled/non-sampled
 * sessions — no observers, no per-transaction timing.
 */
export function isVitalsActive(): boolean {
  return isClientTelemetryEnabled() && isVitalsSampled();
}

function truncateAttr(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_ATTR_LENGTH);
}

function enqueue(event: VitalEvent): void {
  if (!ALLOWED_NAMES.has(event.name)) return;
  if (!Number.isFinite(event.value)) return;
  buffer.push(event);
  if (buffer.length >= MAX_BUFFER) flush();
}

function flush(): void {
  // Fold any pending longtask total into the batch first.
  if (longtaskSum > 0) {
    buffer.push({
      name: "longtask_ms",
      value: Math.round(longtaskSum),
      route: currentRouteTemplate(),
    });
    longtaskSum = 0;
  }
  if (buffer.length === 0) return;

  const payload = JSON.stringify({ events: buffer });
  buffer = [];

  try {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    // Fallback for browsers without sendBeacon: keepalive fetch.
    void fetch(ENDPOINT, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Best-effort: never throw out of telemetry.
  }
}

/**
 * Report a custom client metric (editor_tx_ms, page_open_ms). No-op unless the
 * session is sampled. Route is always the current TEMPLATE.
 */
export function reportClientMetric(
  name:
    | "editor_tx_ms"
    | "page_open_ms"
    | "page_meta_hit"
    | "page_meta_miss"
    | "page_meta_evict",
  value: number,
  extra?: { docSize?: number },
): void {
  if (!isVitalsActive()) return;
  if (!Number.isFinite(value)) return;
  enqueue({
    name,
    value,
    route: currentRouteTemplate(),
    docSize: extra?.docSize,
  });
}

/** Threshold-gated editor transaction reporter (only reports slow syncs). */
export function reportEditorTx(ms: number, docSize: number): void {
  if (ms <= EDITOR_TX_MIN_MS) return;
  reportClientMetric("editor_tx_ms", ms, { docSize });
}

const PAGE_OPEN_MARK = "gm_page_open_start";

/** Mark the start of a page-open interaction (tree-row / link click). */
export function markPageOpenStart(): void {
  try {
    performance.clearMarks(PAGE_OPEN_MARK);
    performance.mark(PAGE_OPEN_MARK);
  } catch {
    // ignore
  }
}

/**
 * Measure page_open_ms at first editor-content render, if a start mark exists.
 * Consumes the mark so a later render doesn't double-count.
 */
export function measurePageOpen(): void {
  try {
    const marks = performance.getEntriesByName(PAGE_OPEN_MARK, "mark");
    if (marks.length === 0) return;
    const started = marks[0].startTime;
    const elapsed = performance.now() - started;
    performance.clearMarks(PAGE_OPEN_MARK);
    if (elapsed > 0 && Number.isFinite(elapsed)) {
      reportClientMetric("page_open_ms", elapsed);
    }
  } catch {
    // ignore
  }
}

function attrTarget(
  metric:
    | INPMetricWithAttribution
    | LCPMetricWithAttribution
    | CLSMetricWithAttribution,
): string | undefined {
  const a = metric.attribution as Record<string, unknown> | undefined;
  if (!a) return undefined;
  // Different vitals expose their culprit element under different keys; only a
  // CSS-selector-ish target string is taken (no text content / titles).
  return (
    truncateAttr(a.interactionTarget) ??
    truncateAttr(a.element) ??
    truncateAttr(a.largestShiftTarget) ??
    undefined
  );
}

/**
 * Initialise client telemetry. Safe to call multiple times (idempotent). Returns
 * immediately without subscribing when the session is not sampled — so a
 * non-sampled session subscribes to NO observers and sends nothing.
 */
export function initVitals(): void {
  if (initialised) return;
  initialised = true;

  // Operator flag gate (F1, default OFF): when telemetry is disabled the sink
  // endpoint does not even exist server-side, so install ZERO observers.
  if (!isClientTelemetryEnabled()) return;

  // Sampling gate is evaluated BEFORE any observer subscription.
  if (!isVitalsSampled()) return;

  const report = (
    metric:
      | INPMetricWithAttribution
      | LCPMetricWithAttribution
      | CLSMetricWithAttribution
      | TTFBMetricWithAttribution,
  ) => {
    enqueue({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      route: currentRouteTemplate(),
      attr:
        metric.name === "TTFB"
          ? undefined
          : attrTarget(
              metric as
                | INPMetricWithAttribution
                | LCPMetricWithAttribution
                | CLSMetricWithAttribution,
            ),
    });
  };

  onINP(report);
  onLCP(report);
  onCLS(report);
  onTTFB(report);

  // Long tasks: aggregate the total blocking time per flush window (a passive
  // observer; individual entries are summed, never stored/sent individually).
  try {
    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtaskSum += entry.duration;
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    }
  } catch {
    // longtask entry type unsupported: skip silently.
  }

  // page_open_ms start: mark when the user clicks a page link/tree-row (any
  // anchor navigating to a page URL). Passive capture listener; the matching
  // measure fires at first editor-content render (measurePageOpen). No page
  // titles/slugs are read — only the click timing is marked.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      // A page link is `/s/:space/p/:slug`, `/p/:slug` or a share page path.
      if (/\/p\//.test(href)) markPageOpenStart();
    },
    { capture: true, passive: true },
  );

  // Flush on tab hide (most reliable delivery point) and periodically.
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", flush);

  setInterval(flush, FLUSH_INTERVAL_MS);
}
