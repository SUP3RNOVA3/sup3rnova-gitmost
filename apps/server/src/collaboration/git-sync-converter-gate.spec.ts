/**
 * JEST CONFIG NOTE (#119 ESM refactor): this is the one spec that needs the REAL
 * `@docmost/git-sync` converter (not a mock). The package is now ESM, which jest
 * cannot `require()` nor `import()` without --experimental-vm-modules, so the
 * server jest config `moduleNameMapper`s `@docmost/git-sync` to its TS SOURCE and
 * strips the ESM `.js` import suffixes. ts-jest then type-checks that source under
 * the server's (looser) tsconfig and trips a benign narrowing; the global
 * `isolatedModules: true` on the ts-jest transform (apps/server/package.json)
 * makes it transpile-only so this spec loads. Full type-checking of the package
 * is still enforced by its own `tsc`/vitest gates and the server `tsc --noEmit`.
 *
 * §13.1 IDEMPOTENCY GATE — the blocking gate for git-sync Phase B.
 *
 * Proves the `@docmost/git-sync` pure converter is schema-compatible
 * with the server's REAL editor-ext document schema: a representative corpus of
 * editor-ext ProseMirror documents must survive a full round trip through the
 * actual server write path without losing any node / mark / attribute.
 *
 * Pipeline per document (plan §13.1):
 *   1. md   = convertProseMirrorToMarkdown(content)          // git-sync export
 *   2. doc  = await markdownToProseMirror(md)                // git-sync import
 *   3. push `doc` through the REAL editor-ext Yjs write path the server uses:
 *        ydoc       = TiptapTransformer.toYdoc(doc, 'default', tiptapExtensions)
 *        normalized = TiptapTransformer.fromYdoc(ydoc, 'default')
 *      This is exactly what PersistenceExtension does on store
 *      (apps/server/src/collaboration/extensions/persistence.extension.ts:96/115)
 *      with the same `tiptapExtensions` (collaboration.util.ts) and the same
 *      `@hocuspocus/transformer`, so the gate exercises the real schema
 *      validation that runs on a git-sync write (plan §3.3).
 *   4. assert docsCanonicallyEqual(canon(original), canon(normalized)) === true
 *
 * Any node / mark / attr that editor-ext drops (because the git-sync
 * docmost-schema named it differently, or declares a different default) makes
 * the gate FAIL for that document — exactly the schema-divergence plan §3.3 /
 * §13.1 warn about. Genuine, irreducible divergences are isolated into the
 * clearly-named `KNOWN DIVERGENCE` block at the bottom (never silently hidden).
 *
 * Requires the workspace packages built first:
 *   pnpm --filter @docmost/editor-ext build
 *   pnpm --filter @docmost/git-sync  build
 */
import { TiptapTransformer } from '@hocuspocus/transformer';
// Import the server's real schema FIRST so `@docmost/editor-ext` resolves to its
// built CJS `dist` (its `main`). The ESM-only `@docmost/git-sync` package is
// mapped to its TS SOURCE by the jest `moduleNameMapper` (the built ESM cannot
// be `require()`d nor dynamically `import()`ed under jest's node VM), so ts-jest
// transpiles the real converter to CJS here — exercising the actual converter
// the server ships, not a stub.
import { tiptapExtensions } from './collaboration.util';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  canonicalizeContent,
  docsCanonicallyEqual,
} from '@docmost/git-sync';

/**
 * Run a single editor-ext document through the full gate pipeline and return
 * the canonical original vs the canonical doc as it lands after the real Yjs
 * write path, plus the intermediate markdown for diagnostics.
 */
async function runGate(original: any): Promise<{
  md: string;
  imported: any;
  normalized: any;
  canonOriginal: any;
  canonNormalized: any;
}> {
  // 1) editor-ext JSON -> markdown (git-sync export).
  const md = convertProseMirrorToMarkdown(original);

  // 2) markdown -> ProseMirror JSON (git-sync import, docmost-schema).
  const imported = await markdownToProseMirror(md);

  // 3) push through the REAL editor-ext schema via the server's Yjs write path.
  //    toYdoc validates `imported` against tiptapExtensions (throws on an
  //    unknown node, drops unknown attrs); fromYdoc reads it back as the
  //    normalized editor-ext JSON the server would persist.
  const ydoc = TiptapTransformer.toYdoc(imported, 'default', tiptapExtensions);
  const normalized = TiptapTransformer.fromYdoc(ydoc, 'default');

  return {
    md,
    imported,
    normalized,
    canonOriginal: canonicalizeContent(original),
    canonNormalized: canonicalizeContent(normalized),
  };
}

const doc = (...content: any[]) => ({ type: 'doc', content });
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...content: any[]) => ({ type: 'paragraph', content });

// ---------------------------------------------------------------------------
// Corpus: editor-ext ProseMirror documents covering the common node/mark types.
// Node / mark / attr names and DEFAULTS are taken from the real schema —
// editor-ext (packages/editor-ext/src) + the server's tiptapExtensions
// (collaboration.util.ts) — NOT guessed. Where editor-ext materializes a
// non-null default on import (e.g. image.align="center", callout.type, list
// start) the fixture pre-authors that materialized value so the round trip is
// already at its fixpoint (matches how the engine normalizes-on-write, SPEC §11).
// ---------------------------------------------------------------------------
const CORPUS: Record<string, any> = {
  'paragraphs + headings (h1-h3)': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Heading one')] },
    { type: 'heading', attrs: { level: 2 }, content: [text('Heading two')] },
    { type: 'heading', attrs: { level: 3 }, content: [text('Heading three')] },
    para(text('A plain paragraph of text.')),
    para(text('Second paragraph.')),
  ),

  'inline marks (bold/italic/strike/code)': doc(
    para(
      text('normal '),
      text('bold', [{ type: 'bold' }]),
      text(' '),
      text('italic', [{ type: 'italic' }]),
      text(' '),
      text('struck', [{ type: 'strike' }]),
      text(' '),
      text('code', [{ type: 'code' }]),
    ),
  ),

  'links': doc(
    para(
      text('see '),
      text('the site', [
        { type: 'link', attrs: { href: 'https://example.com' } },
      ]),
      text(' for more'),
    ),
  ),

  'bullet list': doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [para(text('first'))] },
      { type: 'listItem', content: [para(text('second'))] },
      { type: 'listItem', content: [para(text('third'))] },
    ],
  }),

  'ordered list': doc({
    type: 'orderedList',
    attrs: { start: 1 },
    content: [
      { type: 'listItem', content: [para(text('one'))] },
      { type: 'listItem', content: [para(text('two'))] },
    ],
  }),

  'task list (checkbox)': doc({
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [para(text('done item'))],
      },
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [para(text('todo item'))],
      },
    ],
  }),

  'blockquote': doc({
    type: 'blockquote',
    content: [para(text('a quoted line')), para(text('second quoted line'))],
  }),

  'callout (info)': doc({
    type: 'callout',
    attrs: { type: 'info' },
    content: [para(text('an informational callout'))],
  }),

  'callout (warning)': doc({
    type: 'callout',
    attrs: { type: 'warning' },
    content: [para(text('a warning callout'))],
  }),

  'code block (with language)': doc({
    type: 'codeBlock',
    attrs: { language: 'typescript' },
    // A fenced code block's body is stored with a trailing newline (the form a
    // markdown ``` fence round-trips to: marked normalizes the code text to end
    // in "\n"). Authoring the fixture at that fixpoint mirrors how the engine
    // normalizes-on-write (SPEC §11): codeBlock + `language` round-trip exactly.
    content: [text('const a: number = 1;\nconsole.log(a);\n')],
  }),

  'horizontal rule': doc(
    para(text('before')),
    { type: 'horizontalRule' },
    para(text('after')),
  ),

  'table (header row + cells)': doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('Name'))],
          },
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('Value'))],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('alpha'))],
          },
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [para(text('1'))],
          },
        ],
      },
    ],
  }),

  // --- editor-ext nodes/marks beyond the original corpus (item #7) ----------
  // Each of these was verified to round-trip CLEANLY through the real gate
  // (export -> markdown -> import -> editor-ext Yjs write path). Fixtures are
  // pre-authored at the engine's normalize-on-write fixpoint (SPEC §11), e.g.
  // details carries the materialized `open:false`, and color marks use the
  // `rgb(...)` form the HTML re-parser normalizes to.

  'mention (user)': doc(
    para(
      text('hi '),
      {
        type: 'mention',
        attrs: {
          id: 'user-123',
          label: 'Alice',
          entityType: 'user',
          entityId: 'user-123',
          creatorId: 'creator-1',
        },
      },
      text(' there'),
    ),
  ),

  'inline math': doc(
    para(
      text('inline '),
      { type: 'mathInline', attrs: { text: 'x^2' } },
      text(' math'),
    ),
  ),

  'block math': doc({ type: 'mathBlock', attrs: { text: 'x^2 + y^2 = z^2' } }),

  'details (collapsible)': doc({
    type: 'details',
    // `open:false` is the value editor-ext materializes on import; pre-authoring
    // it puts the fixture at its round-trip fixpoint.
    attrs: { open: false },
    content: [
      { type: 'detailsSummary', content: [text('Summary line')] },
      { type: 'detailsContent', content: [para(text('hidden body'))] },
    ],
  }),

  'highlight (mark, no color)': doc(
    para(
      text('a '),
      text('highlighted', [{ type: 'highlight' }]),
      text(' word'),
    ),
  ),

  'highlight (mark, with color)': doc(
    para(
      text('a '),
      text('red', [{ type: 'highlight', attrs: { color: 'rgb(255, 0, 0)' } }]),
      text(' word'),
    ),
  ),

  'subscript': doc(
    para(text('H'), text('2', [{ type: 'subscript' }]), text('O')),
  ),

  'superscript': doc(
    para(text('E=mc'), text('2', [{ type: 'superscript' }])),
  ),

  'text color (textStyle)': doc(
    // The HTML re-parser normalizes CSS colors to the `rgb(...)` form, so the
    // fixture pre-authors that form; a `#hex` color would round-trip to the
    // equivalent rgb() and is therefore a value-normalization divergence (see
    // the KNOWN DIVERGENCE block below).
    para(text('green', [{ type: 'textStyle', attrs: { color: 'rgb(0, 255, 0)' } }])),
  ),

  'nested / mixed document': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Mixed')] },
    para(
      text('intro with '),
      text('bold', [{ type: 'bold' }]),
      text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('.'),
    ),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para(text('item with '), text('code', [{ type: 'code' }])),
          ],
        },
        {
          type: 'listItem',
          content: [
            para(text('item with sublist')),
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [para(text('nested a'))] },
                { type: 'listItem', content: [para(text('nested b'))] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { type: 'success' },
      content: [
        para(text('callout body')),
        { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('echo hi\n')] },
      ],
    },
    {
      type: 'blockquote',
      content: [para(text('quote at the end'))],
    },
  ),
};

describe('git-sync converter §13.1 idempotency gate (editor-ext schema)', () => {
  for (const [name, original] of Object.entries(CORPUS)) {
    it(`round-trips losslessly: ${name}`, async () => {
      const { md, canonOriginal, canonNormalized } = await runGate(original);

      const equal = docsCanonicallyEqual(original, canonNormalized);
      if (!equal) {
        // Surface a readable diff so a real divergence is actionable.
        // eslint-disable-next-line no-console
        console.error(
          `\n[GATE FAIL] ${name}\n--- markdown ---\n${md}\n` +
            `--- canonical original ---\n${JSON.stringify(canonOriginal, null, 2)}\n` +
            `--- canonical round-tripped ---\n${JSON.stringify(canonNormalized, null, 2)}\n`,
        );
      }
      expect(equal).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// KNOWN DIVERGENCE — images (isolated so it does NOT silently weaken the gate).
//
// This is NOT a schema-name divergence: the `image` NODE itself round-trips
// through editor-ext fine (it survives toYdoc under the real tiptapExtensions).
// The loss is intrinsic to MARKDOWN, the on-disk transport format git-sync uses:
//
//   1. `convertProseMirrorToMarkdown` emits a standard `![alt](src)` image
//      (markdown-converter.ts case "image"). Standard markdown image syntax has
//      no way to express `width` / `height` / `align`, so those attrs are
//      DROPPED on export and cannot be recovered on import.
//   2. A block-level image is hoisted out of its line by the HTML re-parser,
//      leaving a leading EMPTY paragraph (the same block-image-hoist limitation
//      documented in packages/git-sync/test/fixtures/known-limitations).
//
// The gate documents the EXACT lossy shape below. If the converter is ever
// taught to preserve image dimensions (e.g. by emitting an HTML <img> with
// data-* attrs, as it already does for video/diagrams), these assertions flip
// and the image fixture should be promoted into the green CORPUS above.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 image dimensions preserved (was KNOWN DIVERGENCE)', () => {
  const imageDoc = doc({
    type: 'image',
    attrs: {
      src: 'https://example.com/pic.png',
      width: 640,
      height: 480,
      align: 'center',
    },
  });

  it('preserves width/height/align by exporting an HTML <img> (PR #119 round-trip fix)', async () => {
    const { md, canonNormalized } = await runGate(imageDoc);

    // A top-level image carrying layout attrs is now exported as a schema-
    // matching HTML <img> (the same path video/diagrams already use), so the
    // dimensions and alignment survive the round trip instead of collapsing to
    // bare `![](src)`.
    expect(md.trim()).toBe(
      '<img src="https://example.com/pic.png" width="640" height="480" align="center">',
    );

    // The round-tripped image keeps src + the layout attrs. width/height are
    // re-imported as strings (matching the video/audio/pdf string convention),
    // so assert the values rather than the JS type.
    const imgAttrs = (canonNormalized as any).content[0].attrs;
    expect((canonNormalized as any).content[0].type).toBe('image');
    expect(imgAttrs.src).toBe('https://example.com/pic.png');
    expect(imgAttrs.align).toBe('center');
    expect(String(imgAttrs.width)).toBe('640');
    expect(String(imgAttrs.height)).toBe('480');
  });
});

// ---------------------------------------------------------------------------
// KNOWN DIVERGENCE — text alignment (item #7; isolated, not silently dropped).
//
// editor-ext registers TextAlign for heading+paragraph, and the SERVER schema
// fully supports it — the loss is intrinsic to the MARKDOWN transport:
//
//   • A paragraph's `textAlign` is EXPORTED as `<div align="...">text</div>`
//     (markdown-converter case "paragraph"), but on import the converter's
//     docmost-schema declares `textAlign` WITHOUT a parseHTML mapping, so the
//     `align` attribute is never recovered -> it imports as `textAlign:null`
//     and canonicalizes away. A heading's alignment is not even exported.
//   • Therefore any non-default alignment is dropped on a full round trip.
//
// If the converter is ever taught to parse `align`/`text-align` back onto the
// block, this assertion flips and an aligned-paragraph fixture should be
// promoted into the green CORPUS above.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 KNOWN DIVERGENCE (text alignment dropped)', () => {
  it('drops a paragraph textAlign on the markdown round trip', async () => {
    const alignedDoc = doc({
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [text('centered')],
    });

    const { canonNormalized } = await runGate(alignedDoc);

    // The round-tripped paragraph carries no alignment.
    expect(canonNormalized).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'centered' }] }],
    });
    expect(docsCanonicallyEqual(alignedDoc, canonNormalized)).toBe(false);
  });

  it('drops a heading textAlign (headings do not export alignment at all)', async () => {
    const alignedHeading = doc({
      type: 'heading',
      attrs: { level: 2, textAlign: 'center' },
      content: [text('centered heading')],
    });

    const { md, canonNormalized } = await runGate(alignedHeading);

    // Export is a plain markdown heading — no alignment syntax.
    expect(md.trim()).toBe('## centered heading');
    expect(docsCanonicallyEqual(alignedHeading, canonNormalized)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KNOWN DIVERGENCE — textStyle color is VALUE-NORMALIZED, not lost (item #7).
//
// The textStyle/color mark itself round-trips (the green CORPUS has the rgb()
// form). But a `#hex` color is normalized to the equivalent `rgb(...)` string
// by the HTML re-parser on import, and canonicalize.ts does NOT normalize color
// formats — so a `#hex` original is not STRING-identical to its round trip even
// though the color is semantically preserved. Locked here so the boundary is
// explicit: author color fixtures in rgb() form to stay in the green corpus.
// ---------------------------------------------------------------------------
describe('git-sync converter §13.1 KNOWN DIVERGENCE (textStyle color #hex -> rgb)', () => {
  it('normalizes a #hex text color to rgb() (semantically preserved, string-divergent)', async () => {
    const hexDoc = doc(
      para(text('green', [{ type: 'textStyle', attrs: { color: '#00ff00' } }])),
    );

    const { canonNormalized } = await runGate(hexDoc);

    // Color survives, but as the normalized rgb() string.
    expect(canonNormalized).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'green',
              marks: [{ type: 'textStyle', attrs: { color: 'rgb(0, 255, 0)' } }],
            },
          ],
        },
      ],
    });
    // Not string-identical to the #hex original.
    expect(docsCanonicallyEqual(hexDoc, canonNormalized)).toBe(false);
  });
});
