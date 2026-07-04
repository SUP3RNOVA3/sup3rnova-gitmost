import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RefObject } from "react";
import { useSwapHeightReservation } from "./use-swap-height-reservation";

// Controllable fake requestAnimationFrame. jsdom's rAF is timer-driven and hard
// to step deterministically, so we install a manual queue: `tickRaf()` drains the
// callbacks scheduled so far (a callback that reschedules enqueues a new one for
// the NEXT tick), letting each test advance the release loop frame by frame.
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 1;
let realRaf: typeof globalThis.requestAnimationFrame;
let realCancel: typeof globalThis.cancelAnimationFrame;

function tickRaf(): void {
  const current = rafQueue;
  rafQueue = [];
  for (const { cb } of current) cb(0);
}

// A mutable stand-in for the live-content container. The hook only reads
// `scrollHeight`, so tests drive the release condition by mutating this.
function makeMenuRef(): {
  ref: RefObject<HTMLElement | null>;
  setScrollHeight: (h: number) => void;
} {
  const el = { scrollHeight: 0 };
  return {
    ref: { current: el } as unknown as RefObject<HTMLElement | null>,
    setScrollHeight: (h: number) => {
      el.scrollHeight = h;
    },
  };
}

const H = 1000;

describe("useSwapHeightReservation", () => {
  beforeEach(() => {
    rafQueue = [];
    nextRafId = 1;
    realRaf = globalThis.requestAnimationFrame;
    realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.push({ id, cb });
      return id;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      rafQueue = rafQueue.filter((e) => e.id !== id);
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // (a) reserve-on-swap: the captured height becomes `reservedHeight`, the value
  // that drives the swap wrapper's minHeight. Captured while static is still up,
  // then the swap flips showStatic; before any release frame runs the reservation
  // is held at exactly H.
  it("(a) holds the captured height as reservedHeight after the swap (drives minHeight)", () => {
    const { ref, setScrollHeight } = makeMenuRef();
    setScrollHeight(0); // live content not laid out yet -> release cannot fire.
    const { result, rerender } = renderHook(
      ({ showStatic }) => useSwapHeightReservation(showStatic, ref),
      { initialProps: { showStatic: true } },
    );

    // Capture happens synchronously at the swap point (static still shown).
    act(() => {
      result.current.captureReservation(H);
    });
    // The swap flips to the live branch.
    rerender({ showStatic: false });

    expect(result.current.reservedHeight).toBe(H);
  });

  // (b) release when the live content is tall enough. Guard is `>=`: with
  // liveHeight === H the reservation releases. This FAILS if the guard direction
  // were `<` (liveHeight === H is not `< H`, so it would never release).
  it("(b) releases once live content reaches the reserved height", () => {
    const { ref, setScrollHeight } = makeMenuRef();
    setScrollHeight(0);
    const { result, rerender } = renderHook(
      ({ showStatic }) => useSwapHeightReservation(showStatic, ref),
      { initialProps: { showStatic: true } },
    );

    act(() => {
      result.current.captureReservation(H);
    });
    rerender({ showStatic: false });
    expect(result.current.reservedHeight).toBe(H); // still reserved (short live doc)

    // Live editor finishes laying out to the reserved height.
    setScrollHeight(H);
    act(() => {
      tickRaf();
    });

    expect(result.current.reservedHeight).toBeNull();
  });

  // (c) cap escape: the live content never reaches the reserved height, so the
  // height match never fires; the reservation must still release at the 4000ms
  // cap (no stuck reservation / dead space). This FAILS if there were no cap: the
  // loop would poll forever while scrollHeight stays below H.
  it("(c) releases at the 4000ms cap when live content stays too short", () => {
    // Only fake Date so `Date.now()` (the cap clock) is controllable; leave our
    // manual rAF queue in place (default fake timers would replace it).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const { ref, setScrollHeight } = makeMenuRef();
    setScrollHeight(H - 100); // always shorter than reserved -> height match never fires.
    const { result, rerender } = renderHook(
      ({ showStatic }) => useSwapHeightReservation(showStatic, ref),
      { initialProps: { showStatic: true } },
    );

    act(() => {
      result.current.captureReservation(H);
    });
    rerender({ showStatic: false });

    // A few frames pass but time has not reached the cap: still reserved.
    act(() => {
      tickRaf();
    });
    act(() => {
      tickRaf();
    });
    expect(result.current.reservedHeight).toBe(H);

    // Advance past the cap; the next frame releases even though the live content
    // is still shorter than the reservation.
    vi.setSystemTime(4001);
    act(() => {
      tickRaf();
    });

    expect(result.current.reservedHeight).toBeNull();
  });

  // (d) non-swap: without a capture (and while static is shown) there is no
  // reservation and the release loop never arms, so no rAF is scheduled.
  it("(d) reserves nothing and arms no loop when the swap never happens", () => {
    const { ref } = makeMenuRef();
    const { result } = renderHook(() =>
      useSwapHeightReservation(true, ref),
    );

    expect(result.current.reservedHeight).toBeNull();
    expect(rafQueue.length).toBe(0); // release loop never armed
    act(() => {
      tickRaf();
    });
    expect(result.current.reservedHeight).toBeNull();
  });
});
