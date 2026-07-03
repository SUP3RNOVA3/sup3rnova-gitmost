import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { useScrollRestoreOnSwap } from "./hooks/use-scroll-position";

const KEY_PREFIX = "gitmost:scroll-position:";

// NOTE ON SCOPE (F2 — reviewer-approved lighter variant).
//
// The real UX wiring lives in the exported `useScrollRestoreOnSwap` hook (two
// useLayoutEffects around useScrollPosition), which PageEditor calls with the
// same signature. A FULL PageEditor component test is impractical here and has no
// precedent in this client: PageEditor directly constructs a
// HocuspocusProviderWebsocket + IndexeddbPersistence, a tiptap `useEditor` with
// collab extensions, reads jotai atoms, react-router params, the shared
// `queryClient` from main.tsx, i18n, and mounts ~12 editor menu children. Worse,
// the static->live swap (`showStatic` -> false) is gated on
// `isCollabSynced(status, isLocalSynced && isRemoteSynced)`, which can only flip
// by driving the mocked collab provider's async sync callbacks. The heaviest
// component-test precedent in the repo (comment-hover-preview.test.tsx) mounts a
// single leaf component with ONE mocked query; nothing mounts a feature root of
// this weight. Reproducing all of that would test the mocks, not the wiring.
//
// So this file tests the REAL `useScrollRestoreOnSwap` hook — the exact code
// PageEditor imports and calls — driving its `showStatic`/`editor` inputs the way
// the swap does. Because it exercises the real hook (not a copy), dropping the
// `&& editor` guard or changing the effect deps makes these tests fail; they
// guard the production code directly (verified: removing `&& editor` reddens the
// first test).
//
// Both tests observe the real effect via `window.scrollTo`. Restore is NOT
// synchronous: it waits for the document height to settle (HEIGHT_STABLE_MS)
// before scrolling, so the tests use fake timers and advance them with a steady,
// reachable height to let the wait fire. The stubbed `window.scrollTo` never
// mutates `window.scrollY`, so every restore that settles yields exactly one
// `scrollTo` call — making the call count a faithful proxy for restore invocations.

function setScrollY(value: number): void {
  Object.defineProperty(window, "scrollY", { configurable: true, value });
}
function setScrollHeight(value: number): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value,
  });
}
function setInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value });
}

// Minimal stand-in for the tiptap editor: the hook only truthiness-checks it.
const fakeEditor = { id: "editor" } as unknown as Editor;

// Thin host that calls the REAL hook so a rerender drives showStatic/editor
// exactly like the page-editor swap does.
function Host({
  pageId,
  showStatic,
  editor,
}: {
  pageId: string;
  showStatic: boolean;
  editor: Editor | null;
}) {
  useScrollRestoreOnSwap(pageId, editor, showStatic);
  return null;
}

describe("PageEditor scroll-restore wiring (useScrollRestoreOnSwap)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setScrollY(0);
    setScrollHeight(0);
    setInnerHeight(800);
    window.scrollTo = vi.fn();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.location.hash = "";
  });

  it("early trigger restores once the layout settles; post-swap re-assert gated by && editor", () => {
    // Restore WAITS for the document height to settle (HEIGHT_STABLE_MS), so tests
    // advance fake timers. `window.scrollY` stays 0 (stubbed scrollTo never updates
    // it), so scrollTo's call count proxies the number of effective restores.
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}guard`, "500");
    setInnerHeight(800);
    setScrollHeight(2000); // reachable + held steady -> the wait settles

    // Pre-swap: the early on-mount trigger's wait settles and restores once — this
    // is the offline / collab-never-syncs path (no swap needed).
    const { rerender } = render(
      <Host pageId="guard" showStatic={true} editor={null} />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // showStatic flips false but the editor is still null: the post-swap effect
    // re-runs (deps [showStatic, editor] changed) but its `&& editor` guard must
    // keep it a no-op. (Dropping `&& editor` would start a fresh wait against a
    // null editor and produce a 2nd scrollTo, failing this expectation.)
    rerender(<Host pageId="guard" showStatic={false} editor={null} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    // The static -> live swap completes (showStatic false AND editor present): the
    // post-swap effect re-invokes restore, whose fresh wait settles and re-asserts.
    rerender(<Host pageId="guard" showStatic={false} editor={fakeEditor} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
  });

  it("restore waits for the height to settle before scrolling (end-to-end via the hook)", () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}peg`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet.

    // Mount + swap while the content is still too short: nothing scrolls, even as
    // time passes — restore never fires against an unsettled/unreachable layout.
    const { rerender } = render(
      <Host pageId="peg" showStatic={true} editor={null} />,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      rerender(<Host pageId="peg" showStatic={false} editor={fakeEditor} />);
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).not.toHaveBeenCalled();

    // The live content finally lays out tall enough and holds steady past the
    // stable window -> restore fires exactly to the saved target.
    setScrollHeight(2000);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });
});
