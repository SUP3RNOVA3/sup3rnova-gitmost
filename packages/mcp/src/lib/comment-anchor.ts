/**
 * Inline-comment anchoring against a ProseMirror document.
 *
 * Docmost stores an inline comment's highlight as a `comment` MARK on the
 * document text (`{ type: "comment", attrs: { commentId, resolved } }`); the
 * `/comments/create` API only records the comment row + its `selection` text and
 * does NOT insert that mark, so the anchor has to be written into the page
 * content separately. This module finds where a selection lives in the document
 * and splices the comment mark across the matched range.
 *
 * Matching has to be robust because the agent supplies the selection as plain
 * text while the document stores rich inline content: a selection can span
 * several adjacent text nodes (inline code / bold / links each become their own
 * text node), and the document may use smart/typographic quotes, dash variants,
 * non-breaking spaces, or collapsed runs of whitespace that the agent typed as
 * ASCII quotes/hyphens/single spaces. We therefore normalize both sides before
 * comparing and match across maximal runs of consecutive text nodes within a
 * single block, while mapping every normalized character back to its raw index
 * so the mark lands on the exact original characters.
 *
 * MARKDOWN-STRIP FALLBACK: when the agent copies a selection that still carries
 * inline markdown (`**bold**`, `` `code` ``, `[t](u)`), the raw locator will not
 * match the document's plain text. Exactly like edit_page_text's json-edit
 * fallback, we first try the verbatim selection and, ONLY if it anchors nowhere
 * in the whole document, retry with `stripInlineMarkdown` applied. `canAnchorInDoc`,
 * `getAnchoredText` and `applyAnchorInDoc` share this decision via
 * `resolveAnchorSelection`. `countAnchorMatches` keeps its OWN parallel exact-wins
 * implementation (it needs a raw match COUNT, not a single resolved locator), kept
 * deliberately in sync with `resolveAnchorSelection`: raw match ⇒ use raw, else fall
 * back to the stripped count. All four therefore agree on which locator matched —
 * the suggestion-uniqueness gate depends on count and can/get never disagreeing, so
 * these two exact-wins implementations MUST stay in sync if either is changed.
 */

import { stripInlineMarkdown } from "./text-normalize.js";

/** Typographic double-quote variants mapped to ASCII `"`. */
const DOUBLE_QUOTES = "«»„“”‟〝〞＂";
/** Typographic single-quote/apostrophe variants mapped to ASCII `'`. */
const SINGLE_QUOTES = "‘’‚‛";
/** Dash variants mapped to ASCII `-`. */
const DASHES = "–—―−‐‑‒";

/** Guard against pathological/cyclic documents in the depth-first walk. */
const MAX_DEPTH = 200;

/** The comment mark Docmost stores on anchored text. */
function makeCommentMark(commentId: string): any {
  // The comment mark schema declares both commentId and resolved; include
  // resolved:false for completeness so the stored mark matches the editor's.
  return { type: "comment", attrs: { commentId, resolved: false } };
}

/** True for any character we collapse/replace with a single normal space. */
function isWhitespaceChar(ch: string): boolean {
  // Regular ASCII whitespace plus the special spaces called out in the spec:
  // nbsp, narrow nbsp, en/em/thin/hair/figure spaces, etc. \s covers tab and
  // newline; the explicit code points cover the non-breaking variants \s misses
  // in some engines, so list them for determinism.
  return (
    /\s/.test(ch) ||
    ch === " " || // no-break space
    ch === " " || // figure space
    ch === " " || // narrow no-break space
    ch === " " || // thin space
    ch === " " || // hair space
    ch === " " || // en space
    ch === " " // em space
  );
}

/**
 * Normalize a string for matching and return both the normalized text and a
 * `map` where `map[i]` is the index into the ORIGINAL `s` of the i-th
 * normalized character.
 *
 * Rules: map smart quotes / dashes / special spaces to their ASCII forms,
 * collapse any run of whitespace to a SINGLE space (whose map entry points at
 * the FIRST raw whitespace char of the run), and DO NOT lowercase (anchoring is
 * case-sensitive to match the exact document text).
 */
export function normalizeForMatch(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isWhitespaceChar(ch)) {
      // Collapse the whole whitespace run to one space mapped to the run start.
      const runStart = i;
      while (i < s.length && isWhitespaceChar(s[i])) i++;
      norm += " ";
      map.push(runStart);
      continue;
    }
    let mapped = ch;
    if (DOUBLE_QUOTES.indexOf(ch) !== -1) mapped = '"';
    else if (SINGLE_QUOTES.indexOf(ch) !== -1) mapped = "'";
    else if (DASHES.indexOf(ch) !== -1) mapped = "-";
    norm += mapped;
    map.push(i);
    i++;
  }
  return { norm, map };
}

/** Descriptor of a matched range inside one block's `content` array. */
export interface AnchorMatch {
  startChild: number;
  startOffset: number;
  endChild: number;
  endOffset: number;
}

/** Per-raw-char location inside a run: which child node and offset within it. */
interface RawLoc {
  childIdx: number;
  offset: number;
}

/**
 * Find a selection inside a SINGLE block's direct `content` array.
 *
 * Builds maximal runs of consecutive `text` nodes (any non-text inline node,
 * e.g. a mention, breaks the run), normalizes each run and the selection the
 * same way, then searches each run for the normalized selection. Returns the
 * child/offset range of the FIRST matching run, or `null` if none match.
 */
export function findAnchorInBlock(
  blockContent: any[],
  selection: string,
): AnchorMatch | null {
  if (!Array.isArray(blockContent)) return null;

  const normSelObj = normalizeForMatch(selection);
  // Trim leading/trailing spaces on the NORMALIZED selection only.
  const normSel = normSelObj.norm.trim();
  if (normSel.length === 0) return null;

  let i = 0;
  while (i < blockContent.length) {
    const node = blockContent[i];
    if (!node || typeof node !== "object" || node.type !== "text") {
      i++;
      continue;
    }
    // Accumulate a maximal run of consecutive text nodes.
    let rawRun = "";
    const rawToChild: RawLoc[] = [];
    let j = i;
    while (j < blockContent.length) {
      const n = blockContent[j];
      if (!n || typeof n !== "object" || n.type !== "text") break;
      const text = typeof n.text === "string" ? n.text : "";
      for (let k = 0; k < text.length; k++) {
        rawToChild.push({ childIdx: j, offset: k });
      }
      rawRun += text;
      j++;
    }

    // Try to match within this run.
    const { norm, map } = normalizeForMatch(rawRun);
    const idx = norm.indexOf(normSel);
    if (idx !== -1) {
      const rawStart = map[idx];
      const rawEndExclusive =
        idx + normSel.length < map.length
          ? map[idx + normSel.length]
          : rawRun.length;
      const startLoc = rawToChild[rawStart];
      // rawEndExclusive points at the raw char AFTER the match; the last matched
      // raw char is at rawEndExclusive-1, so endOffset is its offset + 1.
      const lastLoc = rawToChild[rawEndExclusive - 1];
      return {
        startChild: startLoc.childIdx,
        startOffset: startLoc.offset,
        endChild: lastLoc.childIdx,
        endOffset: lastLoc.offset + 1,
      };
    }

    // No match in this run: continue scanning AFTER it.
    i = j > i ? j : i + 1;
  }
  return null;
}

/**
 * Reconstruct the RAW text spanned by an AnchorMatch inside one block's
 * `content` array. `startChild..endChild` are all text nodes (guaranteed by
 * findAnchorInBlock, which only builds runs of `text` nodes), so concatenate
 * each node's text slice: from `startOffset` on the first node, up to
 * `endOffset` on the last, and the whole `.text` for any node fully inside the
 * range. Mirrors spliceCommentMark's per-node slicing so the string returned
 * here is EXACTLY the characters the comment mark will cover.
 */
function reconstructRawText(blockContent: any[], match: AnchorMatch): string {
  const { startChild, startOffset, endChild, endOffset } = match;
  let out = "";
  for (let k = startChild; k <= endChild; k++) {
    const n = blockContent[k];
    const text: string = typeof n.text === "string" ? n.text : "";
    const sliceStart = k === startChild ? startOffset : 0;
    const sliceEnd = k === endChild ? endOffset : text.length;
    out += text.slice(sliceStart, sliceEnd);
  }
  return out;
}

/**
 * Return the RAW document substring that `selection` would anchor to — the exact
 * characters the comment mark will cover — or `null` when the selection cannot
 * be anchored anywhere in `doc`.
 *
 * This mirrors canAnchorInDoc / applyAnchorInDoc EXACTLY (same depth-first,
 * document-order traversal and the same findAnchorInBlock match on the FIRST
 * matching block), but instead of a boolean / an in-place mutation it
 * reconstructs the raw text spanned by the matched range. Because
 * findAnchorInBlock maps the normalized selection back to raw text-node
 * positions, the returned string is the document's ORIGINAL characters (smart
 * quotes, em-dashes, nbsp, collapsed whitespace) — NOT the normalized ASCII
 * agent input.
 *
 * Callers store THIS as the comment's `selection` so the stored value equals the
 * text actually under the mark, which is what the apply-suggestion equality
 * check (replaceYjsMarkedText's `joinedText !== expectedText`) compares against.
 * Without it a suggestion whose anchor only matched via normalization would be
 * un-appliable (spurious 409).
 */
export function getAnchoredText(doc: any, selection: string): string | null {
  const { selection: effective, found } = resolveAnchorSelection(doc, selection);
  if (!found) return null;
  const visit = (node: any, depth: number): string | null => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return null;
    if (!Array.isArray(node.content)) return null;
    const match = findAnchorInBlock(node.content, effective);
    if (match) return reconstructRawText(node.content, match);
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        const foundText = visit(child, depth + 1);
        if (foundText !== null) return foundText;
      }
    }
    return null;
  };
  return visit(doc, 0);
}

/**
 * RAW (no markdown-strip fallback) depth-first check that `selection` anchors
 * somewhere in `doc`. This is the primitive `resolveAnchorSelection` builds on;
 * public callers should use `canAnchorInDoc`, which adds the strip fallback.
 */
function rawCanAnchorInDoc(doc: any, selection: string): boolean {
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    if (findAnchorInBlock(node.content, selection)) return true;
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        if (visit(child, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(doc, 0);
}

/**
 * Decide the locator that ACTUALLY anchors `selection` in `doc`, applying the
 * markdown-strip fallback once (so every public entry point agrees):
 *  - EXACT WINS: if the verbatim selection anchors anywhere, use it as-is.
 *  - FALLBACK: only if the verbatim selection anchors nowhere, and the
 *    markdown-stripped form differs and DOES anchor, use the stripped form and
 *    flag `normalized` so callers can surface a soft warning.
 *  - otherwise `found` is false and `selection` is returned unchanged.
 *
 * The stripped form is used ONLY to LOCATE the anchor; getAnchoredText still
 * reconstructs and stores the RAW document substring, so the strip never leaks
 * into what gets persisted.
 */
export function resolveAnchorSelection(
  doc: any,
  selection: string,
): { selection: string; found: boolean; normalized: boolean } {
  if (rawCanAnchorInDoc(doc, selection)) {
    return { selection, found: true, normalized: false };
  }
  const stripped = stripInlineMarkdown(selection);
  if (stripped !== selection && rawCanAnchorInDoc(doc, stripped)) {
    return { selection: stripped, found: true, normalized: true };
  }
  return { selection, found: false, normalized: false };
}

/**
 * Depth-first, document-order check for whether `selection` can be anchored
 * anywhere in `doc` (with the markdown-strip fallback). At each node with an
 * array `content`, first try to match within that node's own content, then
 * recurse into children that themselves have a `content` array.
 */
export function canAnchorInDoc(doc: any, selection: string): boolean {
  return resolveAnchorSelection(doc, selection).found;
}

/**
 * Split the matched text nodes and splice the comment mark across the range.
 * `blockContent` is mutated IN PLACE. `match.startChild..endChild` are all text
 * nodes (guaranteed by findAnchorInBlock building runs of text nodes).
 */
function spliceCommentMark(
  blockContent: any[],
  match: AnchorMatch,
  commentId: string,
): void {
  const { startChild, startOffset, endChild, endOffset } = match;
  const commentMark = makeCommentMark(commentId);
  const fragments: any[] = [];

  for (let k = startChild; k <= endChild; k++) {
    const n = blockContent[k];
    const text: string = typeof n.text === "string" ? n.text : "";
    const sliceStart = k === startChild ? startOffset : 0;
    const sliceEnd = k === endChild ? endOffset : text.length;

    const before = k === startChild ? text.slice(0, startOffset) : "";
    const marked = text.slice(sliceStart, sliceEnd);
    const after = k === endChild ? text.slice(endOffset) : "";

    // Process per-node so each node's OWN marks/attrs are preserved.
    const ownMarks: any[] = Array.isArray(n.marks) ? n.marks : [];
    // Drop any pre-existing comment mark from the marked fragment so it ends up
    // with exactly one comment mark (the new one) rather than two.
    const markedBaseMarks = ownMarks.filter(
      (m: any) => !(m && m.type === "comment"),
    );

    if (before.length > 0) {
      fragments.push({ ...n, text: before, marks: [...ownMarks] });
    }
    if (marked.length > 0) {
      fragments.push({
        ...n,
        text: marked,
        marks: [...markedBaseMarks, commentMark],
      });
    }
    if (after.length > 0) {
      fragments.push({ ...n, text: after, marks: [...ownMarks] });
    }
  }

  blockContent.splice(startChild, endChild - startChild + 1, ...fragments);
}

/**
 * Count how many times `selection` occurs across the whole document, using the
 * same normalization and run-matching as findAnchorInBlock but WITHOUT stopping
 * at the first hit: every non-overlapping occurrence within each block's text
 * runs is counted and summed across all blocks (depth-first, the same traversal
 * as canAnchorInDoc).
 *
 * This is the uniqueness gate for SUGGESTIONS: because applying a suggestion
 * rewrites the exact anchored text, an ambiguous anchor (>1 occurrence) would
 * silently edit the wrong place, so a suggestion is only allowed when this
 * returns exactly 1. Ordinary comments keep first-occurrence anchoring and do
 * not use this. (Note: counts OCCURRENCES, not just matching blocks, so two
 * occurrences inside one block are correctly reported as 2.)
 */
function rawCountAnchorMatches(doc: any, selection: string): number {
  const normSel = normalizeForMatch(selection).norm.trim();
  if (normSel.length === 0) return 0;

  // Count non-overlapping occurrences of the normalized selection within a
  // single block's direct content, matching findAnchorInBlock's run building.
  const countInBlock = (blockContent: any[]): number => {
    if (!Array.isArray(blockContent)) return 0;
    let count = 0;
    let i = 0;
    while (i < blockContent.length) {
      const node = blockContent[i];
      if (!node || typeof node !== "object" || node.type !== "text") {
        i++;
        continue;
      }
      // Accumulate a maximal run of consecutive text nodes.
      let rawRun = "";
      let j = i;
      while (j < blockContent.length) {
        const n = blockContent[j];
        if (!n || typeof n !== "object" || n.type !== "text") break;
        rawRun += typeof n.text === "string" ? n.text : "";
        j++;
      }
      const norm = normalizeForMatch(rawRun).norm;
      // Count every non-overlapping occurrence in this run.
      let from = 0;
      for (;;) {
        const idx = norm.indexOf(normSel, from);
        if (idx === -1) break;
        count++;
        from = idx + normSel.length;
      }
      i = j > i ? j : i + 1;
    }
    return count;
  };

  let total = 0;
  const visit = (node: any, depth: number): void => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return;
    if (!Array.isArray(node.content)) return;
    total += countInBlock(node.content);
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(doc, 0);
  return total;
}

/**
 * Uniqueness gate for suggestions, with the SAME markdown-strip fallback as the
 * other entry points so count never disagrees with can/get/apply. EXACT WINS: if
 * the verbatim selection occurs at all, return its raw occurrence count (so a
 * selection that is unique raw stays unique — the fallback never runs and cannot
 * introduce a spurious second match). Only when the verbatim selection is absent
 * do we count occurrences of the markdown-stripped form.
 */
export function countAnchorMatches(doc: any, selection: string): number {
  const raw = rawCountAnchorMatches(doc, selection);
  if (raw > 0) return raw;
  const stripped = stripInlineMarkdown(selection);
  if (stripped !== selection) {
    const strippedCount = rawCountAnchorMatches(doc, stripped);
    if (strippedCount > 0) return strippedCount;
  }
  return 0;
}

/**
 * Depth-first (same order as canAnchorInDoc) over `doc`; on the FIRST block
 * whose content matches `selection`, splice the comment mark across the matched
 * range in place and return true. Returns false (and does NOT mutate) when no
 * block matches.
 */
export function applyAnchorInDoc(
  doc: any,
  selection: string,
  commentId: string,
): boolean {
  const { selection: effective, found } = resolveAnchorSelection(doc, selection);
  if (!found) return false;
  const visit = (node: any, depth: number): boolean => {
    if (depth > MAX_DEPTH || !node || typeof node !== "object") return false;
    if (!Array.isArray(node.content)) return false;
    const match = findAnchorInBlock(node.content, effective);
    if (match) {
      spliceCommentMark(node.content, match, commentId);
      return true;
    }
    for (const child of node.content) {
      if (child && typeof child === "object" && Array.isArray(child.content)) {
        if (visit(child, depth + 1)) return true;
      }
    }
    return false;
  };
  return visit(doc, 0);
}
