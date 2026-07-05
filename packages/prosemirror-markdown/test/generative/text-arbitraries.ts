/**
 * Hostile inline-text corpus for the generative flat-document round-trip suite
 * (#351, PR 1).
 *
 * These arbitraries are a DIRECT PORT of the "supported space" guardrails that
 * `test/markdown-roundtrip.property.test.ts` proved empirically against the live
 * converter. That file's long header documents WHY each guardrail exists; rather
 * than re-derive them, we reuse the exact same shapes here so the attribute-level
 * generative suite inherits the same byte-stable text space. Each guardrail is
 * cited back to that file below.
 *
 * The corpus deliberately spans the CommonMark / canon hostile alphabet
 * (`* _ [ ] ( ) { } | < > & # ! ~ = + -`), unicode / emoji / RTL, and the legal
 * mark combinations on runs (including the `code` mark, which the schema's
 * `excludes: "_"` makes suppress every co-occurring mark — so it is never
 * combined with another mark in the byte-stable space).
 */
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Words and the hostile special-character alphabet.
// (Ported from markdown-roundtrip.property.test.ts, "Inline text arbitraries".)
// ---------------------------------------------------------------------------

/** Alphanumeric "word" (no markdown-significant characters). Length 1..6. */
export const wordArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,6}$/)
  .filter((w) => w.length > 0);

/**
 * A SINGLE markdown-significant character, emitted only as an isolated,
 * space-flanked token. Every char the task calls out plus a few more; each was
 * verified byte-stable in this position by the sibling property test.
 *
 * NOTE: the backtick (`) is DELIBERATELY excluded from free-floating plain text
 * (it is a code-span delimiter that re-pairs globally). It is exercised only via
 * the `code` mark and code blocks — see markdown-roundtrip.property.test.ts.
 */
export const specialCharArb = fc.constantFrom(
  '*', '_', '[', ']', '(', ')', '{', '}', '|', '<', '>', '&', '#', '!', '~', '=', '+', '-',
);

// A pinch of unicode / emoji / RTL, always word-like (no markdown specials) so
// it stays inside the space-flanked corpus. Kept letter/emoji-bearing so it is
// never coerced to a number (see letterPhraseArb rationale).
export const unicodeWordArb = fc.constantFrom(
  'café', 'naïve', 'Zürich', 'Москва', 'こんにちは', '你好', '😀', '🚀x', 'مرحبا', 'שלום',
);

/**
 * A "safe special" text string: a space-joined sequence of tokens that always
 * BEGINS and ENDS with an alphanumeric word, with any isolated special chars (or
 * unicode words) confined to the MIDDLE, each space-flanked by words.
 *
 * Both boundary guarantees matter (verbatim from the sibling test):
 *   * Leading word: the line never opens with a block/inline trigger
 *     (">", "*", "-", "#", "1." ...).
 *   * Trailing word: adjacent text runs CONCATENATE with no separator, so a run
 *     ending in a bare "<" beside a run starting with a letter would form a fake
 *     HTML tag. Ending every run with a word keeps every special internal and
 *     space-flanked even after concatenation.
 */
export const safeTextArb: fc.Arbitrary<string> = fc
  .tuple(
    wordArb,
    fc.array(fc.oneof(wordArb, specialCharArb, unicodeWordArb), {
      minLength: 0,
      maxLength: 3,
    }),
    wordArb,
  )
  .map(([first, middle, last]) => [first, ...middle, last].join(' '));

/**
 * A plain alphanumeric phrase (1..3 words) for places where even isolated
 * specials are not wanted (e.g. code-block language, mention labels, status
 * text, table cells rendered on the plain-markdown path).
 */
export const phraseArb: fc.Arbitrary<string> = fc
  .array(wordArb, { minLength: 1, maxLength: 3 })
  .map((ws) => ws.join(' '));

/**
 * A phrase guaranteed to contain at least one letter. Used for image/media alt
 * text and link titles: a PURELY numeric alt/title (e.g. "0") is parsed back as
 * a NUMBER and then dropped by the converter's `value || ""` coercion — not
 * byte-stable. A letter anywhere keeps it a string. (Ported verbatim.)
 */
export const letterPhraseArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z]{1,4}$/),
    fc.array(wordArb, { minLength: 0, maxLength: 2 }),
  )
  .map(([head, rest]) => [head, ...rest].join(' '));

/** A paren/space-free URL — safe inside markdown link/image `(...)` syntax. */
export const urlArb: fc.Arbitrary<string> = fc
  .webUrl()
  .filter((u) => !/[()\s]/.test(u));

// ---------------------------------------------------------------------------
// Marked inline runs.
// (Ported from markdown-roundtrip.property.test.ts "markedTextRunArb".)
// ---------------------------------------------------------------------------

/**
 * A text run with an OPTIONAL single non-code formatting mark (bold/italic/
 * strike/underline/superscript/subscript/spoiler), or a SOLE `code` mark, or a
 * link, or an inline comment anchor. `code` is NEVER combined with another mark
 * in the byte-stable space (that combination is a documented converter
 * limitation — the schema's `code` mark declares `excludes: "_"`). Marks wrap
 * `safeTextArb`, which stays stable even when it contains isolated specials.
 *
 * The mark set here is broadened past the sibling test's {bold,italic,strike}
 * to also cover underline / superscript / subscript / spoiler / textStyle /
 * highlight (all single, non-code marks), so the marks-on-text generator
 * exercises every mark the schema declares except the deliberately-excluded
 * `code`+other combination.
 */
export const markedTextRunArb: fc.Arbitrary<any> = fc.oneof(
  // Plain text.
  safeTextArb.map((t) => ({ type: 'text', text: t })),
  // Single formatting mark (attribute-free marks).
  fc
    .tuple(
      safeTextArb,
      fc.constantFrom('bold', 'italic', 'strike', 'underline', 'superscript', 'subscript', 'spoiler'),
    )
    .map(([t, m]) => ({ type: 'text', text: t, marks: [{ type: m }] })),
  // highlight with a color attr.
  fc
    .tuple(safeTextArb, fc.constantFrom('#ffcc00', '#a0e0ff', 'yellow'))
    .map(([t, color]) => ({ type: 'text', text: t, marks: [{ type: 'highlight', attrs: { color } }] })),
  // textStyle with a color attr.
  fc
    .tuple(safeTextArb, fc.constantFrom('#123456', '#ff0000', '#00aa88'))
    .map(([t, color]) => ({ type: 'text', text: t, marks: [{ type: 'textStyle', attrs: { color } }] })),
  // Sole code mark (backtick span). safeTextArb is backtick-free, so the span
  // content cannot contain an inner backtick.
  safeTextArb.map((t) => ({ type: 'text', text: t, marks: [{ type: 'code' }] })),
  // Link with safe text, a paren/space-free href, optionally a letter-bearing
  // title (a purely numeric title is coerced to a number and dropped).
  fc
    .tuple(phraseArb, urlArb, fc.option(letterPhraseArb, { nil: undefined }))
    .map(([t, href, title]) => ({
      type: 'text',
      text: t,
      marks: [{ type: 'link', attrs: title ? { href, title } : { href } }],
    })),
  // Inline comment anchor: a span[data-comment-id] that must survive byte-for-
  // byte. commentId is an alphanumeric token; `resolved` rides only when true.
  fc
    .tuple(safeTextArb, fc.stringMatching(/^[A-Za-z0-9]{4,10}$/), fc.boolean())
    .map(([t, commentId, resolved]) => ({
      type: 'text',
      text: t,
      marks: [
        { type: 'comment', attrs: resolved ? { commentId, resolved: true } : { commentId } },
      ],
    })),
);

// ---------------------------------------------------------------------------
// Inline atoms and inline-content assembly.
// (Ported from markdown-roundtrip.property.test.ts.)
// ---------------------------------------------------------------------------

/** Inline math node carrying LaTeX that includes the `a < b` the task asks for. */
export const mathInlineArb: fc.Arbitrary<any> = fc
  .constantFrom('a < b', 'x^2 + y^2', 'a < b < c', '\\frac{1}{2}', 'E = mc^2')
  .map((text) => ({ type: 'mathInline', attrs: { text } }));

/** Mention node; label/id/entity are plain phrases / uuids. */
export const mentionArb: fc.Arbitrary<any> = fc
  .tuple(phraseArb, fc.uuid(), fc.uuid())
  .map(([label, id, entityId]) => ({
    type: 'mention',
    attrs: { id, label, entityType: 'user', entityId },
  }));

export const hardBreakArb: fc.Arbitrary<any> = fc.constant({ type: 'hardBreak' });

const sameMarks = (a: any[] | undefined, b: any[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * Canonicalize a generated inline-content array the way ProseMirror stores it,
 * then trim the markdown-fragile edges. (Ported verbatim from
 * markdown-roundtrip.property.test.ts "normalizeInline":)
 *   1) MERGE adjacent text runs with IDENTICAL marks (the editor coalesces
 *      them; split same-mark runs export to ambiguous "**a****b**").
 *   2) Collapse CONSECUTIVE hard breaks (two render a blank line marked eats).
 *   3) Drop a TRAILING hard break (removed by the converter's .trim()).
 */
export function normalizeInline(nodes: any[]): any[] {
  const out: any[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === 'hardBreak' && prev && prev.type === 'hardBreak') continue;
    if (
      node.type === 'text' &&
      prev &&
      prev.type === 'text' &&
      sameMarks(prev.marks, node.marks)
    ) {
      prev.text += node.text;
      continue;
    }
    out.push(node.type === 'text' ? { ...node } : node);
  }
  while (out.length > 1 && out[out.length - 1].type === 'hardBreak') out.pop();
  return out;
}

/**
 * Inline content for a paragraph: at least one marked text run, optionally with
 * inline atoms (math/mention) and hard breaks interspersed. Always starts with a
 * text run so the paragraph never opens with a block trigger. (Ported.)
 */
export const inlineContentArb: fc.Arbitrary<any[]> = fc
  .tuple(
    markedTextRunArb,
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: markedTextRunArb },
        { weight: 1, arbitrary: mathInlineArb },
        { weight: 1, arbitrary: mentionArb },
        { weight: 1, arbitrary: hardBreakArb },
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([first, rest]) => normalizeInline([first, ...rest]));

/**
 * Inline content for a HEADING — identical to a paragraph's, but WITHOUT hard
 * breaks. A hard break inside an ATX heading is not byte-stable (marked splits
 * the heading). (Ported.)
 */
export const headingInlineContentArb: fc.Arbitrary<any[]> = fc
  .tuple(
    markedTextRunArb,
    fc.array(
      fc.oneof(
        { weight: 5, arbitrary: markedTextRunArb },
        { weight: 1, arbitrary: mathInlineArb },
        { weight: 1, arbitrary: mentionArb },
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([first, rest]) => normalizeInline([first, ...rest]));

/** Simple plain-text inline content (single run) for containers rendered on the
 * raw-HTML path (table cells / column bodies) where fancy inline is undesirable. */
export const plainInlineContentArb: fc.Arbitrary<any[]> = phraseArb.map((t) => [
  { type: 'text', text: t },
]);
