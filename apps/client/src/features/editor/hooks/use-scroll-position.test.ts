import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrollPosition, hasSavedReadingPosition } from "./use-scroll-position";

const KEY_PREFIX = "gitmost:scroll-position:";

function setScrollY(value: number): void {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
  });
}

function setScrollHeight(value: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value,
  });
}

function setInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value,
  });
}

describe("useScrollPosition", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setScrollY(0);
    setScrollHeight(0);
    setInnerHeight(800);
    // jsdom does not implement window.scrollTo; stub it.
    window.scrollTo = vi.fn();
    // Ensure no anchor leaks between tests.
    window.location.hash = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.location.hash = "";
  });

  it("(a) saves window.scrollY to sessionStorage under the pageId key, throttled", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useScrollPosition("p1"));

    // Leading-edge save fires immediately.
    setScrollY(123);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("123");

    // Within the throttle window the next scroll is suppressed.
    setScrollY(456);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("123");

    // After the throttle window elapses, the next scroll persists again.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    setScrollY(789);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}p1`)).toBe("789");

    unmount();
  });

  it("(a2) the restore target is captured at mount and survives a fresh scroll@0 clobber", () => {
    vi.useFakeTimers();
    // A previous session saved 500.
    window.sessionStorage.setItem(`${KEY_PREFIX}clob`, "500");

    const { result } = renderHook(() => useScrollPosition("clob"));

    // On load the page is at the top; a scroll@0 fires and overwrites storage
    // with 0. This is exactly the clobber the synchronous mount-capture defends
    // against: the stored value becomes "0", but the target was already captured.
    setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(window.sessionStorage.getItem(`${KEY_PREFIX}clob`)).toBe("0");

    // Restore still scrolls to 500 (the captured target), NOT the clobbered 0.
    // If the capture were moved into an effect (after handlers register), it
    // would read the clobbered 0 and this assertion would fail.
    setScrollHeight(2000); // maxScroll = 1200 >= 500, held steady -> settles
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(a3) is idempotent: re-asserting the same target does not scroll again", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}once`, "500");
    setScrollHeight(2000); // tall enough + steady -> settles

    const { result } = renderHook(() => useScrollPosition("once"));
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // Simulate the browser now being at the restored position.
    setScrollY(500);

    // A second call (e.g. the wiring effect re-running on [showStatic, editor,
    // restoreScrollPosition]) must NOT scroll again: the redundancy guard sees
    // the window is already at the target and does nothing.
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("(b) does not restore when the URL has a #hash anchor", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p2`, "500");
    // Content is ALREADY tall enough (maxScroll = 2000 - 800 = 1200 >= 500) and
    // steady, so without the hash guard the wait would settle and scroll to the
    // target. The assertion below therefore genuinely proves the hash guard
    // short-circuits before any scroll (not just that the wait has not fired).
    setScrollHeight(2000);
    window.location.hash = "#some-heading";

    const { result } = renderHook(() => useScrollPosition("p2"));
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(5000);
    });

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(f) cancels the in-flight restore poll on unmount (no scroll on the next page)", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p7`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet, so it polls.

    const { result, unmount } = renderHook(() => useScrollPosition("p7"));
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled(); // still polling

    // Navigate away (the hook unmounts) BEFORE the content grows tall enough.
    unmount();

    // Content of the NEXT page becomes tall; advancing time must NOT resurrect
    // the cancelled poll (without the cleanup it would scroll the new page).
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(g) does not restore if the reader scrolled (wheel) before restore fires", () => {
    window.sessionStorage.setItem(`${KEY_PREFIX}g1`, "500");
    setScrollHeight(2000); // tall enough (would settle and restore, absent the wheel)

    const { result } = renderHook(() => useScrollPosition("g1"));

    // The reader shows scroll intent before restore is triggered.
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    act(() => {
      result.current.restoreScrollPosition();
    });

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(h) aborts an in-flight restore poll when the reader scrolls", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}h1`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet, so it polls.

    const { result } = renderHook(() => useScrollPosition("h1"));
    act(() => {
      result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled(); // still polling

    // The reader takes over mid-poll: this cancels the in-flight poll.
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });

    // Content of the page grows tall enough and time passes: the cancelled poll
    // must NOT resurrect and yank the reader.
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(i) a non-scroll keydown does NOT abort restore", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}i1`, "500");
    setScrollHeight(2000); // tall enough + steady -> settles

    const { result } = renderHook(() => useScrollPosition("i1"));

    // A non-scroll key (e.g. typing, a shortcut) must NOT count as scroll intent.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(500);
    });

    // Restore still happens: the innocuous keypress did not disable it.
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(j) a scroll keydown (Space) DOES abort restore", () => {
    window.sessionStorage.setItem(`${KEY_PREFIX}j1`, "500");
    setScrollHeight(2000); // tall enough (would settle and restore, absent the scroll key)

    const { result } = renderHook(() => useScrollPosition("j1"));

    // Space scrolls the page: this is real scroll intent and must abort restore.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    });
    act(() => {
      result.current.restoreScrollPosition();
    });

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(c) does nothing when nothing is saved or the saved value is <= 0", () => {
    // Nothing saved.
    const a = renderHook(() => useScrollPosition("nope"));
    act(() => {
      a.result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled();

    // Saved value <= 0.
    window.sessionStorage.setItem(`${KEY_PREFIX}zero`, "0");
    const b = renderHook(() => useScrollPosition("zero"));
    act(() => {
      b.result.current.restoreScrollPosition();
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("(d) scrolls to the saved Y once the height settles tall enough", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p4`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700, target not yet reachable.

    const { result } = renderHook(() => useScrollPosition("p4"));
    act(() => {
      result.current.restoreScrollPosition();
      vi.advanceTimersByTime(300);
    });

    // Still waiting: content not laid out tall enough yet.
    expect(window.scrollTo).not.toHaveBeenCalled();

    // Content becomes tall enough and then holds steady past the stable window:
    // maxScroll = 2000 - 800 = 1200 >= 500.
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(d3) waits for the height to STOP changing before restoring", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p4b`, "500");
    setInnerHeight(800);
    setScrollHeight(2000); // reachable from the start (maxScroll 1200 >= 500)...

    const { result } = renderHook(() => useScrollPosition("p4b"));
    act(() => {
      result.current.restoreScrollPosition();
    });

    // ...but the height keeps changing every tick, so it never settles.
    act(() => {
      vi.advanceTimersByTime(100);
      setScrollHeight(2500);
      vi.advanceTimersByTime(100);
      setScrollHeight(3000);
      vi.advanceTimersByTime(100);
      setScrollHeight(3500);
      vi.advanceTimersByTime(100);
    });
    expect(window.scrollTo).not.toHaveBeenCalled(); // reachable, but not settled

    // Height now holds steady past HEIGHT_STABLE_MS -> restore fires (to the
    // fixed target, unaffected by the taller document).
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(d2) clamps to the max reachable position after the timeout", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}p5`, "5000");
    setInnerHeight(800);
    setScrollHeight(1000); // maxScroll stays 200, never reaches 5000.

    const { result } = renderHook(() => useScrollPosition("p5"));
    act(() => {
      result.current.restoreScrollPosition();
    });

    // Advance past the 5s timeout; restore should fire clamped to maxScroll.
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 200, behavior: "auto" });
  });

  it("(k) a re-trigger while the wait is running does not start a second concurrent poll", () => {
    // Both triggers (early on-mount + post-swap) call restore. The
    // `if (pollTimerRef.current !== null) return` guard makes a re-trigger during
    // an in-flight wait a no-op, so exactly ONE poll runs and scrolls exactly once.
    // A mutant dropping that guard would start a second parallel poll; since the
    // stubbed scrollTo never moves window.scrollY, the second poll would scroll
    // again (redundancy guard sees scrollY still 0 != target) -> two calls, and
    // this assertion would fail.
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}k1`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // too short -> the first wait keeps polling (no scroll yet)

    const { result } = renderHook(() => useScrollPosition("k1"));

    // First trigger: starts the wait.
    act(() => {
      result.current.restoreScrollPosition();
    });
    // Second trigger while the first wait is still running: the guard suppresses it.
    act(() => {
      result.current.restoreScrollPosition();
    });

    // Content becomes reachable and holds steady past the stable window.
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Exactly one scroll — the guard prevented a second concurrent poll.
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("(e) never throws when storage access throws", () => {
    const err = new Error("storage denied");
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw err;
    });
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw err;
    });

    expect(() => {
      const { result, unmount } = renderHook(() => useScrollPosition("p6"));
      act(() => {
        setScrollY(42);
        window.dispatchEvent(new Event("scroll"));
        result.current.restoreScrollPosition();
      });
      unmount();
    }).not.toThrow();
  });
});

describe("hasSavedReadingPosition", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns false when nothing is saved for the page", () => {
    expect(hasSavedReadingPosition("none")).toBe(false);
  });

  it("returns false when the saved value is 0 (page stays at the top)", () => {
    window.sessionStorage.setItem(`${KEY_PREFIX}zero`, "0");
    expect(hasSavedReadingPosition("zero")).toBe(false);
  });

  it("returns true when a positive position is saved", () => {
    window.sessionStorage.setItem(`${KEY_PREFIX}deep`, "500");
    expect(hasSavedReadingPosition("deep")).toBe(true);
  });
});
