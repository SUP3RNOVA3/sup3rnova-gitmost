import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// markdown-converter.ts is the weakest pure module (report §2). These golden
// tests close the gaps the base markdown-converter.test.ts leaves open:
// columns/column wrapper, embed/audio/pdf (used to emit nothing), drawio/
// excalidraw data-align presence rule, the remaining inline-mark matrix,
// paragraph.textAlign, subpages + unknown-in-container fallback, escaping
// idempotence, table-cell pipe/newline sanitization, and empty/single-column
// tables. Cases already asserted in the base file are NOT repeated.

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const c = (node: any) => convertProseMirrorToMarkdown(doc(node));
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

describe('columns / column (raw-HTML layout wrapper)', () => {
  it('wraps a multi-column layout as nested data-type divs with the children inside (regression: children unwrapped)', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        { type: 'column', attrs: { width: 50 }, content: [para(text('L'))] },
        { type: 'column', content: [para(text('R'))] },
      ],
    });
    expect(out).toBe(
      '<div data-type="columns" data-layout="two">' +
        '<div data-type="column" data-width="50"><p>L</p></div>' +
        '<div data-type="column"><p>R</p></div>' +
        '</div>',
    );
  });

  it('omits the default widthMode "normal" but emits a non-default one', () => {
    const normal = c({
      type: 'columns',
      attrs: { layout: 'two', widthMode: 'normal' },
      content: [{ type: 'column', content: [para(text('x'))] }],
    });
    expect(normal).not.toContain('data-width-mode');
    const wide = c({
      type: 'columns',
      attrs: { layout: 'two', widthMode: 'full' },
      content: [{ type: 'column', content: [para(text('x'))] }],
    });
    expect(wide).toContain('data-width-mode="full"');
  });
});

describe('embed / audio / pdf (previously emitted nothing — invisible regression)', () => {
  it('embed emits div[data-type="embed"] with src/provider', () => {
    expect(c({ type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } })).toBe(
      '<div data-type="embed" data-src="https://x.com/e" data-provider="iframe"></div>',
    );
  });

  it('audio emits a div-wrapped <audio> with src', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3' } })).toBe(
      '<div><audio src="/a.mp3"></audio></div>',
    );
  });

  it('pdf emits div[data-type="pdf"] with src and name', () => {
    expect(c({ type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf' } })).toBe(
      '<div data-type="pdf" src="/d.pdf" data-name="d.pdf"></div>',
    );
  });
});

describe('drawio / excalidraw data-align asymmetry (SPEC §11)', () => {
  it('drawio: data-align is ABSENT when align is unset', () => {
    const out = c({ type: 'drawio', attrs: { src: '/d.drawio' } });
    expect(out).toBe('<div data-type="drawio" data-src="/d.drawio"></div>');
    expect(out).not.toContain('data-align');
  });

  it('drawio: data-align is PRESENT for a non-default align', () => {
    expect(c({ type: 'drawio', attrs: { src: '/d.drawio', align: 'right' } })).toBe(
      '<div data-type="drawio" data-src="/d.drawio" data-align="right"></div>',
    );
  });

  it('excalidraw: data-align is ABSENT when align is unset', () => {
    const out = c({ type: 'excalidraw', attrs: { src: '/e.excalidraw' } });
    expect(out).toBe('<div data-type="excalidraw" data-src="/e.excalidraw"></div>');
    expect(out).not.toContain('data-align');
  });
});

describe('inline-mark matrix (underline/sub/sup/highlight±color/textStyle/comment)', () => {
  it('emits the schema HTML for each remaining inline mark in one matrix', () => {
    const cases: [any[], string][] = [
      [[{ type: 'underline' }], '<u>m</u>'],
      [[{ type: 'subscript' }], '<sub>m</sub>'],
      [[{ type: 'superscript' }], '<sup>m</sup>'],
      [[{ type: 'highlight' }], '<mark>m</mark>'],
      [
        [{ type: 'highlight', attrs: { color: '#ff0000' } }],
        '<mark style="background-color: #ff0000">m</mark>',
      ],
      [
        [{ type: 'textStyle', attrs: { color: '#00ff00' } }],
        '<span style="color: #00ff00">m</span>',
      ],
      [
        [{ type: 'comment', attrs: { commentId: 'cid-1' } }],
        '<span data-comment-id="cid-1">m</span>',
      ],
      [
        [{ type: 'comment', attrs: { commentId: 'cid-1', resolved: true } }],
        '<span data-comment-id="cid-1" data-resolved="true">m</span>',
      ],
    ];
    for (const [marks, expected] of cases) {
      expect(c(para(text('m', marks)))).toBe(expected);
    }
  });

  it('a textStyle mark with no color emits nothing (plain text passes through)', () => {
    expect(c(para(text('plain', [{ type: 'textStyle', attrs: {} }])))).toBe('plain');
  });

  it('a comment mark with no commentId emits nothing (plain text)', () => {
    expect(c(para(text('plain', [{ type: 'comment', attrs: {} }])))).toBe('plain');
  });
});

describe('paragraph.textAlign -> <div align>', () => {
  it('non-default alignment wraps the paragraph in <div align="...">', () => {
    expect(c({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('x')] })).toBe(
      '<div align="center">x</div>',
    );
  });

  it('textAlign "left" (the default) is NOT wrapped', () => {
    expect(c({ type: 'paragraph', attrs: { textAlign: 'left' }, content: [text('x')] })).toBe('x');
  });
});

describe('subpages token + unknown-in-container fallback', () => {
  it('subpages emits the {{SUBPAGES}} placeholder token', () => {
    expect(c({ type: 'subpages' })).toBe('{{SUBPAGES}}');
  });

  it('an unknown block inside a raw-HTML container is wrapped in <div> (never markdown)', () => {
    // Inside columns the children are rendered as HTML; an unknown block type
    // must NOT fall back to markdown (which would land as literal text on
    // re-import). It is wrapped in a <div> so its children survive.
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        { type: 'column', content: [{ type: 'weirdBlock', content: [para(text('kept'))] }] },
      ],
    });
    expect(out).toBe(
      '<div data-type="columns" data-layout="two">' +
        '<div data-type="column"><div><p>kept</p></div></div>' +
        '</div>',
    );
  });

  it('an unknown TOP-LEVEL block falls back to its children only (markdown context)', () => {
    expect(c({ type: 'totallyUnknown', content: [text('inner')] })).toBe('inner');
  });
});

describe('escaping idempotence (SPEC §11 phantom-diff guard)', () => {
  it('escapeAttr escapes ONLY & and " in an attribute context, and is idempotent', () => {
    // The mathBlock `text` attr goes through escapeAttr. & -> &amp;, " -> &quot;.
    const once = c({ type: 'mathBlock', attrs: { text: 'a & "b"' } });
    expect(once).toBe(
      '<div data-type="mathBlock" data-katex="true" text="a &amp; &quot;b&quot;"></div>',
    );
    // < and > are deliberately NOT escaped (would accumulate on round-trips).
    const angled = c({ type: 'mathBlock', attrs: { text: 'a < b > c' } });
    expect(angled).toContain('text="a < b > c"');
    expect(angled).not.toContain('&lt;');
    expect(angled).not.toContain('&gt;');
  });

  it('encodeMdUrl turns a space into %20 in an image src (single inert URL token)', () => {
    expect(c({ type: 'image', attrs: { alt: 'c', src: '/my pic.png' } })).toBe(
      '![c](/my%20pic.png)',
    );
  });
});

describe('table-cell sanitization (| and newline must not corrupt the GFM row)', () => {
  it('escapes a literal pipe and collapses an inter-block newline in a cell', () => {
    // A cell with a pipe in one paragraph and a second block paragraph: the pipe
    // is escaped to \| and the block join (a space) keeps the row intact.
    const out = c({
      type: 'table',
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [para(text('H'))] },
        ]},
        { type: 'tableRow', content: [
          { type: 'tableCell', content: [para(text('a|b')), para(text('c'))] },
        ]},
      ],
    });
    expect(out).toBe('| H |\n| --- |\n| a\\|b c |');
  });
});

describe('empty / single-column tables', () => {
  it('a table with no rows renders as the empty string', () => {
    expect(c({ type: 'table', content: [] })).toBe('');
  });

  it('a single-column GFM table emits one column with a "---" separator', () => {
    const out = c({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('Only'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('v'))] }] },
      ],
    });
    expect(out).toBe('| Only |\n| --- |\n| v |');
  });
});
