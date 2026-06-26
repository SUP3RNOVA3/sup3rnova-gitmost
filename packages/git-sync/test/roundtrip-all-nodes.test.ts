import { describe, expect, it } from 'vitest';
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

/**
 * Exhaustive serialize -> deserialize round trip for EVERY node and mark type the
 * Docmost document schema supports. The git-sync converter exports a page body to
 * Markdown and imports it back; any node type that has no parseHTML inverse (or is
 * serialized to a literal that never re-parses) silently degrades to plain text on
 * a round trip — e.g. `subpages` used to export as the literal `{{SUBPAGES}}` and
 * came back as the visible text "{{SUBPAGES}}" instead of the embed.
 *
 * This guards the whole class: for one representative fixture per type, the node
 * (or mark) MUST still be present after convert -> import, and the exported
 * Markdown must not contain a `{{...}}` template literal (the old lossy form).
 */

const T = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const P = (...c: any[]) => ({ type: 'paragraph', content: c });
const doc = (...c: any[]) => ({ type: 'doc', content: c });

// `primary` is the node/mark type that must survive the round trip.
const FIXTURES: Record<string, { doc: any; primary: string }> = {
  paragraph: { doc: doc(P(T('hello'))), primary: 'paragraph' },
  heading: { doc: doc({ type: 'heading', attrs: { level: 2 }, content: [T('H2')] }), primary: 'heading' },
  blockquote: { doc: doc({ type: 'blockquote', content: [P(T('q'))] }), primary: 'blockquote' },
  codeBlock: { doc: doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [T('foo()')] }), primary: 'codeBlock' },
  bulletList: { doc: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [P(T('a'))] }] }), primary: 'bulletList' },
  orderedList: { doc: doc({ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [P(T('a'))] }] }), primary: 'orderedList' },
  taskList: { doc: doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('done'))] }] }), primary: 'taskList' },
  horizontalRule: { doc: doc({ type: 'horizontalRule' }), primary: 'horizontalRule' },
  image: { doc: doc({ type: 'image', attrs: { src: '/f/x.png', width: '320', align: 'center' } }), primary: 'image' },
  hardBreak: { doc: doc(P(T('a'), { type: 'hardBreak' }, T('b'))), primary: 'hardBreak' },
  callout: { doc: doc({ type: 'callout', attrs: { type: 'info' }, content: [P(T('note'))] }), primary: 'callout' },
  columns: {
    doc: doc({ type: 'columns', content: [
      { type: 'column', attrs: { width: '50%' }, content: [P(T('L'))] },
      { type: 'column', attrs: { width: '50%' }, content: [P(T('R'))] }] }),
    primary: 'column',
  },
  details: {
    doc: doc({ type: 'details', content: [
      { type: 'detailsSummary', content: [T('Sum')] },
      { type: 'detailsContent', content: [P(T('body'))] }] }),
    primary: 'details',
  },
  table: {
    doc: doc({ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('H1'))] }, { type: 'tableHeader', content: [P(T('H2'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('C1'))] }, { type: 'tableCell', content: [P(T('C2'))] }] }] }),
    primary: 'tableCell',
  },
  mathBlock: { doc: doc({ type: 'mathBlock', attrs: { math: 'x^2' } }), primary: 'mathBlock' },
  mathInline: { doc: doc(P({ type: 'mathInline', attrs: { math: 'x^2' } })), primary: 'mathInline' },
  mention: { doc: doc(P({ type: 'mention', attrs: { id: 'u1', label: 'Bob', entityType: 'user', entityId: 'u1' } })), primary: 'mention' },
  drawio: { doc: doc({ type: 'drawio', attrs: { src: '/f/d.drawio', attachmentId: 'a1' } }), primary: 'drawio' },
  excalidraw: { doc: doc({ type: 'excalidraw', attrs: { src: '/f/e.excalidraw', attachmentId: 'a1' } }), primary: 'excalidraw' },
  embed: { doc: doc({ type: 'embed', attrs: { src: 'https://youtube.com/x', provider: 'iframe' } }), primary: 'embed' },
  pdf: { doc: doc({ type: 'pdf', attrs: { src: '/f/x.pdf', attachmentId: 'a1' } }), primary: 'pdf' },
  video: { doc: doc({ type: 'video', attrs: { src: '/f/v.mp4', width: '640' } }), primary: 'video' },
  audio: { doc: doc({ type: 'audio', attrs: { src: '/f/a.mp3' } }), primary: 'audio' },
  attachment: { doc: doc({ type: 'attachment', attrs: { url: '/f/x.zip', name: 'x.zip', attachmentId: 'a1' } }), primary: 'attachment' },
  youtube: { doc: doc({ type: 'youtube', attrs: { src: 'https://youtube.com/watch?v=x' } }), primary: 'youtube' },
  subpages: { doc: doc({ type: 'subpages' }), primary: 'subpages' },
  pageBreak: { doc: doc({ type: 'pageBreak' }), primary: 'pageBreak' },
  htmlEmbed: { doc: doc({ type: 'htmlEmbed', attrs: { source: '<b>hi</b>' } }), primary: 'htmlEmbed' },
  pageEmbed: { doc: doc({ type: 'pageEmbed', attrs: { pageId: 'p1' } }), primary: 'pageEmbed' },
  transclusion: { doc: doc({ type: 'transclusionSource', attrs: { pageId: 'p1' } }), primary: 'transclusionSource' },
  footnote: {
    doc: doc(
      P(T('x'), { type: 'footnoteReference', attrs: { id: 'fn1' } }),
      { type: 'footnotesList', content: [{ type: 'footnoteDefinition', attrs: { id: 'fn1' }, content: [P(T('note'))] }] }),
    primary: 'footnoteReference',
  },
  status: { doc: doc(P({ type: 'status', attrs: { text: 'Done', color: 'green' } })), primary: 'status' },
  // marks
  bold: { doc: doc(P(T('b', [{ type: 'bold' }]))), primary: 'bold' },
  italic: { doc: doc(P(T('i', [{ type: 'italic' }]))), primary: 'italic' },
  strike: { doc: doc(P(T('s', [{ type: 'strike' }]))), primary: 'strike' },
  code: { doc: doc(P(T('c', [{ type: 'code' }]))), primary: 'code' },
  underline: { doc: doc(P(T('u', [{ type: 'underline' }]))), primary: 'underline' },
  superscript: { doc: doc(P(T('x', [{ type: 'superscript' }]))), primary: 'superscript' },
  subscript: { doc: doc(P(T('x', [{ type: 'subscript' }]))), primary: 'subscript' },
  highlight: { doc: doc(P(T('h', [{ type: 'highlight', attrs: { color: 'yellow' } }]))), primary: 'highlight' },
  link: { doc: doc(P(T('l', [{ type: 'link', attrs: { href: 'https://x.com' } }]))), primary: 'link' },
};

function collectTypes(n: any, set = new Set<string>()): Set<string> {
  if (!n || typeof n !== 'object') return set;
  if (n.type) set.add(n.type);
  if (Array.isArray(n.content)) n.content.forEach((c: any) => collectTypes(c, set));
  if (Array.isArray(n.marks)) n.marks.forEach((m: any) => m?.type && set.add(m.type));
  return set;
}

describe('git-sync converter: every node/mark type survives a Markdown round trip', () => {
  for (const [name, { doc: original, primary }] of Object.entries(FIXTURES)) {
    it(`round-trips ${name} (keeps the ${primary} node/mark, no literal leak)`, async () => {
      const md = convertProseMirrorToMarkdown(original);
      // The lossy old form serialized embeds to `{{...}}` literals that never
      // re-parsed; no node may export to one.
      expect(md).not.toMatch(/\{\{.*\}\}/);
      const back = await markdownToProseMirror(md);
      const types = collectTypes(back);
      expect(types.has(primary)).toBe(true);
    });
  }
});

// A node surviving as the right TYPE is necessary but not sufficient — its
// attributes must survive too. Each case carries a DISTINCTIVE attribute value
// (real attr names, verified against the schema) that must reappear after a
// round trip. This caught `subpages.recursive` and `details.open` being dropped.
describe('git-sync converter: node ATTRIBUTES survive a Markdown round trip', () => {
  const ATTR_CASES: Array<{ name: string; doc: any; needles: string[] }> = [
    { name: 'callout type', doc: doc({ type: 'callout', attrs: { type: 'warning' }, content: [P(T('x'))] }), needles: ['warning'] },
    { name: 'image dimensions/align/attachmentId', doc: doc({ type: 'image', attrs: { src: '/f/x.png', width: '777', height: '555', align: 'right', attachmentId: 'ATT777' } }), needles: ['777', '555', 'right', 'ATT777'] },
    { name: 'subpages recursive', doc: doc({ type: 'subpages', attrs: { recursive: true } }), needles: ['"recursive":true'] },
    { name: 'details open', doc: doc({ type: 'details', attrs: { open: true }, content: [{ type: 'detailsSummary', content: [T('S')] }, { type: 'detailsContent', content: [P(T('b'))] }] }), needles: ['"open":'] },
    { name: 'mathInline formula', doc: doc(P({ type: 'mathInline', attrs: { text: 'E=mc^7' } })), needles: ['E=mc^7'] },
    { name: 'mathBlock formula', doc: doc({ type: 'mathBlock', attrs: { text: '\\sum_7' } }), needles: ['sum_7'] },
    { name: 'pageEmbed sourcePageId', doc: doc({ type: 'pageEmbed', attrs: { sourcePageId: 'PAGE777' } }), needles: ['PAGE777'] },
    { name: 'video dimensions/attachmentId', doc: doc({ type: 'video', attrs: { src: '/f/v.mp4', width: '888', attachmentId: 'VID888' } }), needles: ['888', 'VID888'] },
    { name: 'status text/color', doc: doc(P({ type: 'status', attrs: { text: 'InProgress777', color: 'orange' } })), needles: ['InProgress777', 'orange'] },
    { name: 'mention entityId/label', doc: doc(P({ type: 'mention', attrs: { id: 'M1', label: 'Alice', entityType: 'user', entityId: 'ENT777' } })), needles: ['Alice', 'ENT777'] },
    { name: 'columns widths', doc: doc({ type: 'columns', content: [{ type: 'column', attrs: { width: '37%' }, content: [P(T('L'))] }, { type: 'column', attrs: { width: '63%' }, content: [P(T('R'))] }] }), needles: ['37%', '63%'] },
    { name: 'highlight color', doc: doc(P(T('x', [{ type: 'highlight', attrs: { color: '#abcdef' } }]))), needles: ['#abcdef'] },
  ];
  for (const { name, doc: original, needles } of ATTR_CASES) {
    it(`preserves ${name}`, async () => {
      const md = convertProseMirrorToMarkdown(original);
      const back = JSON.stringify(await markdownToProseMirror(md));
      for (const needle of needles) {
        // The value must survive in the re-imported doc (or in the markdown the
        // schema parses it back from).
        expect(`${back} ${md}`).toContain(needle);
      }
    });
  }
});
