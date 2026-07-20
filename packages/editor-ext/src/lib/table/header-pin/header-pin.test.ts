import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { computePinTop, pinOffsetWatcher, EDITOR_PIN_OFFSET_VAR } from './offset';
import { TablePinController } from './controller';

/**
 * Regression tests for the Safari/WebKit 100%-CPU feedback loop in the table
 * header-pin stack. Three coupled observers used to drive each other:
 *
 *  - `computePinTop()` returned a float, so `pinOffsetWatcher.publish()`'s
 *    dedupe never held and every ResizeObserver tick rewrote a `:root` custom
 *    property (a full-document style recalc in WebKit);
 *  - the fit IntersectionObserver's callback wrote a class onto the wrapper
 *    that IS its own root, and WebKit re-evaluates intersection after callback
 *    style writes — so the two modes could chase each other forever.
 *
 * These assert the observable properties: an integer offset, a single custom
 * property write for jittering-but-equal values, one evaluation per frame no
 * matter how many intersection deliveries arrive, and a latch that stops a real
 * oscillation loudly — without becoming a trap the table can never leave.
 */

// Minimal element stub for the pin anchors that computePinTop() looks up.
function anchorStub(bottom: number, height = 40) {
  return {
    getBoundingClientRect: () => ({ bottom, height }) as DOMRect,
  } as unknown as HTMLElement;
}

describe('computePinTop', () => {
  let querySelectorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    querySelectorSpy?.mockRestore();
  });

  it('quantizes a fractional anchor rect to a whole pixel', () => {
    querySelectorSpy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation(() => anchorStub(140.484375) as unknown as Element);

    const top = computePinTop();

    expect(Number.isInteger(top)).toBe(true);
    expect(top).toBe(140);
  });

  it('still falls back to the app-bar height when no anchor is mounted', () => {
    querySelectorSpy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation(() => null);

    expect(computePinTop()).toBe(45);
  });
});

describe('pinOffsetWatcher.publish', () => {
  let querySelectorSpy: ReturnType<typeof vi.spyOn>;
  let setPropertySpy: ReturnType<typeof vi.spyOn>;
  let anchorBottom = 0;
  let originalResizeObserver: unknown;

  beforeEach(() => {
    anchorBottom = 140.2;
    querySelectorSpy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation(
        () => anchorStub(anchorBottom) as unknown as Element,
      );
    setPropertySpy = vi.spyOn(document.documentElement.style, 'setProperty');

    originalResizeObserver = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    // Always release so the module-level refcount does not leak between tests.
    if (pinOffsetWatcher.refs > 0) pinOffsetWatcher.release();
    querySelectorSpy.mockRestore();
    setPropertySpy.mockRestore();
    (globalThis as any).ResizeObserver = originalResizeObserver;
  });

  it('writes the custom property once for jittering values that round equal', () => {
    pinOffsetWatcher.acquire(); // publishes 140.2 -> 140

    anchorBottom = 140.37;
    pinOffsetWatcher.publish();
    anchorBottom = 139.51;
    pinOffsetWatcher.publish();

    expect(setPropertySpy).toHaveBeenCalledTimes(1);
    expect(setPropertySpy).toHaveBeenCalledWith(EDITOR_PIN_OFFSET_VAR, '140px');
  });

  it('does write again when the quantized value actually changes', () => {
    pinOffsetWatcher.acquire(); // 140

    anchorBottom = 152.4;
    pinOffsetWatcher.publish();

    expect(setPropertySpy).toHaveBeenCalledTimes(2);
    expect(setPropertySpy).toHaveBeenLastCalledWith(
      EDITOR_PIN_OFFSET_VAR,
      '152px',
    );
  });

  it('floors the refcount so an unbalanced release cannot leak an observer', () => {
    pinOffsetWatcher.acquire();
    pinOffsetWatcher.release();
    expect(pinOffsetWatcher.refs).toBe(0);

    // The extra release must be a no-op, not refs = -1. A negative refcount
    // would let the next acquire() slip past its guard and the one after that
    // build a second ResizeObserver over document.body.
    pinOffsetWatcher.release();
    expect(pinOffsetWatcher.refs).toBe(0);

    pinOffsetWatcher.acquire();
    expect(pinOffsetWatcher.refs).toBe(1);
    expect(pinOffsetWatcher.resizeObserver).not.toBeNull();
  });
});

const PINNED = 'tableHeaderPinned';
const NO_OVERFLOW = 'tableWrapperNoOverflow';

function buildFixture() {
  const wrapper = document.createElement('div');
  wrapper.className = 'tableWrapper';
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  const row = document.createElement('tr');
  for (let i = 0; i < 2; i++) row.appendChild(document.createElement('th'));
  tbody.appendChild(row);
  const dataRow = document.createElement('tr');
  for (let i = 0; i < 2; i++) dataRow.appendChild(document.createElement('td'));
  tbody.appendChild(dataRow);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  document.body.appendChild(wrapper);
  return { wrapper, table };
}

// Swap the first row between all-<th> (eligible for pinning) and all-<td>
// (ineligible — `firstRowIsAllHeaders` fails).
function setFirstRowCells(table: HTMLTableElement, tag: 'th' | 'td') {
  const row = table.querySelector('tr')!;
  const replacement = document.createElement('tr');
  for (let i = 0; i < row.cells.length; i++) {
    replacement.appendChild(document.createElement(tag));
  }
  row.replaceWith(replacement);
}

type IOHarness = {
  emit: (isIntersecting: boolean) => void;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
};

// Installs IntersectionObserver/ResizeObserver stubs that let the test push
// entries by hand. The caller restores the globals.
function installObserverStubs(): IOHarness {
  const disconnect = vi.fn();
  const observe = vi.fn();
  let capturedCallback: ((entries: any[]) => void) | null = null;

  (globalThis as any).IntersectionObserver = class {
    constructor(cb: (entries: any[]) => void) {
      capturedCallback = cb;
    }
    observe() {
      observe();
    }
    unobserve() {}
    disconnect() {
      disconnect();
    }
  };
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  return {
    disconnect,
    observe,
    emit: (isIntersecting: boolean) => {
      capturedCallback?.([
        {
          isIntersecting,
          boundingClientRect: { width: 400, height: 120 } as DOMRectReadOnly,
        },
      ]);
    },
  };
}

describe('TablePinController rAF coalescing', () => {
  let originalIO: unknown;
  let originalRO: unknown;
  let originalRaf: unknown;
  let originalCaf: unknown;
  // Monotonic handles: a handle is never reused, so a stale
  // cancelAnimationFrame(oldHandle) after a flush cannot cancel an unrelated
  // newer frame and quietly make a future test lie.
  let rafSeq: number;
  let rafQueue: Map<number, FrameRequestCallback>;
  let io: IOHarness;
  const live: TablePinController[] = [];

  const flushFrames = () => {
    const pending = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of pending) cb(0);
  };

  beforeEach(() => {
    originalIO = (globalThis as any).IntersectionObserver;
    originalRO = (globalThis as any).ResizeObserver;
    originalRaf = (globalThis as any).requestAnimationFrame;
    originalCaf = (globalThis as any).cancelAnimationFrame;

    rafSeq = 0;
    rafQueue = new Map();
    // Queued (not synchronous) rAF: frames run only when the test flushes them,
    // which is what makes "many deliveries -> one evaluation" observable.
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      const handle = ++rafSeq;
      rafQueue.set(handle, cb);
      return handle;
    };
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
      rafQueue.delete(handle);
    };

    io = installObserverStubs();
  });

  afterEach(() => {
    // Teardown here, not in the test body: a failing expect must not leak the
    // pinOffsetWatcher refcount into the next test.
    while (live.length) live.pop()!.destroy();
    document.body.innerHTML = '';
    (globalThis as any).IntersectionObserver = originalIO;
    (globalThis as any).ResizeObserver = originalRO;
    (globalThis as any).requestAnimationFrame = originalRaf;
    (globalThis as any).cancelAnimationFrame = originalCaf;
  });

  const track = (ctrl: TablePinController) => {
    live.push(ctrl);
    return ctrl;
  };

  it('collapses several intersection deliveries in one frame into one evaluation', () => {
    const { wrapper, table } = buildFixture();
    track(new TablePinController(wrapper, table));

    const classMutations = new MutationObserver(() => {});
    classMutations.observe(wrapper, {
      attributes: true,
      attributeFilter: ['class'],
    });

    io.emit(true);
    io.emit(false);
    io.emit(true);

    // Nothing applied yet, and only ONE frame was scheduled for three deliveries.
    expect(wrapper.classList.contains(PINNED)).toBe(false);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
    expect(rafQueue.size).toBe(1);

    flushFrames();

    // Exactly one evaluation ran, for the LAST delivered entry: 'off' -> 'native'
    // is two class writes. Three separate evaluations would have produced more.
    expect(classMutations.takeRecords()).toHaveLength(2);
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(true);

    // Nothing re-scheduled itself.
    expect(rafQueue.size).toBe(0);
    flushFrames();
    expect(classMutations.takeRecords()).toHaveLength(0);

    classMutations.disconnect();
  });

  it('cancels a pending frame on destroy so nothing is applied afterwards', () => {
    const { wrapper, table } = buildFixture();
    // Tracked as well: destroy() is idempotent, so the afterEach sweep is safe
    // even though this test destroys explicitly — and a failing expect below
    // cannot leak the pinOffsetWatcher refcount.
    const ctrl = track(new TablePinController(wrapper, table));

    io.emit(true);
    expect(rafQueue.size).toBe(1);

    ctrl.destroy();
    // cancelAnimationFrame was called with the live handle.
    expect(rafQueue.size).toBe(0);

    flushFrames();
    expect(wrapper.classList.contains(PINNED)).toBe(false);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
  });
});

describe('TablePinController oscillation latch', () => {
  let originalIO: unknown;
  let originalRO: unknown;
  let originalRaf: unknown;
  let originalCaf: unknown;
  let io: IOHarness;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let now = 1000;
  const live: TablePinController[] = [];

  beforeEach(() => {
    originalIO = (globalThis as any).IntersectionObserver;
    originalRO = (globalThis as any).ResizeObserver;
    originalRaf = (globalThis as any).requestAnimationFrame;
    originalCaf = (globalThis as any).cancelAnimationFrame;

    // Synchronous rAF here: convenient, and the coalescing itself is covered by
    // the queued-rAF describe above.
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    io = installObserverStubs();

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Controlled clock: every flip lands inside one detection window unless the
    // test advances it explicitly.
    now = 1000;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    // Teardown here, not in the test body (N4): a failing expect must not leak
    // the module-level pinOffsetWatcher refcount into the next test.
    while (live.length) live.pop()!.destroy();
    document.body.innerHTML = '';
    warnSpy.mockRestore();
    nowSpy.mockRestore();
    (globalThis as any).IntersectionObserver = originalIO;
    (globalThis as any).ResizeObserver = originalRO;
    (globalThis as any).requestAnimationFrame = originalRaf;
    (globalThis as any).cancelAnimationFrame = originalCaf;
  });

  const track = (ctrl: TablePinController) => {
    live.push(ctrl);
    return ctrl;
  };

  // 8 deliveries: the first is off -> native (an eligibility-side transition,
  // not counted), then 7 native <-> fallback flips — one past the budget of 6.
  const driveOscillation = () => {
    for (let i = 0; i < 8; i++) io.emit(i % 2 === 0);
  };

  it('latches into the transform fallback and warns once after too many flips', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    driveOscillation();

    // (a) fallback presentation: pinned, but the wrapper's overflow is untouched.
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);

    // (b) the fit observer was torn down, so no further callbacks can arrive.
    expect(io.disconnect).toHaveBeenCalled();

    // (c) the degradation is visible to the operator.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('table-header-pin');

    // (d) anything emitted afterwards is inert.
    io.emit(true);
    io.emit(false);
    io.emit(true);
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A refresh inside the quiet window does not resurrect native mode either.
    ctrl.refresh();
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
  });

  it('applies native mode normally when fit detection is stable', () => {
    const { wrapper, table } = buildFixture();
    track(new TablePinController(wrapper, table));

    io.emit(true);
    io.emit(true); // same mode: not a flip

    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not count eligibility-driven off transitions as oscillation', () => {
    const { wrapper, table } = buildFixture();
    track(new TablePinController(wrapper, table));

    // Flip eligibility on and off many times while the requested pin mode also
    // alternates. Every mode change here goes through 'off', so NO transition is
    // oscillation evidence: after 16 mode changes the latch must still be
    // disarmed, and 'off' must always win on an ineligible table.
    for (let i = 0; i < 8; i++) {
      setFirstRowCells(table, 'td');
      io.emit(i % 2 === 0);
      expect(wrapper.classList.contains(PINNED)).toBe(false);

      setFirstRowCells(table, 'th');
      io.emit(i % 2 === 0);
    }

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('un-pins a latched table whose header row goes away', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    driveOscillation();
    expect(wrapper.classList.contains(PINNED)).toBe(true);

    // The header row is deleted after the latch. refresh() is the only channel
    // left (the observer is disconnected), so it must still be able to un-pin.
    setFirstRowCells(table, 'td');
    ctrl.refresh();

    expect(wrapper.classList.contains(PINNED)).toBe(false);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
  });

  it('re-arms the latch after the cooldown, on a doc change', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    driveOscillation();
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);

    // Still inside the cooldown: no re-arm, so nothing changes.
    now += 29_000;
    ctrl.refresh();
    io.emit(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);

    // Past PIN_LATCH_COOLDOWN_MS: the table gets native sticky back.
    now += 2_000;
    const observesBefore = io.observe.mock.calls.length;
    ctrl.refresh();
    expect(io.observe.mock.calls.length).toBe(observesBefore + 1);

    io.emit(true);
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(true);
  });

  it('re-arms from a scroll frame, with no doc change at all', () => {
    const { wrapper, table } = buildFixture();
    track(new TablePinController(wrapper, table));

    driveOscillation();
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);

    // A read-only page (public share, history view) never changes its doc, so
    // refresh() is never called. Scrolling is the only tick left — and a latched
    // controller is in fallback mode, hence on the fallback scroll path.
    now += 31_000;
    const observesBefore = io.observe.mock.calls.length;
    document.dispatchEvent(new Event('scroll'));
    expect(io.observe.mock.calls.length).toBe(observesBefore + 1);

    io.emit(true);
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(true);
  });

  it('recovers a table that went ineligible while latched and came back', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    driveOscillation();
    expect(wrapper.classList.contains(PINNED)).toBe(true);

    // Header row deleted, then undone two seconds later — far inside the
    // cooldown. Going ineligible already broke the feedback cycle, so the table
    // must not be stranded without pinning until the cooldown expires.
    setFirstRowCells(table, 'td');
    ctrl.refresh();
    expect(wrapper.classList.contains(PINNED)).toBe(false);

    now += 2_000;
    setFirstRowCells(table, 'th');
    const observesBefore = io.observe.mock.calls.length;
    ctrl.refresh();
    expect(io.observe.mock.calls.length).toBeGreaterThan(observesBefore);

    io.emit(true);
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(true);
  });

  it('stops retrying, and stops logging, after the third latch', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    // Genuinely bistable geometry: it re-latches after every cooldown.
    for (let latch = 1; latch <= 3; latch++) {
      driveOscillation();
      expect(warnSpy).toHaveBeenCalledTimes(latch);
      now += 31_000;
      ctrl.refresh();
    }

    // The third latch spent the retry budget: no more re-observing...
    const observesBefore = io.observe.mock.calls.length;
    now += 31_000;
    ctrl.refresh();
    document.dispatchEvent(new Event('scroll'));
    expect(io.observe.mock.calls.length).toBe(observesBefore);

    // ...the fallback stays in place, and the log stays bounded at three.
    driveOscillation();
    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(String(warnSpy.mock.calls[2][0])).toContain(
      'will not be retried again',
    );
  });

  it('announces the give-up once, even if eligibility churn re-latches it', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    for (let latch = 1; latch <= 3; latch++) {
      driveOscillation();
      now += 31_000;
      ctrl.refresh();
    }
    expect(warnSpy).toHaveBeenCalledTimes(3);

    // Going ineligible and back restores retry rights (it breaks the feedback
    // cycle on its own), so the table can latch a fourth time — but the give-up
    // announcement is a state transition and must not be repeated.
    setFirstRowCells(table, 'td');
    ctrl.refresh();
    setFirstRowCells(table, 'th');
    ctrl.refresh();
    driveOscillation();

    expect(wrapper.classList.contains(PINNED)).toBe(true);
    expect(wrapper.classList.contains(NO_OVERFLOW)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('has an idempotent destroy that does not double-release the watcher', () => {
    const { wrapper, table } = buildFixture();
    const ctrl = track(new TablePinController(wrapper, table));

    io.emit(true);
    expect(pinOffsetWatcher.refs).toBe(1);

    ctrl.destroy();
    ctrl.destroy();

    expect(pinOffsetWatcher.refs).toBe(0);
    expect(wrapper.classList.contains(PINNED)).toBe(false);
  });
});
