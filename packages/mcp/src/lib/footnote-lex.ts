/**
 * Shared, fence-aware line lexer for legacy footnote markdown (MCP-internal).
 *
 * Since #293 STEP 5 the markdown -> ProseMirror IMPORT path lives in the shared
 * `@docmost/prosemirror-markdown` package (inline `^[body]` footnotes), so this
 * lexer no longer backs an mcp importer. It now backs ONLY the import-time
 * diagnostics (`analyzeFootnotes` in footnote-analyze.ts), which still scan the
 * raw markdown for legacy reference-style `[^id]:` definition lines and surface
 * advisory warnings (duplicate/orphan definitions) about content that is now
 * inert on import. Fence-awareness (a `[^id]:` line inside a ``` / ~~~ block is
 * NOT a definition) is the property the analyzer relies on.
 *
 * NOTE: this is deliberately NOT shared with editor-ext's
 * `extractFootnoteDefinitions` — that lives in a different package and the
 * decoupling between the editor and the MCP mirror is intentional.
 */

/** A footnote DEFINITION line: `[^id]: text` (id + text captured). */
export const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
/** Every footnote REFERENCE `[^id]` in a line (global; id captured). */
export const FOOTNOTE_REF_RE_G = /\[\^([^\]\s]+)\]/g;
/** Opening/closing code fence marker (``` or ~~~). */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

export interface FootnoteLine {
  /** The raw line, verbatim. */
  line: string;
  /**
   * True for a code-fence marker line AND every line inside a fence — footnote
   * syntax on such lines is inert (example text, not real markup). The importer
   * keeps these in the body; the analyzer skips them.
   */
  inFence: boolean;
  /** The parsed definition, when this is a `[^id]: text` line OUTSIDE any fence. */
  definition: { id: string; text: string } | null;
}

/** Classify every line of `markdown`, tracking fenced-code state. Pure. */
export function lexFootnoteLines(markdown: string): FootnoteLine[] {
  const out: FootnoteLine[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (fence === null) fence = marker; // opening fence
      else if (marker === fence) fence = null; // matching closing fence
      out.push({ line, inFence: true, definition: null });
      continue;
    }
    if (fence !== null) {
      out.push({ line, inFence: true, definition: null });
      continue;
    }
    const m = FOOTNOTE_DEF_RE.exec(line);
    out.push({
      line,
      inFence: false,
      definition: m ? { id: m[1], text: m[2] } : null,
    });
  }
  return out;
}

/** Scan a line for every `[^id]` reference, invoking `onRef(id)` for each. */
export function forEachFootnoteReference(
  line: string,
  onRef: (id: string) => void,
): void {
  FOOTNOTE_REF_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_REF_RE_G.exec(line)) !== null) onRef(m[1]);
}
