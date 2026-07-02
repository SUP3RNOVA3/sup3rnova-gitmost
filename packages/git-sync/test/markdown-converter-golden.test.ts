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

describe('paragraph.textAlign -> <p style="text-align:...">', () => {
  it('non-default alignment emits an HTML <p style="text-align:...">', () => {
    // #7 fix: a non-default paragraph alignment now round-trips. It is exported
    // as an HTML `<p style="text-align:center">` (the schema's paragraph
    // parseHTML reads `style="text-align"` back onto `textAlign` on import), so
    // the alignment survives instead of collapsing to bare text. (The old
    // `<div align="center">` form was NOT re-parsed onto the paragraph and was
    // therefore lossy.)
    expect(c({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('x')] })).toBe(
      '<p style="text-align:center">x</p>',
    );
  });

  it('textAlign "left" (the default) is NOT wrapped', () => {
    expect(c({ type: 'paragraph', attrs: { textAlign: 'left' }, content: [text('x')] })).toBe('x');
  });
});

describe('subpages token + unknown-in-container fallback', () => {
  it('subpages emits the schema-matching div (round-trips, unlike the old {{SUBPAGES}} literal)', () => {
    expect(c({ type: 'subpages' })).toBe('<div data-type="subpages"></div>');
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

describe('multi-block table cell -> HTML <table> (#8: GFM pipes cannot hold block content)', () => {
  it('emits the whole table as HTML <table> so a multi-paragraph cell survives', () => {
    // A cell holding TWO block paragraphs cannot be represented by a GFM pipe
    // row (one inline line only) — the old GFM path collapsed the two blocks
    // into one line ("a\|b c"), losing the block boundary and forcing a fragile
    // pipe-escape. #8 emits the WHOLE table as raw HTML <table> instead: the
    // schema's table-family parseHTML round-trips it, each paragraph stays its
    // own <p>, and the literal pipe needs no escaping inside HTML text.
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
    expect(out).toBe(
      '<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>a|b</p><p>c</p></td></tr></tbody></table>',
    );
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

// ---------------------------------------------------------------------------
// Media / attachment / container full-attribute coverage. The base golden file
// only sets the minimal attrs for each media node (src, or src+name), so the
// optional-attribute emission branches and their exact ORDERING are uncovered.
// These cases pin the full ordered attribute string for video/youtube/embed/
// audio/pdf/attachment plus the all-absent side of every optional guard, and
// the distinct HTML-container (blockToHtml / inlineToHtml) paths for an
// orderedList and a hardBreak inside a column.
// ---------------------------------------------------------------------------
describe('media / attachment / container full-attribute golden coverage', () => {
  it('video: emits all optional attrs in source order (alt->aria-label, attachmentId/size/align/aspectRatio->data-*)', () => {
    expect(
      c({
        type: 'video',
        attrs: {
          src: '/v.mp4',
          alt: 'clip',
          attachmentId: 'att-1',
          width: 640,
          height: 480,
          size: 1234,
          align: 'center',
          aspectRatio: 1.777,
        },
      }),
    ).toBe(
      '<div><video src="/v.mp4" aria-label="clip" data-attachment-id="att-1" width="640" height="480" data-size="1234" data-align="center" data-aspect-ratio="1.777"></video></div>',
    );
  });

  it('video: with only src, every optional guard takes its false branch (src-only <video>, no data-type on wrapper)', () => {
    expect(c({ type: 'video', attrs: { src: '/v.mp4' } })).toBe(
      '<div><video src="/v.mp4"></video></div>',
    );
  });

  it('youtube + embed: each emits its full optional attr set in source order', () => {
    // (a) youtube: width/height/align all present -> data-* in order.
    expect(
      c({
        type: 'youtube',
        attrs: { src: 'https://youtu.be/abc', width: 560, height: 315, align: 'right' },
      }),
    ).toBe(
      '<div data-type="youtube" data-src="https://youtu.be/abc" data-width="560" data-height="315" data-align="right"></div>',
    );
    // (b) embed: align/width/height optional branches after src+provider.
    expect(
      c({
        type: 'embed',
        attrs: { src: 'https://x.com/e', provider: 'iframe', align: 'left', width: 600, height: 400 },
      }),
    ).toBe(
      '<div data-type="embed" data-src="https://x.com/e" data-provider="iframe" data-align="left" data-width="600" data-height="400"></div>',
    );
  });

  it('audio: emits data-attachment-id then data-size after src when both are set', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7', size: 9001 } })).toBe(
      '<div><audio src="/a.mp3" data-attachment-id="att-7" data-size="9001"></audio></div>',
    );
  });

  it('audio: with attachmentId but no size, data-size is suppressed (size != null false branch)', () => {
    expect(c({ type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7' } })).toBe(
      '<div><audio src="/a.mp3" data-attachment-id="att-7"></audio></div>',
    );
  });

  it('pdf: emits the full optional attr set in order (data-name, data-attachment-id, data-size, width, height)', () => {
    expect(
      c({
        type: 'pdf',
        attrs: {
          src: '/d.pdf',
          name: 'd.pdf',
          attachmentId: 'att-9',
          size: 2048,
          width: 800,
          height: 600,
        },
      }),
    ).toBe(
      '<div data-type="pdf" src="/d.pdf" data-name="d.pdf" data-attachment-id="att-9" data-size="2048" width="800" height="600"></div>',
    );
  });

  it('attachment: emits data-attachment-name/mime/size/id in order after the always-present url', () => {
    expect(
      c({
        type: 'attachment',
        attrs: {
          url: '/f.zip',
          name: 'f.zip',
          mime: 'application/zip',
          size: 512,
          attachmentId: 'att-3',
        },
      }),
    ).toBe(
      '<div data-type="attachment" data-attachment-url="/f.zip" data-attachment-name="f.zip" data-attachment-mime="application/zip" data-attachment-size="512" data-attachment-id="att-3"></div>',
    );
  });

  it('attachment: with only a url, no spurious data-attachment-name/mime/size/id appear (all guards false)', () => {
    expect(c({ type: 'attachment', attrs: { url: '/f.zip' } })).toBe(
      '<div data-type="attachment" data-attachment-url="/f.zip"></div>',
    );
  });

  it('orderedList inside a column renders via blockToHtml as <ol> (start attr DROPPED) with bold->strong, code->code', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        {
          type: 'column',
          content: [
            {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [
                {
                  type: 'listItem',
                  content: [para(text('a', [{ type: 'bold' }]))],
                },
                {
                  type: 'listItem',
                  content: [para(text('b', [{ type: 'code' }]))],
                },
              ],
            },
          ],
        },
      ],
    });
    // blockToHtml orderedList path emits a plain <ol> with no start attribute,
    // and inlineToHtml maps bold->strong, code->code.
    expect(out).toContain(
      '<ol><li><p><strong>a</strong></p></li><li><p><code>b</code></p></li></ol>',
    );
    // The start:3 attr is NOT preserved in the HTML/column container path.
    expect(out).not.toContain('start=');
  });

  it('hardBreak inside a column renders as <br> via inlineToHtml (not the markdown two-space form)', () => {
    const out = c({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        {
          type: 'column',
          content: [para(text('a'), { type: 'hardBreak' }, text('b'))],
        },
      ],
    });
    expect(out).toContain('<p>a<br>b</p>');
    // The processNode markdown "  \n" hard-break form must NOT appear in the
    // raw-HTML column container path.
    expect(out).not.toContain('  \n');
  });
});
