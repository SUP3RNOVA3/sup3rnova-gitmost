import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';

// Wrap a single node in a minimal ProseMirror doc. The top-level converter
// joins doc children with "\n\n" and then .trim()s the whole output, so a
// single-node doc yields exactly that node's rendered (and trimmed) string.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
// Convenience: a text node, optionally with marks.
const text = (t: string, marks?: any[]) =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
// Convenience: a paragraph wrapping inline children.
const para = (...inline: any[]) => ({ type: 'paragraph', content: inline });

describe('convertProseMirrorToMarkdown', () => {
  // ---------------------------------------------------------------------------
  describe('headings', () => {
    it('emits the right number of "#" for levels 1-6', () => {
      for (let level = 1; level <= 6; level++) {
        const out = convertProseMirrorToMarkdown(
          doc({ type: 'heading', attrs: { level }, content: [text('H')] }),
        );
        expect(out).toBe('#'.repeat(level) + ' H');
      }
    });

    it('defaults to level 1 when level is missing', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'heading', content: [text('NoLevel')] }),
      );
      expect(out).toBe('# NoLevel');
    });
  });

  // ---------------------------------------------------------------------------
  describe('text marks', () => {
    it('bold', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'bold' }])))),
      ).toBe('**x**');
    });

    it('italic', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'italic' }])))),
      ).toBe('*x*');
    });

    it('strike', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'strike' }])))),
      ).toBe('~~x~~');
    });

    it('inline code (sole mark) uses backtick span', () => {
      expect(
        convertProseMirrorToMarkdown(doc(para(text('x', [{ type: 'code' }])))),
      ).toBe('`x`');
    });

    it('code + another mark switches to nested HTML (no backtick form)', () => {
      // marks array order drives nesting: bold first wraps, then code wraps that.
      const out = convertProseMirrorToMarkdown(
        doc(para(text('x', [{ type: 'bold' }, { type: 'code' }]))),
      );
      expect(out).toBe('<code><strong>x</strong></code>');
    });

    it('code + strike combo emits <code> wrapping <s>', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('x', [{ type: 'strike' }, { type: 'code' }]))),
      );
      expect(out).toBe('<code><s>x</s></code>');
    });
  });

  // ---------------------------------------------------------------------------
  describe('links', () => {
    it('href only', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('site', [{ type: 'link', attrs: { href: 'https://e.com' } }]))),
      );
      expect(out).toBe('[site](https://e.com)');
    });

    it('href + title with an embedded double quote is escaped', () => {
      const out = convertProseMirrorToMarkdown(
        doc(
          para(
            text('site', [
              { type: 'link', attrs: { href: 'https://e.com', title: 'a "b" c' } },
            ]),
          ),
        ),
      );
      // The markdown link-title form escapes the inner " as \".
      expect(out).toBe('[site](https://e.com "a \\"b\\" c")');
    });
  });

  // ---------------------------------------------------------------------------
  describe('image', () => {
    it('percent-encodes spaces and parentheses in src', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'image',
          attrs: { alt: 'cap', src: '/files/my pic (1).png' },
        }),
      );
      // space -> %20, ( -> %28, ) -> %29
      expect(out).toBe('![cap](/files/my%20pic%20%281%29.png)');
    });

    it('empty alt and missing src render harmlessly', () => {
      const out = convertProseMirrorToMarkdown(doc({ type: 'image', attrs: {} }));
      expect(out).toBe('![]()');
    });
  });

  // ---------------------------------------------------------------------------
  describe('codeBlock', () => {
    it('with language', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [text('const a = 1;')],
        }),
      );
      expect(out).toBe('```ts\nconst a = 1;\n```');
    });

    it('without language emits empty info string', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'codeBlock', content: [text('plain')] }),
      );
      expect(out).toBe('```\nplain\n```');
    });

    it('strips ALL trailing newlines for idempotency', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'codeBlock', content: [text('a\n\n\n')] }),
      );
      // Every trailing "\n" is removed, then exactly one is re-added by the fence.
      expect(out).toBe('```\na\n```');
    });
  });

  // ---------------------------------------------------------------------------
  describe('lists', () => {
    it('bullet list', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para(text('one'))] },
            { type: 'listItem', content: [para(text('two'))] },
          ],
        }),
      );
      expect(out).toBe('- one\n- two');
    });

    it('ordered list numbers items sequentially', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [para(text('a'))] },
            { type: 'listItem', content: [para(text('b'))] },
            { type: 'listItem', content: [para(text('c'))] },
          ],
        }),
      );
      expect(out).toBe('1. a\n2. b\n3. c');
    });

    it('nested bullet list indents the child by the 2-col marker width', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('parent')),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [para(text('child'))] }],
                },
              ],
            },
          ],
        }),
      );
      // First line carries the marker; the nested list is indented 2 columns.
      expect(out).toBe('- parent\n  - child');
    });

    it('nested ordered list indents by the wider 3-col marker width', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                para(text('parent')),
                {
                  type: 'orderedList',
                  content: [{ type: 'listItem', content: [para(text('child'))] }],
                },
              ],
            },
          ],
        }),
      );
      // "1. " is 3 columns wide, so the continuation indent is 3 spaces.
      expect(out).toBe('1. parent\n   1. child');
    });
  });

  // ---------------------------------------------------------------------------
  describe('task list', () => {
    it('unchecked and checked items', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: false }, content: [para(text('todo'))] },
            { type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] },
          ],
        }),
      );
      expect(out).toBe('- [ ] todo\n- [x] done');
    });

    it('empty task item keeps its marker', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: false }, content: [] }],
        }),
      );
      expect(out).toBe('- [ ]');
    });
  });

  // ---------------------------------------------------------------------------
  describe('blockquote', () => {
    it('single paragraph quote prefixes the line', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'blockquote', content: [para(text('quoted'))] }),
      );
      expect(out).toBe('> quoted');
    });

    it('multi-paragraph quote separates blocks with a bare ">" line', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'blockquote',
          content: [para(text('first')), para(text('second'))],
        }),
      );
      expect(out).toBe('> first\n>\n> second');
    });
  });

  // ---------------------------------------------------------------------------
  describe('breaks and rules', () => {
    it('horizontal rule', () => {
      expect(
        convertProseMirrorToMarkdown(doc({ type: 'horizontalRule' })),
      ).toBe('---');
    });

    it('hard break emits two trailing spaces then newline', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para(text('a'), { type: 'hardBreak' }, text('b'))),
      );
      expect(out).toBe('a  \nb');
    });
  });

  // ---------------------------------------------------------------------------
  describe('tables', () => {
    it('GFM table emits alignment markers derived from header cells', () => {
      const headerRow = {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', attrs: { align: 'left' }, content: [para(text('L'))] },
          { type: 'tableHeader', attrs: { align: 'center' }, content: [para(text('C'))] },
          { type: 'tableHeader', attrs: { align: 'right' }, content: [para(text('R'))] },
          { type: 'tableHeader', content: [para(text('N'))] },
        ],
      };
      const bodyRow = {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [para(text('1'))] },
          { type: 'tableCell', content: [para(text('2'))] },
          { type: 'tableCell', content: [para(text('3'))] },
          { type: 'tableCell', content: [para(text('4'))] },
        ],
      };
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'table', content: [headerRow, bodyRow] }),
      );
      expect(out).toBe(
        [
          '| L | C | R | N |',
          '| :-- | :-: | --: | --- |',
          '| 1 | 2 | 3 | 4 |',
        ].join('\n'),
      );
    });

    it('spanned table (colspan/rowspan) emits raw <table> HTML', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 2 },
                  content: [para(text('wide'))],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [para(text('a'))] },
                { type: 'tableCell', content: [para(text('b'))] },
              ],
            },
          ],
        }),
      );
      expect(out).toBe(
        '<table><tbody>' +
          '<tr><th colspan="2"><p>wide</p></th></tr>' +
          '<tr><td><p>a</p></td><td><p>b</p></td></tr>' +
          '</tbody></table>',
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('callout and details', () => {
    it('callout uses lowercased type fence', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'callout',
          attrs: { type: 'WARNING' },
          content: [para(text('beware'))],
        }),
      );
      expect(out).toBe(':::warning\nbeware\n:::');
    });

    it('callout defaults to info', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'callout', content: [para(text('hi'))] }),
      );
      expect(out).toBe(':::info\nhi\n:::');
    });

    it('details emits summary + content wrapped in <details>', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [text('Title')] },
            { type: 'detailsContent', content: [para(text('Body'))] },
          ],
        }),
      );
      // details joins its children with "\n"; summary opens, content closes.
      expect(out).toBe('<details>\n<summary>Title</summary>\n\nBody\n</details>');
    });
  });

  // ---------------------------------------------------------------------------
  describe('math', () => {
    it('inline math carries LaTeX in a text attr WITHOUT escaping < or >', () => {
      const out = convertProseMirrorToMarkdown(
        doc(para({ type: 'mathInline', attrs: { text: 'a < b' } })),
      );
      // < and > must NOT be HTML-escaped (idempotency); only & and " would be.
      expect(out).toBe(
        '<span data-type="mathInline" data-katex="true" text="a < b"></span>',
      );
      expect(out).not.toContain('&lt;');
    });

    it('block math carries LaTeX in a text attr WITHOUT escaping < or >', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'mathBlock', attrs: { text: 'x > y & z' } }),
      );
      // & IS escaped (entity-significant), but < and > are NOT.
      expect(out).toBe(
        '<div data-type="mathBlock" data-katex="true" text="x > y &amp; z"></div>',
      );
      expect(out).not.toContain('&lt;');
      expect(out).not.toContain('&gt;');
    });
  });

  // ---------------------------------------------------------------------------
  describe('inline atoms and media', () => {
    it('mention emits schema span with data-* attrs and visible label', () => {
      const out = convertProseMirrorToMarkdown(
        doc(
          para({
            type: 'mention',
            attrs: { id: 'u1', label: 'Alice', entityType: 'user' },
          }),
        ),
      );
      expect(out).toBe(
        '<span data-type="mention" data-id="u1" data-label="Alice" data-entity-type="user">@Alice</span>',
      );
    });

    it('attachment emits div with schema data-attachment-* attrs', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'attachment',
          attrs: { url: '/files/x.zip', name: 'x.zip', mime: 'application/zip', size: 99 },
        }),
      );
      expect(out).toBe(
        '<div data-type="attachment" data-attachment-url="/files/x.zip" ' +
          'data-attachment-name="x.zip" data-attachment-mime="application/zip" ' +
          'data-attachment-size="99"></div>',
      );
    });

    it('video emits a <div>-wrapped <video> with schema attrs', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'video',
          attrs: { src: '/v.mp4', alt: 'clip', width: 640 },
        }),
      );
      expect(out).toBe(
        '<div><video src="/v.mp4" aria-label="clip" width="640"></video></div>',
      );
    });

    it('youtube emits a div[data-type="youtube"] with data-src', () => {
      const out = convertProseMirrorToMarkdown(
        doc({
          type: 'youtube',
          attrs: { src: 'https://youtu.be/abc', width: 560, height: 315 },
        }),
      );
      expect(out).toBe(
        '<div data-type="youtube" data-src="https://youtu.be/abc" ' +
          'data-width="560" data-height="315"></div>',
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('null content returns ""', () => {
      expect(convertProseMirrorToMarkdown(null)).toBe('');
    });

    it('empty object returns ""', () => {
      expect(convertProseMirrorToMarkdown({})).toBe('');
    });

    it('doc with no content returns ""', () => {
      expect(convertProseMirrorToMarkdown({ type: 'doc' })).toBe('');
    });

    it('unknown node type falls back to children-only (no throw, text preserved)', () => {
      const out = convertProseMirrorToMarkdown(
        doc({ type: 'totallyUnknownType', content: [text('kept')] }),
      );
      expect(out).toBe('kept');
    });

    it('deeply nested structure does not stack-overflow', () => {
      // Build a deeply nested bullet list (each level holds one nested list).
      let node: any = { type: 'listItem', content: [para(text('leaf'))] };
      for (let i = 0; i < 200; i++) {
        node = {
          type: 'listItem',
          content: [para(text('lvl')), { type: 'bulletList', content: [node] }],
        };
      }
      const root = doc({ type: 'bulletList', content: [node] });
      expect(() => convertProseMirrorToMarkdown(root)).not.toThrow();
      const out = convertProseMirrorToMarkdown(root);
      expect(out).toContain('leaf');
      expect(out.startsWith('- lvl')).toBe(true);
    });
  });
});
