/**
 * Locator normalization: strip inline markdown wrappers and trailing
 * decoration from a LOCATOR string so a find/anchor that the model wrote with
 * markdown (or a stray emoji) can still match the document's plain text.
 *
 * This is used ONLY as a fallback for LOCATING (after an exact match fails);
 * it is never applied to replacement text or inserted node content, so no
 * formatting is ever lost.
 *
 * CANONICAL HOME (#414/#493): this is the single source of truth for locator
 * markdown-stripping. `node-ops.ts` (which lives here) uses it directly, and the
 * mcp-side `text-normalize.ts` now IMPORTS `stripInlineMarkdown` and the shared
 * `stripWrappersAndLinks` primitive from here (via `@docmost/prosemirror-markdown`)
 * instead of keeping a drifting copy — mcp only adds its own thin
 * `stripBalancedWrappers`/`closestBlockHint` on top.
 */

/** Maximum unwrap passes, so pathological/nested input cannot loop forever. */
const MAX_PASSES = 8;

/**
 * Inline emphasis/code/strikethrough wrappers, strong BEFORE emphasis so
 * `**x**` collapses to `x` rather than leaving a stray `*x*`. Each pattern is
 * non-greedy and capture group 1 is the inner text. Applied repeatedly until
 * the string stops changing (nested wrappers like `**_x_**`).
 */
const WRAPPER_PATTERNS: RegExp[] = [
  /\*\*([^*]+?)\*\*/g, // **x**
  /__([^_]+?)__/g, // __x__
  /~~([^~]+?)~~/g, // ~~x~~
  /\*([^*]+?)\*/g, // *x*
  /_([^_]+?)_/g, // _x_
  /``([^`]+?)``/g, // ``x``
  /`([^`]+?)`/g, // `x`
];

/**
 * Links/images -> their visible text: `[text](url)` -> `text`, `![alt](src)` ->
 * `alt`. A boolean/string equivalent of `/!?\[([^\]]*)\]\([^)]*\)/g` with `"$1"`,
 * written as a single left-to-right pass. The regex is O(n^2) on a long run of
 * unmatched `[` (each `[` restarts the `[^\]]*` scan and backtracks), so an
 * agent-supplied `replace` of `"[".repeat(100000)` fed through
 * `stripBalancedWrappers` would block the event loop for seconds. This scanner
 * never re-scans: on a `[` that cannot complete a link it jumps `i` past the
 * first `]` (no `[` before it can form a link either), and a missing `]`/`)`
 * short-circuits the rest — so it is O(n) on every input.
 */
function stripLinks(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const bracket =
      s[i] === "!" && s[i + 1] === "[" ? i + 1 : s[i] === "[" ? i : -1;
    if (bracket === -1) {
      out += s[i];
      i++;
      continue;
    }
    const close = s.indexOf("]", bracket + 1);
    if (close === -1) {
      // No `]` anywhere after this `[` — no link can start here or later.
      out += s.slice(i);
      break;
    }
    if (s[close + 1] === "(") {
      const rparen = s.indexOf(")", close + 2);
      if (rparen === -1) {
        // `](` with no closing `)` anywhere after — no link can complete.
        out += s.slice(i);
        break;
      }
      out += s.slice(bracket + 1, close); // the visible text ($1)
      i = rparen + 1;
      continue;
    }
    // `[...]` present but not followed by `(...)`: not a link. Emit up to and
    // including this `]` — no `[` in this span can form a link (its first `]`
    // is this one, which isn't followed by a matched `(...)`).
    out += s.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

/**
 * Apply the two balanced/link passes: first collapse links/images to their
 * visible text, then collapse balanced inline wrappers repeatedly until stable.
 * Does NOT trim decoration, does NOT guard against an empty result — it returns
 * exactly the transformed string.
 */
export function stripWrappersAndLinks(s: string): string {
  // 1. Links/images -> their visible text (linear, see stripLinks).
  let out = stripLinks(s);

  // 2. Strip balanced wrappers, repeating until the string is stable so nested
  //    wrappers (`**_x_**`) and adjacent runs both collapse.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = out;
    for (const re of WRAPPER_PATTERNS) {
      out = out.replace(re, "$1");
    }
    if (out === before) break;
  }
  return out;
}

/**
 * Conservatively strip inline markdown from a locator string.
 *
 * Deterministic, order-fixed steps:
 *  1. Links/images: `[text](url)` -> `text`, `![alt](src)` -> `alt`.
 *  2. Balanced inline wrappers (strong before emphasis, code, strikethrough),
 *     applied repeatedly until stable for nested cases.
 *  3. Trim leading/trailing decoration only: whitespace, leftover marker chars
 *     (`* _ ~ \``) and emoji. Letters/digits and sentence punctuation (`.`/`,`
 *     etc.) are NEVER trimmed.
 *
 * If the result is empty (e.g. the input was only markers like `***`), the
 * ORIGINAL string is returned so a locator can never normalize down to "" and
 * match everything.
 */
export function stripInlineMarkdown(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;

  // 1 + 2. Shared link/image and balanced-wrapper passes.
  let out = stripWrappersAndLinks(s);

  // 3. Trim leading/trailing decoration: whitespace, leftover markdown markers,
  //    and emoji (Extended_Pictographic plus the VS16 / ZWJ joiners, plus the
  //    regional-indicator range U+1F1E6–U+1F1FF for flag emoji, which are NOT
  //    Extended_Pictographic). The `u` flag enables the Unicode property escape.
  //    Anchored runs only — interior text and sentence punctuation are untouched.
  const DECORATION =
    "[\\s*_~\\x60\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{FE0F}\\u{200D}]+";
  out = out
    .replace(new RegExp("^" + DECORATION, "u"), "")
    .replace(new RegExp(DECORATION + "$", "u"), "");

  // 4. Never normalize a locator down to nothing.
  if (out.length === 0) return s;

  return out;
}
