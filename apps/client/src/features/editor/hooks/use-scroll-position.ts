import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

// Throttle interval for persisting the scroll position while the user reads.
const SAVE_THROTTLE_MS = 250;
// Give up polling for the live content height after this long and restore to
// the furthest reachable position (handles "collab never finishes laying out").
const MAX_RESTORE_WAIT_MS = 5000;
// How often to re-check the document height while waiting for content to load.
const RESTORE_POLL_MS = 100;
// The document height must stay unchanged this long before we treat the layout
// as settled and safe to restore against — restoring while content is still
// rendering in lets scroll-anchoring drift the saved offset (and re-fire, which
// is the residual reload "jitter" this replaces).
const HEIGHT_STABLE_MS = 400;

// sessionStorage key prefix. sessionStorage survives an F5 in the same tab and
// is cleared on tab close, which is exactly the lifetime we want for an MVP
// "remember where I was reading" feature (self-limiting, no cross-tab leak).
const STORAGE_PREFIX = "gitmost:scroll-position:";

// Keys that scroll the window. Only these count as scroll intent for keydown;
// other keys (shortcuts, modifiers, typing) must NOT disable scroll restore.
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ", // Space (and Shift+Space) scroll the page
]);

function storageKey(pageId: string): string {
  return `${STORAGE_PREFIX}${pageId}`;
}

// All storage access is wrapped: private mode / quota / disabled storage must
// never throw out of the hook and break the page.
function readStorage(pageId: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(pageId));
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    // Best-effort feature: storage may be unavailable (private mode / quota).
    // No user-facing notification (a missed scroll restore is not actionable),
    // but log per the AGENTS.md "errors must never be swallowed" rule.
    console.warn("[useScrollPosition] sessionStorage read failed", err);
    return null;
  }
}

function writeStorage(pageId: string, scrollY: number): void {
  try {
    window.sessionStorage.setItem(storageKey(pageId), String(Math.round(scrollY)));
  } catch (err) {
    // Storage unavailable (private mode / quota). Non-actionable for the user,
    // but log it rather than swallow silently (AGENTS.md error-handling rule).
    console.warn("[useScrollPosition] sessionStorage write failed", err);
  }
}

/**
 * Whether a positive reading position is saved for this page — i.e. the page
 * will be scrolled away from the top on load. Used by the title editor to avoid
 * auto-focusing (and thus placing the caret in) the now-off-screen title.
 * Returns false when nothing is saved or storage is unavailable.
 */
export function hasSavedReadingPosition(pageId: string): boolean {
  const y = readStorage(pageId);
  return typeof y === "number" && y > 0;
}

/**
 * Persists and restores the window scroll position per page so a reader keeps
 * their place across a reload (F5) or reopening the document.
 *
 * Returns `restoreScrollPosition`, which the page editor calls from two triggers
 * (early on mount + after the static->live editor swap). It WAITS for the
 * document height to stop changing (the layout to settle) and then scrolls once
 * to the saved offset — so it never fires mid-render, where scroll-anchoring
 * would drift the position. It is idempotent: a running wait suppresses a second
 * trigger, and once positioned re-asserting is a no-op. The two scroll mechanisms
 * are mutually exclusive: if the URL has a `#hash` anchor, the existing
 * anchor-scroll logic wins and restore is a no-op.
 */
export function useScrollPosition(pageId: string): {
  restoreScrollPosition: () => void;
} {
  // CONTRACT: this hook assumes PageEditor REMOUNTS per page — page.tsx renders
  // `<MemoizedFullEditor key={page.id} ...>`, so switching pages creates a fresh
  // hook instance with fresh refs. Restore is idempotent and interaction-gated
  // (not single-shot): it may be called from several triggers and re-asserts the
  // SAME captured target, which is a no-op once the window is already positioned.
  // The per-mount refs that latch are `initialTargetRef` (the captured target)
  // and `userInteractedRef` (the reader has taken over scrolling). They are NOT
  // reset when `pageId` changes in place (only the effect re-runs on [pageId]).
  // If that `key={page.id}` is ever removed, restore would silently break on the
  // 2nd page (refs would hold the first page's target / interaction flag) — in
  // that case the refs must be reset on a pageId change.
  //
  // The target Y captured synchronously at mount, BEFORE any scroll/visibility
  // handler can overwrite the stored value with a fresh 0 (the page starts
  // scrolled to top on load). `null` means "not yet captured".
  const initialTargetRef = useRef<number | null>(null);
  // Set once the reader shows unambiguous scroll intent; restore must never yank
  // a reader who has already started scrolling.
  const userInteractedRef = useRef(false);
  // Holds the in-flight restore poll timer so the cleanup can cancel it: without
  // this, a fast SPA navigation away mid-poll would let the old page's poll fire
  // window.scrollTo against the NEW page's document (visible wrong-page scroll).
  const pollTimerRef = useRef<number | null>(null);

  // Capture the previously-saved value synchronously during render, before the
  // effect below registers handlers that would persist the current (0) scrollY.
  if (initialTargetRef.current === null) {
    const saved = readStorage(pageId);
    // Store 0 when nothing is saved so the "already captured" check (!== null)
    // holds; restore treats targetY <= 0 as a no-op anyway.
    initialTargetRef.current = saved ?? 0;
  }

  useEffect(() => {
    let throttleTimer: number | null = null;

    const save = () => {
      writeStorage(pageId, window.scrollY);
    };

    // Throttle the high-frequency scroll handler: persist immediately on the
    // leading edge, then at most once per SAVE_THROTTLE_MS.
    const onScroll = () => {
      if (throttleTimer !== null) return;
      save();
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
      }, SAVE_THROTTLE_MS);
    };

    // pagehide fires on reload/navigation (more reliable than unload); save now.
    const onPageHide = () => {
      save();
    };

    // Save when the tab is being backgrounded — covers mobile where pagehide is
    // not always emitted.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        save();
      }
    };

    // User scroll-intent signals. wheel and touch are unconditional scroll
    // intent; keydown is filtered to actual scroll keys only (SCROLL_KEYS) so
    // shortcuts, lone modifiers, and typing do not abort restore. Our own
    // window.scrollTo does NOT emit these, so restore can never self-abort via
    // them. Once the reader shows intent we mark it and cancel any in-flight
    // restore poll so restore can never yank them back. (Scrollbar-drag via
    // pointer is an accepted small gap — it is not covered here.)
    const onUserIntent = (event: Event) => {
      // wheel/touchstart are unambiguous scroll intent; for keydown, only real
      // scroll keys count — a shortcut or typing must not abort restore.
      if (
        event.type === "keydown" &&
        !SCROLL_KEYS.has((event as KeyboardEvent).key)
      ) {
        return;
      }
      userInteractedRef.current = true;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("wheel", onUserIntent, { passive: true });
    window.addEventListener("touchstart", onUserIntent, { passive: true });
    window.addEventListener("keydown", onUserIntent);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("wheel", onUserIntent);
      window.removeEventListener("touchstart", onUserIntent);
      window.removeEventListener("keydown", onUserIntent);
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      // Cancel any in-flight restore poll so it cannot scroll the next page.
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // SPA navigation away from this page: persist the final position.
      save();
    };
  }, [pageId]);

  const restoreScrollPosition = useCallback(() => {
    // The reader took over — never yank them back.
    if (userInteractedRef.current) return;

    // Anchor priority: a `#hash` in the URL is handled by useEditorScroll.
    if (window.location.hash) return;

    const targetY = initialTargetRef.current ?? 0;
    // Nothing meaningful to restore to.
    if (targetY <= 0) return;

    // Idempotent: if a restore poll is already running, do not start a second.
    // Both triggers (early + post-swap) share it; a running poll suppresses the
    // second, and once positioned the redundancy guard makes it a no-op.
    if (pollTimerRef.current !== null) return;

    const start = Date.now();
    let lastHeight = -1;
    let stableSince = start;

    // Restore ONCE the document height has been stable for HEIGHT_STABLE_MS AND
    // the target is reachable, so the saved pixel offset lands on the same content
    // the reader left. Restoring earlier — while the doc is still rendering in
    // (progressive content / static->live swap) — lets scroll-anchoring drift the
    // position and makes the restore re-fire (the reload jitter). The timeout is
    // the only fallback that clamps to the furthest reachable position.
    const tick = () => {
      // Bail mid-wait if the reader started scrolling.
      if (userInteractedRef.current) {
        pollTimerRef.current = null;
        return;
      }

      const now = Date.now();
      const height = document.documentElement.scrollHeight;
      if (height !== lastHeight) {
        lastHeight = height;
        stableSince = now;
      }
      const maxScroll = height - window.innerHeight;
      const settled = now - stableSince >= HEIGHT_STABLE_MS;
      const reachable = maxScroll >= targetY;
      const timedOut = now - start >= MAX_RESTORE_WAIT_MS;

      if ((settled && reachable) || timedOut) {
        const top = Math.min(targetY, Math.max(maxScroll, 0));
        // No-op when already there — avoids a redundant scroll and keeps the two
        // triggers from double-scrolling.
        if (Math.abs(window.scrollY - top) > 1) {
          window.scrollTo({ top, behavior: "auto" });
        }
        pollTimerRef.current = null;
        return;
      }

      // Stored in a ref so the effect cleanup can cancel it on unmount.
      pollTimerRef.current = window.setTimeout(tick, RESTORE_POLL_MS);
    };

    tick();
  }, []);

  return { restoreScrollPosition };
}

/**
 * Wires `useScrollPosition` to the page editor's static->live swap lifecycle.
 *
 * Extracted from PageEditor so the exact restore triggers (their deps and the
 * post-swap `&& editor` guard) are directly unit-testable rather than mirrored.
 * `restoreScrollPosition` waits for the layout to settle and is idempotent, so
 * both triggers together produce a single restore (a running wait suppresses the
 * second; once positioned re-asserting is a no-op).
 *
 * @param pageId      the page whose scroll position is persisted/restored.
 * @param editor      the tiptap editor instance, or `null` until it is ready.
 * @param showStatic  whether the static (cached) content is still shown.
 */
export function useScrollRestoreOnSwap(
  pageId: string,
  editor: Editor | null,
  showStatic: boolean,
): void {
  const { restoreScrollPosition } = useScrollPosition(pageId);

  // Early trigger: start the restore wait on mount, so a reload that never
  // reaches the live editor (offline / collab never syncs — the static cache
  // stays shown) still restores once the static layout settles. The wait itself
  // holds off scrolling until the height is stable, and aborts if the reader
  // starts scrolling (handled inside the hook).
  useLayoutEffect(() => {
    restoreScrollPosition();
  }, [restoreScrollPosition]);

  // Post-swap trigger: after the static -> live swap, (re)start the wait so it
  // measures the final live layout. Idempotent: a no-op while the early wait is
  // still running, and a no-op once already positioned or the reader interacted.
  useLayoutEffect(() => {
    if (!showStatic && editor) restoreScrollPosition();
  }, [showStatic, editor, restoreScrollPosition]);
}
