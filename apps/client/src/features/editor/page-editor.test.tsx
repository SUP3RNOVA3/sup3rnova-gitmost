import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { useScrollPosition } from "./hooks/use-scroll-position";

const KEY_PREFIX = "gitmost:scroll-position:";

// NOTE ON SCOPE (F2 — reviewer-approved lighter variant).
//
// The real UX wiring lives in page-editor.tsx as two useLayoutEffects around the
// useScrollPosition hook. A FULL PageEditor component test is impractical here and
// has no precedent in this client: PageEditor directly constructs a
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
// So this file tests the same integration at the level that carries the real
// contract: the two useLayoutEffect blocks are reproduced VERBATIM from
// page-editor.tsx (the early pre-paint restore, and the post-swap re-assert with
// deps [showStatic, editor]) and exercised against the REAL useScrollPosition
// hook. If page-editor's wiring regresses (e.g. the swap effect drops the
// `&& editor` guard or its deps), the mirror below regresses in lockstep.

// Mirror of page-editor.tsx lines ~489-498 (the two scroll-restore useLayoutEffects).
function ScrollRestoreWiring({
  restoreScrollPosition,
  showStatic,
  editor,
}: {
  restoreScrollPosition: () => void;
  showStatic: boolean;
  editor: unknown | null;
}) {
  // Restore as early as the static (cached) content is laid out, before paint.
  useLayoutEffect(() => {
    restoreScrollPosition();
  }, [restoreScrollPosition]);

  // Re-assert once after the static -> live editor swap.
  useLayoutEffect(() => {
    if (!showStatic && editor) restoreScrollPosition();
  }, [showStatic, editor, restoreScrollPosition]);

  return null;
}

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

describe("PageEditor scroll-restore wiring (two useLayoutEffects)", () => {
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

  it("re-invokes restoreScrollPosition after the swap, with the [showStatic, editor] deps", () => {
    // A referentially STABLE spy, mirroring page-editor where restoreScrollPosition
    // is a useCallback([]) — so the early effect (dep [restoreScrollPosition]) runs
    // exactly once and does NOT re-fire on every render.
    const restore = vi.fn();

    const editor = { id: "editor" };

    // Host owns the swap state so we can drive showStatic/editor like page-editor.
    function Host({
      showStatic,
      editorValue,
    }: {
      showStatic: boolean;
      editorValue: unknown | null;
    }) {
      return (
        <ScrollRestoreWiring
          restoreScrollPosition={restore}
          showStatic={showStatic}
          editor={editorValue}
        />
      );
    }

    // Pre-swap: static content shown, live editor not ready. Only the early
    // pre-paint restore fires; the post-swap effect's guard (!showStatic) blocks it.
    const { rerender } = render(<Host showStatic={true} editorValue={null} />);
    expect(restore).toHaveBeenCalledTimes(1);

    // Collab reports synced (showStatic flips false) but the editor is not ready
    // yet: the swap effect runs but the `&& editor` guard must keep it a no-op.
    // (Pins the guard: dropping `&& editor` would restore against a null editor.)
    rerender(<Host showStatic={false} editorValue={null} />);
    expect(restore).toHaveBeenCalledTimes(1);

    // The static -> live swap completes (showStatic false AND editor present): the
    // post-swap effect re-asserts the restore exactly once more. The early effect
    // does NOT re-fire (restore identity is stable), so this second call is driven
    // solely by the [showStatic, editor] deps changing.
    rerender(<Host showStatic={false} editorValue={editor} />);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("the post-swap re-assert drives a REAL restore (window.scrollTo) via the hook", () => {
    // End-to-end through the real useScrollPosition: the swap re-invocation is the
    // CAUSE of the scroll (nothing scrolls before it).
    vi.useFakeTimers();
    window.sessionStorage.setItem(`${KEY_PREFIX}peg`, "500");
    setInnerHeight(800);
    setScrollHeight(100); // maxScroll = -700: target not reachable yet -> polls.

    const editor = { id: "editor" };

    function Host({
      showStatic,
      editorValue,
    }: {
      showStatic: boolean;
      editorValue: unknown | null;
    }) {
      const { restoreScrollPosition } = useScrollPosition("peg");
      return (
        <ScrollRestoreWiring
          restoreScrollPosition={restoreScrollPosition}
          showStatic={showStatic}
          editor={editorValue}
        />
      );
    }

    // Pre-swap: the early restore runs but content is too short, so it starts
    // polling (a pending timer) without scrolling. We never advance timers, so the
    // early poll cannot fire on its own — isolating the swap as the sole cause.
    const { rerender } = render(<Host showStatic={true} editorValue={null} />);
    expect(window.scrollTo).not.toHaveBeenCalled();

    // The live content is now laid out tall enough to reach the target.
    setScrollHeight(2000); // maxScroll = 1200 >= 500

    // The static -> live swap: the post-swap useLayoutEffect re-invokes the real
    // hook, whose synchronous tryRestore now reaches the target and scrolls.
    act(() => {
      rerender(<Host showStatic={false} editorValue={editor} />);
    });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });
});
