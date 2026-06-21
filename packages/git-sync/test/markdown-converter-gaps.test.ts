import { describe, expect, it } from 'vitest';
// Import the converter DIRECTLY from src (NOT the docmost-client barrel, which
// pulls in collaboration.ts and mutates the global DOM at import time), matching
// the other converter unit tests. markdownToProseMirror is imported for the
// round-trip cases; loading it mutates the global DOM via jsdom (required for
// @tiptap/html's generateJSON under Node) — this is expected.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// Wrap one or more nodes in a minimal ProseMirror doc. The top-level converter
// joins doc children with "\n\n" then .trim()s, so a single-node doc yields
// exactly that node's rendered (trimmed) string.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const text = (t: string) => ({ type: 'text', text: t });
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

// Run a full export -> import -> export cycle and return both markdown strings
// plus the intermediate ProseMirror doc (mirrors the property test's helper).
async function roundTrip(node: any): Promise<{ md1: string; doc2: any; md2: string }> {
  const md1 = convertProseMirrorToMarkdown(doc(node));
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, doc2, md2 };
}

// ---------------------------------------------------------------------------
// 1. pageBreak DATA LOSS (markdown-converter.ts has NO `case "pageBreak"`).
//
// The schema declares a `pageBreak` block atom (docmost-schema.ts ~L1009), so a
// real document CAN legally contain one. The converter's switch has no branch
// for it, so it falls through to `default`, which renders only the node's
// children — and a pageBreak atom has NONE. It therefore exports to "" and the
// node silently disappears: an exported markdown file can never carry a page
// break, and a round-trip cannot reconstruct it. We pin this as a known
// divergence with an `it.fails` round-trip repro (mirroring the package's two
// existing documented `it.fails` bugs in markdown-roundtrip.property.test.ts).
// ---------------------------------------------------------------------------
describe('pageBreak data loss (no converter case — SPEC §11 divergence)', () => {
  it('exports a pageBreak node to the empty string (the node disappears)', () => {
    // Direct, NON-failing assertion of the lossy emission so the data loss is
    // unambiguous: a standalone pageBreak yields "" (the .trim() of nothing).
    expect(convertProseMirrorToMarkdown(doc({ type: 'pageBreak' }))).toBe('');
  });

  it('drops a pageBreak sitting BETWEEN two paragraphs on export', () => {
    // With surrounding content the lost node leaves no trace at all: the output
    // is just the two paragraphs joined as if the page break were never there.
    const out = convertProseMirrorToMarkdown(
      doc(para(text('before')), { type: 'pageBreak' }, para(text('after'))),
    );
    // The pageBreak renders to "", so the only trace it leaves is a doubled
    // blank gap from the doc "\n\n" join ("before" + "" + "after"): no marker,
    // no placeholder — the divider itself is gone (data loss). The leftover
    // blank line is itself a phantom-diff hazard, but the node is unrecoverable.
    expect(out).toBe('before\n\n\n\nafter');
    expect(out).not.toContain('pageBreak');
  });

  // KNOWN, DOCUMENTED non-roundtrip data loss (kept honest as it.fails): a
  // pageBreak node cannot survive an export -> import -> export cycle because it
  // is erased on the FIRST export. The assertion below is what we WISH held (the
  // node round-trips); it fails today, which `it.fails` turns green while keeping
  // the divergence visible. Source must NOT change — this only documents it.
  it.fails(
    'BUG: a pageBreak node is lost on export and cannot round-trip',
    async () => {
      const { md1, doc2 } = await roundTrip({ type: 'pageBreak' });
      // What we want: the placeholder is non-empty and the node comes back.
      expect(md1).not.toBe('');
      const types = (doc2.content || []).map((n: any) => n.type);
      expect(types).toContain('pageBreak');
    },
  );
});

// ---------------------------------------------------------------------------
// 2. subpages LOSSY round-trip (`case "subpages"` emits `{{SUBPAGES}}`).
//
// The golden test only pins the EMISSION string. The token has no markdown or
// HTML meaning, so on re-import marked treats `{{SUBPAGES}}` as ordinary text:
// the subpages BLOCK comes back as a plain PARAGRAPH carrying that literal
// string, NOT a `subpages` node. The export is "lossy but legible" by design;
// this test pins the actual lossy round-trip behavior.
// ---------------------------------------------------------------------------
describe('subpages lossy round-trip ({{SUBPAGES}} placeholder)', () => {
  it('emits {{SUBPAGES}} which re-imports as a paragraph, not a subpages node', async () => {
    const { md1, doc2 } = await roundTrip({ type: 'subpages' });
    expect(md1).toBe('{{SUBPAGES}}');

    // The re-imported doc has a single paragraph holding the literal token.
    const top = doc2.content || [];
    expect(top).toHaveLength(1);
    expect(top[0].type).toBe('paragraph');
    expect(top[0].content?.[0]).toMatchObject({ type: 'text', text: '{{SUBPAGES}}' });

    // The subpages node itself is gone: nothing in the doc is a subpages node.
    const allTypes = top.map((n: any) => n.type);
    expect(allTypes).not.toContain('subpages');
  });
});

// ---------------------------------------------------------------------------
// 3. column.width number<->string drift (`case "column"` + width parseHTML).
//
// The converter emits the width verbatim into `data-width="..."` (a STRING in
// the HTML, as all HTML attributes are). On import the schema's `column.width`
// parseHTML does `parseFloat(value)`, so the attribute always comes back as a
// NUMBER. A document authored/stored with a STRING fractional width therefore
// DRIFTS to a number across a round-trip at the ProseMirror-doc level — even
// though the emitted MARKDOWN stays byte-stable (the number prints the same).
// Pinned here as a documented attribute-type divergence (SPEC §11).
// ---------------------------------------------------------------------------
describe('column.width number<->string drift (schema parseFloat — SPEC §11)', () => {
  const columnsWith = (width: any) => ({
    type: 'columns',
    attrs: { layout: 'two' },
    content: [
      { type: 'column', attrs: { width }, content: [para(text('L'))] },
      { type: 'column', content: [para(text('R'))] },
    ],
  });

  it('a STRING fractional width drifts to a NUMBER across the round-trip', async () => {
    const { md1, doc2, md2 } = await roundTrip(columnsWith('33.3'));

    // The emitted markdown carries the value as an HTML attribute string and is
    // byte-stable across the cycle (the divergence is at the doc level only).
    expect(md1).toContain('data-width="33.3"');
    expect(md2).toBe(md1);

    // But the doc attribute type changed: authored as string "33.3", it comes
    // back as the number 33.3 (schema's parseFloat). This is the drift.
    const rtWidth = doc2.content?.[0]?.content?.[0]?.attrs?.width;
    expect(typeof rtWidth).toBe('number');
    expect(rtWidth).toBe(33.3);
  });

  it('a NUMBER fractional width keeps its value (no precision loss) and is byte-stable', async () => {
    const { md1, doc2, md2 } = await roundTrip(columnsWith(33.333333));
    expect(md1).toContain('data-width="33.333333"');
    expect(md2).toBe(md1);
    const rtWidth = doc2.content?.[0]?.content?.[0]?.attrs?.width;
    expect(typeof rtWidth).toBe('number');
    expect(rtWidth).toBe(33.333333);
  });
});

// ---------------------------------------------------------------------------
// 5b. EMPTY detailsContent (`case "details"` with an empty body).
//
// detailsContent's schema content is `block*` (docmost-schema.ts ~L474), so an
// empty details body is legal. The converter must handle a `detailsContent`
// with no children without crashing and without emitting invalid output that
// breaks the round-trip. This pins that an empty details body exports cleanly
// and re-imports as a valid `details` whose body is an empty `detailsContent`.
// ---------------------------------------------------------------------------
describe('empty detailsContent (schema allows block*)', () => {
  const emptyDetails = doc({
    type: 'details',
    content: [
      { type: 'detailsSummary', content: [text('Summary')] },
      { type: 'detailsContent', content: [] },
    ],
  });

  it('exports an empty details body without crashing or producing junk', () => {
    const md = convertProseMirrorToMarkdown(emptyDetails);
    // The summary survives and the <details> wrapper closes; the empty body adds
    // no content of its own.
    expect(md).toContain('<summary>Summary</summary>');
    expect(md).toContain('</details>');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('null');
  });

  it('round-trips to a valid details with an empty detailsContent body', async () => {
    const md1 = convertProseMirrorToMarkdown(emptyDetails);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);
    // Export is byte-stable (no growth / no junk on the second pass).
    expect(md2).toBe(md1);

    // The re-imported tree is a details with summary + an empty content body.
    const details = doc2.content?.[0];
    expect(details?.type).toBe('details');
    const childTypes = (details?.content || []).map((c: any) => c.type);
    expect(childTypes).toEqual(['detailsSummary', 'detailsContent']);
    const detailsContent = details.content.find(
      (c: any) => c.type === 'detailsContent',
    );
    // block* — an empty body has no (or empty) content, which is valid.
    expect(detailsContent.content == null || detailsContent.content.length === 0).toBe(
      true,
    );
  });
});
