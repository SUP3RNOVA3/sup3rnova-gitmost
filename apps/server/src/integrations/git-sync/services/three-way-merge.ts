/**
 * Pure block-level THREE-WAY merge planner (diff3) over arrays of opaque block
 * keys. Used by the git-sync body write to merge an incoming git body into the
 * live page using the last-synced version as the common ancestor (review #5):
 *
 *   - a block only the human changed (live != base, git == base) -> keep LIVE
 *   - a block only git changed       (git != base, live == base) -> take GIT
 *   - a block both sides changed (a real conflict)               -> GIT wins
 *   - inserts/deletes from either side are preserved when unambiguous
 *
 * Content-agnostic: it works on string keys and returns the merged block order as
 * picks ({ src: 'live'|'target', index }) — the caller (the Yjs applier)
 * materializes them — so the whole algorithm is unit-testable on plain arrays.
 *
 * Algorithm: anchor on base blocks present (unchanged) in BOTH live and target
 * (their LCS-with-base intersection). Between consecutive anchors lies one region
 * the human and/or git rewrote; resolve each region three-way. Stable anchor
 * blocks are emitted from LIVE so the applier keeps the existing Yjs block
 * instances (and the human's in-flight edits) in place.
 */

/** Matched index pairs of the longest common subsequence of `a` and `b`. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** o-index -> matched index in the other side (only for LCS-matched blocks). */
function matchMap(pairs: Array<[number, number]>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [o, x] of pairs) m.set(o, x);
  return m;
}

const keysEqual = (x: string[], y: string[]): boolean =>
  x.length === y.length && x.every((v, k) => v === y[k]);

/**
 * Resolve one region (the live slice, target slice, and base slice that occupy
 * the same span between two anchors). 'target' (git) wins ties and conflicts.
 */
function decideRegion(
  aRegion: string[],
  bRegion: string[],
  oRegion: string[],
): 'live' | 'target' {
  if (keysEqual(aRegion, bRegion)) return 'target'; // same edit on both sides
  if (keysEqual(aRegion, oRegion)) return 'target'; // live unchanged -> git's edit
  if (keysEqual(bRegion, oRegion)) return 'live'; // git unchanged -> human's edit
  return 'target'; // genuine conflict -> git wins
}

export interface Pick {
  src: 'live' | 'target';
  index: number;
}

/**
 * Three-way merge of base `o`, live `a`, target `b` (arrays of block keys).
 * Returns the merged block order as picks from live/target.
 */
export function diff3Plan(o: string[], a: string[], b: string[]): Pick[] {
  const oToA = matchMap(lcsPairs(o, a));
  const oToB = matchMap(lcsPairs(o, b));

  const res: Pick[] = [];
  let oi = 0;
  let ai = 0;
  let bi = 0;

  for (;;) {
    // Next anchor: a base block present (unchanged) in BOTH live and target.
    let anchor = oi;
    while (anchor < o.length && !(oToA.has(anchor) && oToB.has(anchor))) {
      anchor++;
    }
    const aEnd = anchor < o.length ? (oToA.get(anchor) as number) : a.length;
    const bEnd = anchor < o.length ? (oToB.get(anchor) as number) : b.length;

    // Resolve the region [oi,anchor) that one or both sides rewrote/inserted.
    const take = decideRegion(
      a.slice(ai, aEnd),
      b.slice(bi, bEnd),
      o.slice(oi, anchor),
    );
    if (take === 'live') {
      for (let k = ai; k < aEnd; k++) res.push({ src: 'live', index: k });
    } else {
      for (let k = bi; k < bEnd; k++) res.push({ src: 'target', index: k });
    }

    if (anchor >= o.length) break;

    // Emit the stable anchor block from LIVE, then advance past it on all sides.
    res.push({ src: 'live', index: aEnd });
    ai = aEnd + 1;
    bi = bEnd + 1;
    oi = anchor + 1;
  }

  return res;
}
