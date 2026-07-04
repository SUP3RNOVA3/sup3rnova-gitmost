import { RefObject, useCallback, useEffect, useState } from "react";

// Last-resort release deadline. The primary release is the live-content height
// match below; this cap only exists so a slow/short live doc can never pin the
// reservation forever. It is generous (well past when the live content normally
// reaches the reserved height — it renders the SAME content as the static copy)
// so a slow load doesn't release mid-render and reintroduce the collapse.
const RELEASE_CAP_MS = 4000;

/**
 * Reserves the document height across the static -> live editor swap.
 *
 * The live editor lays out its content over a few frames, so replacing the
 * (full-height) static copy with it momentarily shrinks the document; the
 * browser then clamps window scroll to the top, which yanked the reader off
 * their restored reading position (and threw their scroll to 0 if they were
 * scrolling at that moment). Pinning a min-height on the swap wrapper keeps the
 * document tall through the swap so the scroll position simply survives (#266).
 * `reservedHeight === null` means no reservation is active.
 *
 * The capture is intentionally a CALLBACK the page editor invokes, NOT something
 * this hook derives by watching `showStatic`. The height MUST be read
 * synchronously while the static content is still mounted (full natural height),
 * right before the flip to the live branch. By the time any post-transition
 * effect here could run, `showStatic` is already false and the wrapper shows the
 * live/collapsed content, so `offsetHeight` would be wrong. So page-editor calls
 * `captureReservation(wrapper.offsetHeight)` inside its collab-sync effect,
 * before `setShowStatic(false)`, preserving that exact timing.
 *
 * @param showStatic       whether the static (cached) content is still shown.
 * @param menuContainerRef the live-branch content container. It is a descendant
 *   of the swap wrapper inside the live branch, so its `scrollHeight` is the live
 *   content height (not inflated by the ancestor min-height reservation).
 */
export function useSwapHeightReservation(
  showStatic: boolean,
  menuContainerRef: RefObject<HTMLElement | null>,
): {
  reservedHeight: number | null;
  captureReservation: (height: number | null) => void;
} {
  const [reservedHeight, setReservedHeight] = useState<number | null>(null);

  // Capture the current (static, full-height) content height BEFORE the swap so
  // the wrapper can reserve it while the live editor lays out — otherwise the
  // transient shrink clamps window scroll to the top. The caller reads
  // `offsetHeight` synchronously at the swap point and hands it here.
  const captureReservation = useCallback(
    (height: number | null) => setReservedHeight(height),
    [],
  );

  // Release the reserved height once the live editor's content has laid out to
  // at least the reserved height (so removing the reservation cannot collapse
  // the document). The primary release is that height match; the cap is only a
  // last-resort so we never pin forever. A shorter-than-reserved live doc (rare:
  // stale/longer cache) releases at the cap, leaving only harmless bottom dead
  // space until then.
  useEffect(() => {
    if (showStatic || reservedHeight == null) return;
    let raf = 0;
    const startedAt = Date.now();
    const check = () => {
      const liveHeight = menuContainerRef.current?.scrollHeight ?? 0;
      if (
        liveHeight >= reservedHeight ||
        Date.now() - startedAt > RELEASE_CAP_MS
      ) {
        setReservedHeight(null);
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [showStatic, reservedHeight, menuContainerRef]);

  return { reservedHeight, captureReservation };
}
