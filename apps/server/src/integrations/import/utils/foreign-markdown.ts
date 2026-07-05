/**
 * Foreign-markdown normalizer — an input-liberal / output-canonical adapter that
 * runs at the IMPORT boundary, BEFORE the canonical parser
 * (`markdownToProseMirror` from `@docmost/prosemirror-markdown`).
 *
 * The canonical parser is deliberately STRICT: it only understands Docmost's
 * canonical markdown surface (Obsidian-style `> [!type]` callouts, Pandoc/Obsidian
 * inline footnotes `^[body]`, lossless `![alt](src) <!--img {...}-->` images, …).
 * Import, however, ingests FOREIGN files (GitHub/GFM, Notion, old Docmost
 * exports). Those use surfaces the canonical parser does not accept, most notably
 * GitHub-flavoured *reference* footnotes:
 *
 *     Text with a note[^1] and another[^long].
 *
 *     [^1]: The first definition.
 *     [^long]: A second one.
 *
 * Left untouched, the parser does NOT recognise `[^id]` (it only parses `^[body]`),
 * so the reference leaks as literal text — and worse, the trailing `[^id]: def`
 * line is a valid CommonMark *link-reference definition*, so `[^id]` is silently
 * rendered as a bogus link. This normalizer rewrites reference footnotes into the
 * canonical inline form so the parser materialises real footnote nodes.
 *
 * This is a TEXT pre-pass, NOT a second parser fork: it does not re-implement any
 * converter logic. Callout surfaces (`:::type` and `> [!type]`) are intentionally
 * NOT touched here — the canonical parser already accepts BOTH natively (its
 * `preprocessCallouts` pass), so normalizing them would be redundant and would
 * only risk degrading the parser's nesting/code-fence-aware handling.
 */

/** Matches a fenced code block delimiter (``` or ~~~), capturing the marker run. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Matches a GFM footnote DEFINITION line: `[^id]: body`. The id is any run of
 * non-`]` characters; the body is the remainder of the line (possibly empty).
 */
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:[ \t]?(.*)$/;

/** True when a line is a code-fence delimiter that toggles fenced-code state. */
function fenceMarker(line: string): string | null {
  const m = line.match(CODE_FENCE_RE);
  return m ? m[2] : null;
}

/** True when a line is indented (leading space/tab) and not blank — a continuation. */
function isIndentedContinuation(line: string): boolean {
  return /^[ \t]+\S/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert GFM reference footnotes (`[^id]` + `[^id]: def`) into canonical inline
 * footnotes (`^[def]`).
 *
 * - Definitions are collected first (a leading `[^id]: text` line plus any
 *   immediately-following indented continuation lines, joined with a space) and
 *   removed from the output.
 * - Each in-text reference `[^id]` for which a definition was found is replaced by
 *   `^[def]`. References with no matching definition are left literal (there is no
 *   body to inline; the parser fails them open the same way).
 * - Code fences are respected on both passes: `[^id]` inside a ``` / ~~~ block is
 *   never rewritten, and a `[^id]:` line inside a fence is never treated as a
 *   definition.
 *
 * Deduplication / reference-ordering / orphan-dropping of the resulting footnotes
 * is handled downstream by the canonical parser (`assembleFootnotes`); this pass
 * only changes the surface syntax.
 */
function convertReferenceFootnotes(markdown: string): string {
  const lines = markdown.split('\n');

  // Pass 1: collect definitions and mark their lines for removal.
  const defs = new Map<string, string>();
  const dropped = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let fence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = fenceMarker(line);
    if (inFence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        inFence = false;
        fence = '';
      }
      continue;
    }
    if (marker) {
      inFence = true;
      fence = marker;
      continue;
    }

    const def = line.match(FOOTNOTE_DEF_RE);
    if (!def) continue;

    const id = def[1];
    const body: string[] = [def[2].trim()];
    dropped[i] = true;

    // Consume immediately-following indented continuation lines (GFM lazy
    // continuation is not supported by design — keep it simple and predictable).
    let j = i + 1;
    while (j < lines.length && isIndentedContinuation(lines[j])) {
      body.push(lines[j].trim());
      dropped[j] = true;
      j++;
    }
    i = j - 1;

    // Last definition wins for a duplicated id (matches CommonMark link-ref
    // semantics closely enough for a foreign-input adapter).
    defs.set(id, body.filter((s) => s.length > 0).join(' '));
  }

  if (defs.size === 0) {
    return markdown;
  }

  // Pass 2: rewrite in-text references, skipping fenced code and dropped lines.
  const out: string[] = [];
  inFence = false;
  fence = '';
  for (let i = 0; i < lines.length; i++) {
    if (dropped[i]) continue;
    let line = lines[i];

    const marker = fenceMarker(line);
    if (inFence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        inFence = false;
        fence = '';
      }
      continue;
    }
    if (marker) {
      inFence = true;
      fence = marker;
      out.push(line);
      continue;
    }

    for (const [id, body] of defs) {
      const ref = new RegExp('\\[\\^' + escapeRegExp(id) + '\\]', 'g');
      line = line.replace(ref, `^[${body}]`);
    }
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Normalize a foreign markdown string into Docmost's canonical markdown surface
 * so the strict canonical parser accepts it losslessly. Currently this rewrites
 * GFM reference footnotes into inline footnotes; add further fixture-driven
 * foreign-surface cases here as they are found.
 */
export function normalizeForeignMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  return convertReferenceFootnotes(markdown);
}
