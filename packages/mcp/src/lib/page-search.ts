/**
 * Pure, network-free in-page search over a ProseMirror/TipTap document tree.
 *
 * `searchInDoc(doc, query, opts)` finds every occurrence of a literal substring
 * (default) or a regular expression across the page's TEXT CONTAINERS and
 * reports WHERE each match is — the container's ref (for get_node/patch_node;
 * see the SearchMatch.nodeId note for the `#<index>` caveat), the top-level
 * block index, and a short context window around the hit. It never touches the
 * network, the DB, or the schema mirror; like `comment-anchor.ts` it is
 * isolated-testable.
 *
 * REGEX ENGINE: with `regex:true` the pattern is compiled with RE2 (Google's
 * linear-time engine), NOT the JS `RegExp`. RE2 has no backtracking, so a
 * catastrophic pattern (e.g. `(a+)+$`) can never wedge the shared event loop —
 * it runs in linear time. The trade-off is that RE2 does not support the
 * backtracking-only features lookaround (`(?=…)`, `(?<=…)`) and backreferences
 * (`\1`); such a pattern is rejected up front with a clear tool error (see
 * searchInDoc) rather than being run, which is the desired behaviour — a clear
 * error the agent can fix beats a server hang.
 *
 * WHY plain text (not markdown): each container's inline text is glued into ONE
 * string via `blockPlainText`, so a match survives inline-mark boundaries
 * (bold/italic/link splits that fracture a run like "т.е." into several text
 * nodes) and comment-anchor spans never clutter the haystack.
 *
 * The SEARCH UNIT is a text container: a node whose direct children include
 * text nodes (a paragraph/heading, or the paragraph inside a table cell / list
 * item). ProseMirror keeps block vs. inline content exclusive, so a container
 * never nests another container — the walk reaches each cell/item's own text and
 * the context window is naturally scoped to that specific cell/item, not the
 * whole top-level block's glued text.
 */

import RE2 from "re2";

import { blockPlainText } from "./node-ops.js";

/** An RE2 regex instance (RE2 extends `RegExp`, so it is usable as one). */
type Re2Regex = InstanceType<typeof RE2>;

/** True if `value` is a non-null plain object (and not an array). */
function isObject(value: any): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A text container is a node with a `content` array holding at least one text
 * node (a child with a string `text`). These are the paragraphs/headings whose
 * glued inline text we search.
 */
function isTextContainer(node: any): boolean {
  return (
    isObject(node) &&
    Array.isArray(node.content) &&
    node.content.some((c: any) => isObject(c) && typeof c.text === "string")
  );
}

/** Options controlling the search engine and result size. */
export interface SearchOptions {
  /** Treat `query` as a RegExp instead of a literal substring (default false). */
  regex?: boolean;
  /** Case-sensitive matching (default false). */
  caseSensitive?: boolean;
  /** Max matches to RETURN (default 50, clamped to [1, 200]); total is unbounded. */
  limit?: number;
}

/** One located occurrence. */
export interface SearchMatch {
  /**
   * The container's ref, for addressing the block with get_node/patch_node: its
   * `attrs.id` when it has one, otherwise `#<topLevelIndex>` of the nearest
   * top-level block. Table-cell/list-item paragraphs that carry no id fall back
   * to the `#<index>` form.
   *
   * CAVEAT: the `#<index>` form is accepted by get_node (getNodeByRef resolves
   * it by top-level index) but NOT by patch_node (replaceNodeById resolves only
   * by `attrs.id`), so id-less table/cell content can be READ by this ref but
   * not PATCHED by it.
   *
   * To anchor a comment, do NOT pass this ref to create_comment — it has no
   * nodeId parameter. A top-level comment needs an exact-text `selection` that
   * occurs once on the page (it fails if the text isn't found), so build a
   * UNIQUE `selection` from before+match+after and pass THAT as create_comment's
   * `selection`.
   */
  nodeId: string;
  /** The top-level block index (as in get_outline). */
  blockIndex: number;
  /** The container node's type (paragraph/heading/...). */
  type: string | undefined;
  /** ~40 chars of context immediately before the match (from THIS container). */
  before: string;
  /** The matched text. */
  match: string;
  /** ~40 chars of context immediately after the match (from THIS container). */
  after: string;
}

/** The search result. `truncated` is true when `total > matches.length`. */
export interface SearchResult {
  total: number;
  truncated: boolean;
  matches: SearchMatch[];
}

// Result-size defaults/ceiling.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Context window on each side of a match.
const CONTEXT = 40;

// Cheap sanity cap on the query/pattern length. ReDoS is handled structurally
// by the RE2 engine (linear-time, no backtracking — see the module doc), so we
// no longer truncate the per-container text: RE2 scans it in linear time and a
// cap could silently drop real matches past it. This just rejects an absurdly
// long pattern early with a clear error.
const MAX_PATTERN_LENGTH = 1000;

/** Clamp the requested limit into [1, MAX_LIMIT], defaulting when absent. */
function resolveLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Yield the [start, length] of every occurrence of the engine in `text`, in
 * order. A literal engine uses indexOf (case-folded when requested); a regex
 * engine uses a global RE2 regex (RE2 extends `RegExp`, so `.exec` advances
 * `lastIndex` exactly like the native engine). Zero-length regex matches (e.g.
 * `\b`, `a*`) are SKIPPED and lastIndex is advanced, so a pattern that can match
 * the empty string cannot flood the results or spin forever.
 */
function* eachMatch(
  text: string,
  query: string,
  re: Re2Regex | null,
  caseSensitive: boolean,
): Generator<[number, number]> {
  if (re) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const len = m[0].length;
      if (len === 0) {
        // Empty match: advance past this position and do not record it.
        re.lastIndex = m.index + 1;
        continue;
      }
      yield [m.index, len];
    }
    return;
  }

  // Literal engine. For case-insensitive search, fold BOTH sides only to locate
  // the indices; the reported match/context are always sliced from the original
  // text so the caller gets the real casing (needed to build a unique selection).
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const len = needle.length;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return;
    yield [idx, len];
    from = idx + len;
  }
}

/**
 * Search a ProseMirror document for `query` and return `{ total, truncated,
 * matches }`. `total` counts EVERY occurrence (even beyond the limit) and
 * `truncated` flags when the returned list was capped — nothing is silently
 * dropped.
 *
 * Throws a clear, model-actionable error (never a generic failure) on: an
 * empty/whitespace-only query, an over-long pattern, or — with `regex:true` — a
 * pattern RE2 rejects (invalid syntax, or the unsupported lookaround/
 * backreference features), so the agent can fix its input.
 */
export function searchInDoc(
  doc: any,
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  // --- edge-case guards (fail loudly so the agent can correct the call) ---
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(
      "search_in_page: query is empty — pass the text (or regex) to look for.",
    );
  }
  if (query.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `search_in_page: query is too long (${query.length} chars; max ${MAX_PATTERN_LENGTH}). Shorten the search text/pattern.`,
    );
  }

  const caseSensitive = opts.caseSensitive === true;
  const limit = resolveLimit(opts.limit);

  // Compile the pattern up front with RE2 (linear-time, ReDoS-safe) so a bad
  // pattern is a clean tool error rather than a failure deep in the traversal —
  // and so a catastrophic-backtracking pattern can never wedge the event loop.
  // RE2 throws both on syntactically invalid input AND on backtracking-only
  // features it does not implement (lookaround, backreferences); both map to the
  // same actionable error so the agent rewrites the pattern.
  let re: Re2Regex | null = null;
  if (opts.regex === true) {
    try {
      re = new RE2(query, caseSensitive ? "g" : "gi");
    } catch (e) {
      throw new Error(
        `search_in_page: invalid or unsupported regular expression: ${
          e instanceof Error ? e.message : String(e)
        } — RE2 does not support lookaround ((?=…)/(?<=…)) or backreferences (\\1); rewrite the pattern without them.`,
      );
    }
  }

  const matches: SearchMatch[] = [];
  let total = 0;

  const topLevel =
    isObject(doc) && Array.isArray(doc.content) ? doc.content : [];

  // Descend a top-level block, collecting matches from every text container
  // within it. blockIndex/topRef stay pinned to the enclosing top-level block.
  const descend = (node: any, blockIndex: number, topRef: string): void => {
    if (!isObject(node)) return;

    if (isTextContainer(node)) {
      // Glue this container's inline text into one string (mark-safe). No length
      // cap: RE2 scans it in linear time (no ReDoS) and the whole document is
      // already in memory, so truncating would only risk dropping real matches
      // in a very long container.
      const text = blockPlainText(node);

      // The container's own id addresses it verbatim in get_node/patch_node; a
      // container with no id (e.g. a table-cell paragraph) falls back to the
      // top-level block's #<index> (readable via get_node, but not patchable —
      // see the SearchMatch.nodeId note).
      const id =
        isObject(node.attrs) && typeof node.attrs.id === "string" && node.attrs.id.length > 0
          ? node.attrs.id
          : topRef;

      for (const [idx, len] of eachMatch(text, query, re, caseSensitive)) {
        total++;
        if (matches.length < limit) {
          matches.push({
            nodeId: id,
            blockIndex,
            type: node.type,
            before: text.slice(Math.max(0, idx - CONTEXT), idx),
            match: text.slice(idx, idx + len),
            after: text.slice(idx + len, idx + len + CONTEXT),
          });
        }
      }
      // A text container holds inline content only — no nested containers to
      // recurse into.
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) descend(child, blockIndex, topRef);
    }
  };

  for (let i = 0; i < topLevel.length; i++) {
    descend(topLevel[i], i, `#${i}`);
  }

  return { total, truncated: total > matches.length, matches };
}
