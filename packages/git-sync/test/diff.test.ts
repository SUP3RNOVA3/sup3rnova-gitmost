import { describe, expect, it } from 'vitest';
import { diffDocs } from '../src/lib/diff.js';

// ---------------------------------------------------------------------------
// ProseMirror JSON builders. diffDocs accepts plain JSON docs (it parses them
// through the Docmost schema internally), so we only need minimal node shapes.
// ---------------------------------------------------------------------------

/** A paragraph; omit `text` for an empty paragraph (no content array entries). */
const para = (text?: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});

/** A heading (level 2 by default) carrying a single text run. */
const heading = (text: string, level = 2) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

/** A top-level doc node wrapping the given blocks. */
const doc = (...content: any[]) => ({ type: 'doc', content });

/** An image node (atom). */
const image = () => ({ type: 'image', attrs: {} });

/** A callout node wrapping one paragraph. */
const callout = (text = 'note') => ({
  type: 'callout',
  attrs: { type: 'info' },
  content: [para(text)],
});

/** A 1x1 table. */
const table = (cell = 'c') => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: [{ type: 'tableCell', content: [para(cell)] }] },
  ],
});

/** A paragraph carrying a text run that bears a link mark with the given href. */
const linkPara = (text: string, href: string | undefined, extraMarks: any[] = []) => ({
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: href === undefined ? {} : { href } }, ...extraMarks],
    },
  ],
});

/** The diff.ts default for the notes-heading argument. */
const DEFAULT_NOTES_HEADING = 'Примечания переводчика';

describe('diffDocs', () => {
  describe('textual changes (precise path)', () => {
    it('reports no changes for two identical docs', () => {
      const d = doc(para('hello world'));
      const result = diffDocs(d, d);

      expect(result.changes).toHaveLength(0);
      expect(result.summary).toEqual({ inserted: 0, deleted: 0, blocksChanged: 0 });
      // The Changes section renders the sentinel line for an empty change list.
      expect(result.markdown).toContain('(no textual changes)');
    });

    it('counts a pure insertion ("abc" -> "abcXY") and captures the inserted substring', () => {
      const result = diffDocs(doc(para('abc')), doc(para('abcXY')));

      expect(result.summary.inserted).toBe(2);
      expect(result.summary.deleted).toBe(0);
      // Exactly one insert change whose text equals the inserted substring.
      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('XY');
      // No deletions on a pure insertion.
      expect(result.changes.filter((c) => c.op === 'delete')).toHaveLength(0);
    });

    it('counts a pure deletion ("abcXY" -> "abc") and captures the deleted substring', () => {
      const result = diffDocs(doc(para('abcXY')), doc(para('abc')));

      expect(result.summary.deleted).toBe(2);
      expect(result.summary.inserted).toBe(0);
      const deletes = result.changes.filter((c) => c.op === 'delete');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].text).toBe('XY');
      expect(result.changes.filter((c) => c.op === 'insert')).toHaveLength(0);
    });

    it('reports a word modification as a matched delete + insert with exact substrings', () => {
      const result = diffDocs(doc(para('hello world')), doc(para('hello there')));

      // "world" (5) removed, "there" (5) added.
      expect(result.summary.inserted).toBe(5);
      expect(result.summary.deleted).toBe(5);

      const deletes = result.changes.filter((c) => c.op === 'delete');
      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(deletes.map((c) => c.text)).toContain('world');
      expect(inserts.map((c) => c.text)).toContain('there');
    });

    it('handles two empty docs without error', () => {
      const result = diffDocs({ type: 'doc', content: [] }, { type: 'doc', content: [] });

      expect(result.changes).toHaveLength(0);
      expect(result.summary).toEqual({ inserted: 0, deleted: 0, blocksChanged: 0 });
      expect(result.markdown).toContain('(no textual changes)');
    });

    it('reports an insertion into an empty doc', () => {
      const result = diffDocs({ type: 'doc', content: [] }, doc(para('brand new')));

      expect(result.summary.inserted).toBeGreaterThan(0);
      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(inserts.length).toBeGreaterThan(0);
      // The inserted text is the new paragraph's content.
      expect(inserts.map((c) => c.text).join('')).toContain('brand new');
    });
  });

  describe('integrity counting', () => {
    it('counts images, tables and callouts as old -> new tuples', () => {
      // old: 1 image, 1 callout, 1 table   new: 2 images, 0 callouts, 1 table
      const oldDoc = doc(image(), callout(), table());
      const newDoc = doc(image(), image(), table());
      const { integrity } = diffDocs(oldDoc, newDoc);

      expect(integrity.images).toEqual([1, 2]);
      expect(integrity.callouts).toEqual([1, 0]);
      expect(integrity.tables).toEqual([1, 1]);
    });

    it('renders the integrity section verbatim in the markdown', () => {
      const oldDoc = doc(image(), callout(), table());
      const newDoc = doc(image(), image(), table());
      const { markdown } = diffDocs(oldDoc, newDoc);

      // The integrity block is our own formatting, so exact lines are asserted.
      expect(markdown).toContain('## Integrity (old -> new)');
      expect(markdown).toContain('- images: 1 -> 2');
      expect(markdown).toContain('- callouts: 1 -> 0');
      expect(markdown).toContain('- tables: 1 -> 1');
    });

    it('counts a single link split across two adjacent runs (shared href) as one link', () => {
      // Two text runs, both bearing a link to the SAME href; one also bold.
      const d = doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'foo', marks: [{ type: 'link', attrs: { href: 'http://x' } }, { type: 'bold' }] },
          { type: 'text', text: 'bar', marks: [{ type: 'link', attrs: { href: 'http://x' } }] },
        ],
      });
      const { integrity } = diffDocs(d, d);

      // Counting by unique href collapses the two runs into one link.
      expect(integrity.links).toEqual([1, 1]);
    });

    it('counts distinct hrefs separately', () => {
      const d = doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'one', marks: [{ type: 'link', attrs: { href: 'http://a' } }] },
          { type: 'text', text: 'two', marks: [{ type: 'link', attrs: { href: 'http://b' } }] },
        ],
      });
      const { integrity } = diffDocs(d, d);
      expect(integrity.links).toEqual([2, 2]);
    });

    it('counts a link mark with a missing href once (bucketed under "")', () => {
      // Per source: a missing/empty href is collected under a single "" key, so a
      // malformed link is still counted exactly once.
      const d = linkPara('orphan', undefined);
      const { integrity } = diffDocs(d, d);
      expect(integrity.links).toEqual([1, 1]);
    });
  });

  describe('footnoteMarkers', () => {
    it('excludes markers after the default notes heading and preserves reading order', () => {
      // Body has [1] then [2]; the [99] sits AFTER the notes heading and must be
      // excluded from both old and new marker lists.
      const d = doc(
        para('intro [1] middle [2]'),
        heading(DEFAULT_NOTES_HEADING),
        para('[99] footnote body'),
      );
      const { integrity } = diffDocs(d, d);

      expect(integrity.footnoteMarkers).toEqual([
        [1, 2],
        [1, 2],
      ]);
      // Reading order: [1] precedes [2].
      expect(integrity.footnoteMarkers[1]).toEqual([1, 2]);
    });

    it('honors a custom notesHeading argument', () => {
      const d = doc(para('a [1]'), heading('Notes'), para('[5] excluded'));
      const { integrity } = diffDocs(d, d, 'Notes');

      // With the matching custom heading, [5] is excluded.
      expect(integrity.footnoteMarkers).toEqual([[1], [1]]);
    });

    it('includes every marker when no notes heading is present', () => {
      // No heading equals the notesHeading -> the whole doc is the body.
      const d = doc(para('a [1] b [2]'), para('[3]'));
      const { integrity } = diffDocs(d, d);

      expect(integrity.footnoteMarkers).toEqual([
        [1, 2, 3],
        [1, 2, 3],
      ]);
    });

    it('renders the footnoteMarkers integrity line verbatim', () => {
      const d = doc(para('x [1] y [2]'), heading(DEFAULT_NOTES_HEADING), para('[9]'));
      const { markdown } = diffDocs(d, d);
      expect(markdown).toContain('- footnoteMarkers: [1, 2] -> [1, 2]');
    });
  });

  describe('coarse fallback', () => {
    // An unknown node type makes Node.fromJSON reject the doc, which throws
    // inside the precise pipeline and triggers the coarse block-level fallback.
    // (Confirmed by running the module: `{ type: '___nope' }` is not in the
    // schema, so parsing throws and `fellBack` becomes true.)
    it('degrades to a coarse block-level diff instead of throwing', () => {
      const oldDoc = doc(para('keep this'), { type: '___nope' });
      const newDoc = doc(para('keep this'), para('new block'));

      // Must not throw.
      const result = diffDocs(oldDoc, newDoc);

      // The fallback note appears in the markdown header area.
      expect(result.markdown).toContain('precise diff failed; coarse block-level diff shown.');
      // Only the genuinely new block is reported; the unchanged "keep this"
      // block is not.
      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(inserts).toHaveLength(1);
      expect(inserts[0].text).toBe('new block');
    });

    it('does not report whitespace-only blocks in the fallback path', () => {
      // New doc adds a block whose plain text is only whitespace; coarseDiff
      // skips blocks whose trimmed text is empty.
      const oldDoc = doc({ type: '___nope' }, para('kept'));
      const newDoc = doc(para('kept'), para('   '));

      const result = diffDocs(oldDoc, newDoc);

      // Fallback was taken (precise path threw on the unknown node).
      expect(result.markdown).toContain('coarse block-level diff shown.');
      // No change is reported: "kept" is unchanged and "   " is whitespace-only.
      expect(result.changes).toHaveLength(0);
      expect(result.summary).toEqual({ inserted: 0, deleted: 0, blocksChanged: 0 });
    });

    it('still computes integrity (images/tables/callouts/footnotes) in the coarse-fallback branch', () => {
      // Regression guard: integrity is computed BEFORE the try/catch, so a
      // pathological pair that forces the fallback must NOT zero the integrity
      // counts. The unknown node forces the precise path to throw (fellBack).
      const oldDoc = doc(image(), callout(), table(), para('a [1]'), { type: '___nope' });
      const newDoc = doc(image(), image(), table(), para('b [2] [3]'));
      const result = diffDocs(oldDoc, newDoc);

      // The fallback was taken...
      expect(result.markdown).toContain('coarse block-level diff shown.');
      // ...yet every integrity tuple is the real count, not [0,0].
      expect(result.integrity.images).toEqual([1, 2]);
      expect(result.integrity.callouts).toEqual([1, 0]);
      expect(result.integrity.tables).toEqual([1, 1]);
      // Footnote markers are counted from both docs even under the fallback.
      expect(result.integrity.footnoteMarkers).toEqual([[1], [2, 3]]);
    });

    it('reports both a deletion and an insertion in the fallback path', () => {
      const oldDoc = doc(para('old paragraph'), { type: '___nope' });
      const newDoc = doc(para('new paragraph'));

      const result = diffDocs(oldDoc, newDoc);

      expect(result.markdown).toContain('coarse block-level diff shown.');
      const deletes = result.changes.filter((c) => c.op === 'delete');
      const inserts = result.changes.filter((c) => c.op === 'insert');
      // "old paragraph" no longer present -> deletion; "new paragraph" -> insertion.
      expect(deletes.map((c) => c.text)).toContain('old paragraph');
      expect(inserts.map((c) => c.text)).toContain('new paragraph');
      // Character counts accumulate from the reported texts.
      expect(result.summary.deleted).toBe('old paragraph'.length);
      expect(result.summary.inserted).toBe('new paragraph'.length);
    });
  });

  describe('blockContextAt (DiffChange.block)', () => {
    it('truncates a >80-char block context with an ellipsis and keeps it non-empty', () => {
      // A 100-char paragraph with a one-char edit; the block context guards a
      // swallowed catch and must produce a truncated, non-empty string.
      const longText = 'X'.repeat(100);
      const result = diffDocs(doc(para(longText)), doc(para(longText + 'Z')));

      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(inserts).toHaveLength(1);
      const block = inserts[0].block;
      expect(block.length).toBeGreaterThan(0);
      // Truncation rule: 77 chars + "..." = length 80, ending with "...".
      expect(block.endsWith('...')).toBe(true);
      expect(block).toHaveLength(80);
    });

    it('keeps a short block context untruncated', () => {
      const result = diffDocs(doc(para('abc')), doc(para('abcXY')));
      const inserts = result.changes.filter((c) => c.op === 'insert');
      expect(inserts[0].block).toBe('abcXY');
      expect(inserts[0].block.endsWith('...')).toBe(false);
    });

    it('dedups blocksChanged by op + block context (multiple edits in one block count once per op)', () => {
      // Two separate word edits inside a single paragraph produce 4 changes
      // (2 deletes + 2 inserts) but only 2 distinct block keys:
      //   "d:the quick brown fox" and "i:the slow brown wolf".
      const result = diffDocs(
        doc(para('the quick brown fox')),
        doc(para('the slow brown wolf')),
      );

      expect(result.changes.length).toBe(4);
      expect(result.summary.blocksChanged).toBe(2);
    });

    it('counts one block key per op for edits spread across two blocks', () => {
      // Edits in two different paragraphs -> 4 distinct block keys.
      const result = diffDocs(
        doc(para('first line here'), para('second line here')),
        doc(para('first line HERE'), para('second line HERE')),
      );

      expect(result.summary.blocksChanged).toBe(4);
    });
  });

  describe('markdown rendering', () => {
    it('puts the summary counts in the markdown header', () => {
      const result = diffDocs(doc(para('abc')), doc(para('abcXY')));
      expect(result.markdown).toContain(
        '# Diff: 2 inserted / 0 deleted (1 blocks changed)',
      );
    });

    it('renders each change with its op sign (loose membership, library-controlled order)', () => {
      const result = diffDocs(doc(para('hello world')), doc(para('hello there')));

      // The Changes section is ordered by the diff library; assert membership,
      // not an exact ordered string. Scope to lines AFTER the "## Changes"
      // heading, since integrity lines also begin with "- ".
      const lines = result.markdown.split('\n');
      const changesIdx = lines.indexOf('## Changes');
      expect(changesIdx).toBeGreaterThanOrEqual(0);
      const changeLines = lines
        .slice(changesIdx + 1)
        .filter((l) => l.startsWith('+ ') || l.startsWith('- '));
      expect(changeLines.some((l) => l.startsWith('- ') && l.includes('world'))).toBe(true);
      expect(changeLines.some((l) => l.startsWith('+ ') && l.includes('there'))).toBe(true);
      // One delete line and one insert line.
      expect(changeLines.filter((l) => l.startsWith('- '))).toHaveLength(1);
      expect(changeLines.filter((l) => l.startsWith('+ '))).toHaveLength(1);
    });
  });
});
