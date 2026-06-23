import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// Helper mirroring the convention in markdown-converter.test.ts: wrap atoms in
// a top-level doc node so convertProseMirrorToMarkdown (which requires
// content.content) walks them.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });

describe('diagram round-trip (docmost-schema diagramAttributes)', () => {
  // SPEC case 1: drawio carrying the full numeric-attr surface
  // (data-width/data-height/data-size/data-aspect-ratio) that it shares with
  // audio/video/pdf but which no fixture exercises on a diagram node.
  it('drawio round-trips numeric attrs, coercing number -> string via getAttribute', async () => {
    const input = doc({
      type: 'drawio',
      attrs: {
        src: '/d.drawio',
        attachmentId: 'att-1',
        width: 640,
        height: 480,
        size: 1234,
        aspectRatio: 1.777,
        align: 'center',
      },
    });

    const md1 = convertProseMirrorToMarkdown(input);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // Exact serialized form: numbers render as bare data-* values; attribute
    // order follows the converter's emit order (src, then width/height/size/
    // aspect-ratio/align, then attachment-id).
    expect(md1).toBe(
      '<div data-type="drawio" data-src="/d.drawio" data-width="640" data-height="480" data-size="1234" data-aspect-ratio="1.777" data-align="center" data-attachment-id="att-1"></div>',
    );

    // A second export reproduces the first byte-for-byte (drawio align default
    // is already "center", so nothing new materializes on import).
    expect(md2).toBe(md1);

    // Re-import coerces every numeric attr to a STRING because parseHTML reads
    // them via getAttribute(). This is the gap the reviewer flagged: the
    // number -> string coercion on a diagram node is otherwise untested.
    const attrs2 = doc2.content[0].attrs;
    expect(attrs2.width).toBe('640');
    expect(attrs2.height).toBe('480');
    expect(attrs2.size).toBe('1234');
    expect(attrs2.aspectRatio).toBe('1.777');
    expect(typeof attrs2.width).toBe('string');
    expect(typeof attrs2.aspectRatio).toBe('string');
    // String attrs pass through unchanged.
    expect(attrs2.align).toBe('center');
    expect(attrs2.attachmentId).toBe('att-1');

    // Canonically NOT equal: the numeric -> string coercion survives
    // canonicalization (only align='center' is normalized away via
    // KNOWN_DEFAULTS.drawio), so 640 !== '640' makes the docs differ.
    expect(docsCanonicallyEqual(input, doc2)).toBe(false);
  });

  // SPEC case 2: minimal excalidraw atom with ONLY string attrs (no align, no
  // numeric attrs). Locks the one-time export divergence (align='center'
  // default materializes only on import) plus escapeAttr of title/alt through
  // the data-title/data-alt path.
  it('excalidraw materializes align default only on import and escapes title/alt', async () => {
    const input = doc({
      type: 'excalidraw',
      attrs: {
        src: '/e.excalidraw',
        title: 'My "Diagram"',
        alt: 'a&b',
      },
    });

    const md1 = convertProseMirrorToMarkdown(input);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // First export: no align emitted (the input doc carries no align), and the
    // " in title becomes &quot;, the & in alt becomes &amp; via escapeAttr.
    expect(md1).toBe(
      '<div data-type="excalidraw" data-src="/e.excalidraw" data-title="My &quot;Diagram&quot;" data-alt="a&amp;b"></div>',
    );

    // Second export: align='center' has now materialized (the schema's
    // diagramAttributes default), so md2 gains a data-align="center" suffix and
    // is NOT byte-equal to md1. This one-time divergence is the diagram quirk.
    expect(md2).toBe(
      '<div data-type="excalidraw" data-src="/e.excalidraw" data-title="My &quot;Diagram&quot;" data-alt="a&amp;b" data-align="center"></div>',
    );
    expect(md2).not.toBe(md1);

    // Re-import decodes the escaped entities back to the original characters.
    const attrs2 = doc2.content[0].attrs;
    expect(attrs2.title).toBe('My "Diagram"');
    expect(attrs2.alt).toBe('a&b');
    expect(attrs2.align).toBe('center');

    // Canonically EQUAL: align='center' is normalized away via
    // KNOWN_DEFAULTS.excalidraw, and title/alt are non-default strings that
    // survive on both sides, so the docs are semantically equal.
    expect(docsCanonicallyEqual(input, doc2)).toBe(true);
  });
});
