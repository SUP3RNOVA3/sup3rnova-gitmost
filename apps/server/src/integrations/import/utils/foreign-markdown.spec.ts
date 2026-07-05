import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from '@docmost/prosemirror-markdown';
import { normalizeForeignMarkdown } from './foreign-markdown';

/**
 * STEP 2 goldens for issue #345: the foreign-markdown normalizer that runs at the
 * import boundary BEFORE the strict canonical parser (`markdownToProseMirror`).
 *
 * Two layers:
 *  1. PURE string→string cases pinning the normalizer's own behavior (GFM
 *     reference footnotes → inline `^[…]`).
 *  2. END-TO-END acceptance: for a foreign corpus, `normalizeForeignMarkdown`
 *     then `markdownToProseMirror` then `convertProseMirrorToMarkdown` must leave
 *     NO literal `[^id]` / `:::` garbage in the document and must re-export in the
 *     canonical forms.
 */

describe('normalizeForeignMarkdown — GFM reference footnotes', () => {
  it('inlines a single-line reference footnote and drops its definition', () => {
    const out = normalizeForeignMarkdown(
      'A note[^1] here.\n\n[^1]: The definition.',
    );
    expect(out).toBe('A note^[The definition.] here.\n');
  });

  it('inlines every reference to a reused id (downstream dedups)', () => {
    const out = normalizeForeignMarkdown(
      'X[^a] and Y[^a].\n\n[^a]: shared.',
    );
    expect(out).toBe('X^[shared.] and Y^[shared.].\n');
  });

  it('joins indented continuation lines of a definition with a space', () => {
    const out = normalizeForeignMarkdown(
      'See[^n].\n\n[^n]: line one\n    line two',
    );
    expect(out).toBe('See^[line one line two].\n');
  });

  it('never rewrites a reference inside a fenced code block', () => {
    const out = normalizeForeignMarkdown(
      '```\ncode[^1] here\n```\n\n[^1]: def.',
    );
    expect(out).toContain('code[^1] here');
    // The (now orphaned) definition line is still removed.
    expect(out).not.toContain('[^1]: def.');
  });

  it('leaves a reference with no matching definition literal (no body to inline)', () => {
    const out = normalizeForeignMarkdown('Dangling[^x] ref.');
    expect(out).toBe('Dangling[^x] ref.');
  });

  it('returns the input unchanged when there are no reference footnotes', () => {
    const md = '# Title\n\nJust text with `inline code` and a [link](/x).';
    expect(normalizeForeignMarkdown(md)).toBe(md);
  });

  it('does NOT touch callout surfaces — the canonical parser handles them', () => {
    const callouts = ':::info\nHi\n:::\n\n> [!warning]\n> Careful';
    expect(normalizeForeignMarkdown(callouts)).toBe(callouts);
  });
});

describe('foreign markdown import acceptance (normalizer + canonical parser)', () => {
  const FOREIGN = [
    '# Doc',
    '',
    'Body refs [^c] and [^a] and [^b] and again [^a].',
    '',
    ':::info',
    'A legacy callout.',
    ':::',
    '',
    '| h1 | h2 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '[^a]: note A',
    '[^b]: note B',
    '[^c]: note C',
    '[^z]: orphan note',
  ].join('\n');

  it('leaves no literal [^id] or ::: in the imported doc and re-exports canonically', async () => {
    const normalized = normalizeForeignMarkdown(FOREIGN);
    const doc = await markdownToProseMirror(normalized);
    const reexport = convertProseMirrorToMarkdown(doc);

    // No foreign garbage leaks into the document.
    expect(reexport).not.toMatch(/\[\^/); // no reference footnote refs/defs
    expect(reexport).not.toContain(':::'); // no legacy callout fences

    // Canonical forms are present.
    expect(reexport).toContain('^[note C]');
    expect(reexport).toContain('> [!info]');
    expect(reexport).toContain('| h1 | h2 |');

    // Footnotes: ordered by first reference (C, A, B), reused [^a] deduped to one,
    // orphan [^z] dropped (it had no reference after normalization).
    const list = doc.content.find((n: any) => n.type === 'footnotesList');
    const bodies = list.content.map(
      (d: any) => d.content[0].content[0].text,
    );
    expect(bodies).toEqual(['note C', 'note A', 'note B']);
    expect(bodies).not.toContain('orphan note');
    expect(
      doc.content.filter((n: any) => n.type === 'footnotesList'),
    ).toHaveLength(1);
  });
});
