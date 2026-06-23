import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// ---------------------------------------------------------------------------
// Media / atom node round-trip coverage (audio, video, pdf, attachment, embed,
// youtube). The existing specs (corpus + property test) exercise the EXPORT
// direction of these nodes only; their parseHTML branches (the INVERSE parse of
// the exported HTML) are otherwise unprotected. Each test runs the full
// export -> import -> export pipeline and pins:
//   - the exact md1 byte string the converter emits,
//   - whether md2 is byte-stable (md2 === md1) or grows by a materialized
//     schema default on the first import,
//   - the re-parsed doc2 attrs (NOTE: parseHTML reads via getAttribute and so
//     returns STRINGS for numeric attrs, which is what breaks naive canonical
//     equality), and
//   - docsCanonicallyEqual(doc, doc2) where the spec asserts a specific result.
//
// `convertProseMirrorToMarkdown` requires a full doc ({type:'doc', content:[]}),
// so each spec's `doc=[...]` content array is wrapped via mkDoc().
// ---------------------------------------------------------------------------

/** Wrap a content array (as the specs express `doc`) into a real PM doc. */
const mkDoc = (content: any[]) => ({ type: 'doc', content });

/** export -> import -> export, returning both markdowns and the re-parsed doc. */
async function roundTrip(doc: any) {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

/** Find the first node of a given type anywhere in a PM doc tree. */
const findFirst = (node: any, type: string): any => {
  if (node && node.type === type) return node;
  for (const child of node?.content || []) {
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return null;
};

describe('media atom round-trip (audio/video/pdf/attachment/embed/youtube)', () => {
  // 1. audio with ALL optional attrs ---------------------------------------
  it('audio with src+attachmentId+size: byte-stable, size re-parses to the STRING "9001"', async () => {
    const doc = mkDoc([
      { type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7', size: 9001 } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div><audio src="/a.mp3" data-attachment-id="att-7" data-size="9001"></audio></div>',
    );
    // Byte-stable: a second export reproduces the first exactly.
    expect(md2).toBe(md1);

    const audio = findFirst(doc2, 'audio');
    expect(audio).not.toBeNull();
    expect(audio.type).toBe('audio');
    expect(audio.attrs.src).toBe('/a.mp3');
    expect(audio.attrs.attachmentId).toBe('att-7');
    // NOTE: the schema's data-size parseHTML returns getAttribute() -> a STRING,
    // so the number 9001 comes back as the string '9001'.
    expect(audio.attrs.size).toBe('9001');
  });

  // 2. fully-populated video -----------------------------------------------
  it('video with all attrs: byte-stable; numeric attrs re-parse to STRINGS; canonical equality FALSE', async () => {
    const doc = mkDoc([
      {
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
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div><video src="/v.mp4" aria-label="clip" data-attachment-id="att-1" width="640" height="480" data-size="1234" data-align="center" data-aspect-ratio="1.777"></video></div>',
    );
    expect(md2).toBe(md1);

    const video = findFirst(doc2, 'video');
    expect(video).not.toBeNull();
    expect(video.attrs.alt).toBe('clip');
    // All numeric attrs come back as STRINGS via getAttribute().
    expect(video.attrs.width).toBe('640');
    expect(video.attrs.height).toBe('480');
    expect(video.attrs.size).toBe('1234');
    expect(video.attrs.aspectRatio).toBe('1.777');

    // Byte-stable export but NOT canonically equal: the numeric width/height/
    // size/aspectRatio came back as strings, so deep-equal of the canonical
    // forms fails (align:'center' is normalized away, the numbers are not).
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });

  // 3. minimal video (only src) --------------------------------------------
  it('minimal video (src only): NOT byte-stable (gains data-align="center") but canonically equal', async () => {
    const doc = mkDoc([{ type: 'video', attrs: { src: '/v.mp4' } }]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe('<div><video src="/v.mp4"></video></div>');
    // video.align has a non-null schema default 'center' that materializes on
    // import; the converter only emits data-align when set, so export #2 grows
    // by data-align="center" exactly once (the documented one-time asymmetry).
    expect(md2).toBe('<div><video src="/v.mp4" data-align="center"></video></div>');
    expect(md2).not.toBe(md1);

    // align:'center' is normalized away via KNOWN_DEFAULTS.video, so despite the
    // byte growth the documents ARE canonically equal.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(true);
  });

  // 4. pdf with no numeric attrs (positive control) -------------------------
  it('pdf with src+name+attachmentId (no numerics): byte- AND canonically-stable', async () => {
    const doc = mkDoc([
      { type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf', attachmentId: 'att-9' } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div data-type="pdf" src="/d.pdf" data-name="d.pdf" data-attachment-id="att-9"></div>',
    );
    expect(md2).toBe(md1);

    const pdf = findFirst(doc2, 'pdf');
    expect(pdf).not.toBeNull();
    expect(pdf.attrs.src).toBe('/d.pdf');
    expect(pdf.attrs.name).toBe('d.pdf');
    expect(pdf.attrs.attachmentId).toBe('att-9');

    // No numeric attrs to coerce to strings, so the round-trip is BOTH byte- and
    // canonically-stable (the positive control vs. the numeric-divergence cases).
    expect(docsCanonicallyEqual(doc, doc2)).toBe(true);
  });

  // 5. attachment with numeric size ----------------------------------------
  it('attachment with url+name+mime+size+attachmentId: byte-stable; size STRING; canonical FALSE', async () => {
    const doc = mkDoc([
      {
        type: 'attachment',
        attrs: {
          url: '/f.zip',
          name: 'f.zip',
          mime: 'application/zip',
          size: 512,
          attachmentId: 'att-3',
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div data-type="attachment" data-attachment-url="/f.zip" data-attachment-name="f.zip" data-attachment-mime="application/zip" data-attachment-size="512" data-attachment-id="att-3"></div>',
    );
    expect(md2).toBe(md1);

    const att = findFirst(doc2, 'attachment');
    expect(att).not.toBeNull();
    expect(att.attrs.url).toBe('/f.zip');
    expect(att.attrs.name).toBe('f.zip');
    expect(att.attrs.mime).toBe('application/zip');
    expect(att.attrs.attachmentId).toBe('att-3');
    // data-attachment-size parseHTML -> getAttribute() -> STRING.
    expect(att.attrs.size).toBe('512');

    // The numeric size coerced to a string breaks canonical equality.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });

  // 6. embed WITH explicit width/height/align (byte-stable) ----------------
  it('embed with explicit src+provider+align+width+height: byte-stable; width/height STRINGS', async () => {
    const doc = mkDoc([
      {
        type: 'embed',
        attrs: {
          src: 'https://x.com/e',
          provider: 'iframe',
          align: 'left',
          width: 600,
          height: 400,
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div data-type="embed" data-src="https://x.com/e" data-provider="iframe" data-align="left" data-width="600" data-height="400"></div>',
    );
    expect(md2).toBe(md1);

    const embed = findFirst(doc2, 'embed');
    expect(embed).not.toBeNull();
    expect(embed.attrs.src).toBe('https://x.com/e');
    expect(embed.attrs.provider).toBe('iframe');
    expect(embed.attrs.align).toBe('left');
    // data-width / data-height parseHTML -> getAttribute() -> STRINGS.
    expect(embed.attrs.width).toBe('600');
    expect(embed.attrs.height).toBe('400');
  });

  // 7. minimal embed (only src+provider) -----------------------------------
  it('minimal embed (src+provider): NOT byte-stable; defaults width/height materialize as NUMBERS 800/600', async () => {
    const doc = mkDoc([
      { type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div data-type="embed" data-src="https://x.com/e" data-provider="iframe"></div>',
    );
    // embed has non-null schema defaults align='center', width=800, height=600
    // that the converter never emits on export #1 but materialize on import, so
    // export #2 grows by three data-* attrs (a one-time divergence).
    expect(md2).toBe(
      '<div data-type="embed" data-src="https://x.com/e" data-provider="iframe" data-align="center" data-width="800" data-height="600"></div>',
    );
    expect(md2).not.toBe(md1);

    const embed = findFirst(doc2, 'embed');
    expect(embed).not.toBeNull();
    expect(embed.attrs.align).toBe('center');
    // NOTE: these come from the addAttributes default (NOT parseHTML), so on the
    // FIRST import they are the NUMBERS 800/600, not strings — parseHTML only
    // runs when the attribute is actually present on the imported element.
    expect(embed.attrs.width).toBe(800);
    expect(embed.attrs.height).toBe(600);
  });

  // 8. youtube with src+width+height+align ---------------------------------
  it('youtube with src+width+height+align(right): byte-stable; width/height STRINGS; canonical FALSE', async () => {
    const doc = mkDoc([
      {
        type: 'youtube',
        attrs: {
          src: 'https://youtu.be/abc',
          width: 560,
          height: 315,
          align: 'right',
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    expect(md1).toBe(
      '<div data-type="youtube" data-src="https://youtu.be/abc" data-width="560" data-height="315" data-align="right"></div>',
    );
    expect(md2).toBe(md1);

    const yt = findFirst(doc2, 'youtube');
    expect(yt).not.toBeNull();
    expect(yt.attrs.src).toBe('https://youtu.be/abc');
    expect(yt.attrs.align).toBe('right');
    // data-width / data-height parseHTML -> getAttribute() -> STRINGS.
    expect(yt.attrs.width).toBe('560');
    expect(yt.attrs.height).toBe('315');

    // Numeric width/height coerced to strings; align='right' is non-default so
    // it is kept (not in KNOWN_DEFAULTS.youtube's normalization). Canonical FALSE.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });
});
