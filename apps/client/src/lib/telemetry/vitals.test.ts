import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Body-paint latch + forced-sampling tests (#639, structural criteria 2-5).
 *
 * INITIAL_PATHNAME in vitals.ts is captured ONCE at module init, so each case
 * loads the module fresh (vi.resetModules + dynamic import) after setting the
 * document's boot pathname. `@/lib/config` is mocked so telemetry is enabled and
 * force-sampled; `performance.now`/marks are stubbed so timings are exact.
 */

type VitalsModule = typeof import("./vitals");

async function loadVitals(opts: {
  pathname: string;
  telemetryEnabled?: boolean;
  sampleRate?: string;
}): Promise<VitalsModule> {
  vi.resetModules();
  // Control the module-init pathname capture (the doc's boot route).
  window.history.replaceState(null, "", opts.pathname);
  vi.doMock("@/lib/config", () => ({
    isClientTelemetryEnabled: () => opts.telemetryEnabled ?? true,
    getClientTelemetrySampleRate: () => opts.sampleRate ?? "1",
  }));
  return import("./vitals");
}

function stubNoMark(now: number): void {
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([] as any);
  vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
  vi.spyOn(performance, "now").mockReturnValue(now);
}

function stubMark(markStart: number, now: number): void {
  vi.spyOn(performance, "getEntriesByName").mockReturnValue([
    { startTime: markStart } as any,
  ]);
  vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
  vi.spyOn(performance, "now").mockReturnValue(now);
}

function names<T extends { name: string }>(events: T[], name: string): T[] {
  return events.filter((e) => e.name === name);
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/config");
  vi.useRealTimers();
});

describe("page_open_body_ms latch (#639)", () => {
  // Criterion 2 — reload path: no click mark, count from timeOrigin, and both
  // paint points feed ONE shared one-shot latch (second call is a no-op).
  it("reports once via the timeOrigin start on a mark-less reload of a page route", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubNoMark(842);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1"); // static-copy branch paints
    v.notePageBodyPaint("page-1"); // live-editor branch — one-shot no-op

    const events = v.__vitalsTestHooks.drainBuffer();
    const opens = names(events, "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(842);
    expect(opens[0].route).toBe("/s/:space/p/:slug");
  });

  // Criterion 3 — click-mark path is the start, and editor re-creation (a second
  // paint for the same document) does NOT double-report.
  it("uses the click mark as start and does not double-report on re-creation", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubMark(1000, 1300);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1"); // first paint
    v.notePageBodyPaint("page-1"); // editor re-creation / static->live swap

    const opens = names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(300); // 1300 - 1000
  });

  it("prefers the click mark even when the document booted on a non-page route", async () => {
    const v = await loadVitals({ pathname: "/home" });
    stubMark(2000, 2250);
    v.armBodyPaint("page-1");
    v.notePageBodyPaint("page-1");

    const opens = names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms");
    expect(opens).toHaveLength(1);
    expect(opens[0].value).toBe(250);
  });

  // Criterion 4 — the initial-pathname guard: a mark-less open whose document
  // booted on a NON-page route (load /home, idle, programmatic "new note") is
  // NOT reported, even though the live location is now a page route.
  it("does NOT report a mark-less open when the document booted on a non-page route", async () => {
    const v = await loadVitals({ pathname: "/home" });
    stubNoMark(300_000); // ~5 min of idle since boot
    // The programmatic navigation has already changed the LIVE location:
    window.history.replaceState(null, "", "/s/eng/p/new-note-xyz");
    v.armBodyPaint("page-new");
    v.notePageBodyPaint("page-new");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    // The body DID paint, so it must not count as a timeout either.
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Criterion 4 (cap half) — even on a page-booted document, a mark-less value
  // over the hard cap is suppressed (idle-then-navigate inflation).
  it("does NOT report a mark-less value over the hard cap", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/first" });
    stubNoMark(300_000); // > PAGE_OPEN_MAX_MS (60s)
    v.armBodyPaint("page-2");
    v.notePageBodyPaint("page-2");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Review F1 — the cap guards the MARK path too: a STALE click mark (elapsed
  // over the cap) is suppressed, so an unconsumed mark from an earlier click
  // cannot inflate the next open. Without the fix this reports ~70000.
  it("does NOT report a click-mark value over the hard cap (stale mark)", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/first" });
    stubMark(1_000, 71_000); // elapsed 70s > PAGE_OPEN_MAX_MS (60s)
    v.armBodyPaint("page-stale");
    v.notePageBodyPaint("page-stale");

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    // The body DID paint — a suppressed value is not a timeout.
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
  });

  // Review F1 (suggestion 3) — disarmBodyPaint (effect cleanup on unmount before
  // paint) cancels the survivorship timer, so a page the user navigated away from
  // does NOT emit a body_paint_timeout.
  it("disarmBodyPaint cancels the survivorship timer on unmount before paint", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(500);
    v.armBodyPaint("page-unmount");
    v.disarmBodyPaint("page-unmount"); // unmounted before it painted
    vi.advanceTimersByTime(15_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
  });

  // Criterion 5 — never-paint survivorship guard: body_paint_timeout is emitted,
  // page_open_body_ms is NOT, and a late paint after the timeout is a no-op.
  it("emits body_paint_timeout (not page_open_body_ms) when the body never paints", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(500);
    v.armBodyPaint("page-3");
    // No notePageBodyPaint — the body never paints.
    vi.advanceTimersByTime(15_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "page_open_body_ms")).toHaveLength(0);
    const timeouts = names(events, "body_paint_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].value).toBe(1);

    // A late paint after the timeout already fired must not report.
    v.notePageBodyPaint("page-3");
    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms"),
    ).toHaveLength(0);
  });

  it("cancels the timeout when the body paints in time", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    vi.useFakeTimers();
    stubNoMark(400);
    v.armBodyPaint("page-4");
    v.notePageBodyPaint("page-4"); // paints before the window elapses
    vi.advanceTimersByTime(60_000);

    const events = v.__vitalsTestHooks.drainBuffer();
    expect(names(events, "body_paint_timeout")).toHaveLength(0);
    expect(names(events, "page_open_body_ms")).toHaveLength(1);
  });

  it("re-arms for a new document (page switch) so the next open reports again", async () => {
    const v = await loadVitals({ pathname: "/s/eng/p/design-abc" });
    stubNoMark(100);
    v.armBodyPaint("page-a");
    v.notePageBodyPaint("page-a");
    // Page switch to a different document key.
    v.armBodyPaint("page-b");
    v.notePageBodyPaint("page-b");

    expect(
      names(v.__vitalsTestHooks.drainBuffer(), "page_open_body_ms"),
    ).toHaveLength(2);
  });

  it("is a no-op when telemetry is disabled", async () => {
    const v = await loadVitals({
      pathname: "/s/eng/p/design-abc",
      telemetryEnabled: false,
    });
    stubNoMark(500);
    v.armBodyPaint("page-x");
    v.notePageBodyPaint("page-x");
    expect(v.__vitalsTestHooks.drainBuffer()).toHaveLength(0);
  });
});

describe("forced sampling override (#639 §4)", () => {
  it("forces sampling ON even if an earlier tab-session decided not-sampled", async () => {
    // A prior session persisted a "not sampled" decision.
    sessionStorage.setItem("gm_vitals_sampled", "0");
    const v = await loadVitals({ pathname: "/home", sampleRate: "1" });
    expect(v.isVitalsSampled()).toBe(true);
  });

  it("falls back to the persisted session decision when the override is unset", async () => {
    const v = await loadVitals({ pathname: "/home", sampleRate: "" });
    sessionStorage.setItem("gm_vitals_sampled", "0");
    v.__vitalsTestHooks.reset(); // clear the in-module cache so it re-reads storage
    expect(v.isVitalsSampled()).toBe(false);
  });
});
