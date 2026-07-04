/**
 * #293 canon #2: inline footnotes `^[text]`.
 *
 * Shared, side-effect-free helpers used by BOTH the serializer
 * (markdown-converter.ts) and the importer (markdown-to-prosemirror.ts) so the
 * two directions cannot drift.
 *
 * The canonical markdown form is Pandoc/Obsidian inline footnotes: the note body
 * is written AT the reference point as `^[body]`; there is no separate
 * `[^id]: …` definition line and no bottom `<section>` list in the markdown. On
 * import the body is re-assembled into the schema's doc-level
 * `footnotesList`/`footnoteDefinition` so the editor sees the usual three-node
 * footnote model, while identical bodies MERGE to a single definition shared by
 * every reference. Ids are assigned by the importer's assembleFootnotes pass
 * (dedup on the EXACT body text -> sequential `fn-N`), NOT derived from a hash,
 * so two DIFFERENT bodies can never collide onto one definition (F1). The id is
 * never written to markdown (`^[body]` carries only text), so the round trip
 * stays byte-stable regardless of the concrete id.
 */

/**
 * Split an ENCODED footnote body (the inner captured between `^[` and its
 * matching `]`, or the value of a `data-fn-text` attribute) into its paragraph
 * markdown strings.
 *
 * Paragraph boundaries are the two-character literal separator `\n` (backslash +
 * n); a REAL backslash-n in the body was encoded as `\\n` (an escaped backslash
 * followed by n) by the serializer, so it must NOT split. The scan therefore
 * treats any `\<char>` as an escaped pair kept verbatim (so `\\` `n` stays a
 * literal backslash-then-n and the trailing `n` is plain), and only an
 * UNescaped `\n` is a separator. Every other backslash escape (`\=`, `\$`,
 * `\[`, …) is preserved untouched so the per-paragraph `parseInline` decodes it.
 */
export function splitFootnoteParagraphs(encoded: string): string[] {
  const paragraphs: string[] = [];
  let current = "";
  let i = 0;
  while (i < encoded.length) {
    const c = encoded[i];
    if (c === "\\" && i + 1 < encoded.length) {
      const next = encoded[i + 1];
      if (next === "n") {
        // Unescaped backslash-n: a paragraph separator.
        paragraphs.push(current);
        current = "";
        i += 2;
        continue;
      }
      // Any other escaped pair (including `\\`) is kept verbatim; consuming
      // BOTH chars is what makes an encoded real `\n` (`\\n`) safe — the `\\`
      // pair is taken here, leaving the following `n` as an ordinary literal.
      current += c + next;
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  paragraphs.push(current);
  return paragraphs;
}
