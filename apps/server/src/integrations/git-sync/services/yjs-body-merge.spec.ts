import * as Y from 'yjs';

import {
  mergeXmlFragments,
  mergeXmlFragments3Way,
  cloneXmlNode,
  diffBlocks,
} from './yjs-body-merge';

// Build a Y.XmlFragment('default') in `doc` from a list of paragraph specs.
// Each spec is the paragraph's plain text (a single XmlText child).
function buildFragment(doc: Y.Doc, paragraphs: string[]): Y.XmlFragment {
  const frag = doc.getXmlFragment('default');
  const blocks = paragraphs.map((text) => {
    const el = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    if (text) t.insert(0, text);
    el.insert(0, [t]);
    return el;
  });
  if (blocks.length) frag.insert(0, blocks);
  return frag;
}

function texts(frag: Y.XmlFragment): string[] {
  return frag.toArray().map((el) => (el as Y.XmlElement).toArray()
    .map((c) => (c as Y.XmlText).toString())
    .join(''));
}

describe('yjs-body-merge', () => {
  describe('diffBlocks (LCS edit script)', () => {
    it('identical sequences produce only keeps (no edits)', () => {
      const ops = diffBlocks(['a', 'b', 'c'], ['a', 'b', 'c']);
      expect(ops.every((o) => o.op === 'keep')).toBe(true);
    });

    it('a single changed middle element is one del + one ins', () => {
      const ops = diffBlocks(['a', 'b', 'c'], ['a', 'B', 'c']);
      expect(ops.filter((o) => o.op === 'del')).toHaveLength(1);
      expect(ops.filter((o) => o.op === 'ins')).toHaveLength(1);
      expect(ops.filter((o) => o.op === 'keep')).toHaveLength(2);
    });
  });

  describe('mergeXmlFragments', () => {
    it('identical content is a complete no-op (0 ops) — never clobbers an unchanged resync', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['one', 'two', 'three']);
      const targetFrag = buildFragment(target, ['one', 'two', 'three']);

      // Capture block identities to prove they are left untouched.
      const before = liveFrag.toArray();
      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(0);
      // Same Y.XmlElement instances — nothing was deleted/recreated.
      expect(liveFrag.toArray()).toEqual(before);
      expect(texts(liveFrag)).toEqual(['one', 'two', 'three']);
    });

    it('a human edit to one block survives a git change to a DIFFERENT block', () => {
      // Live: the human has the doc open; block 0 holds their edit. Git changed
      // only block 2. The merge must touch ONLY block 2 and leave block 0 (and
      // its in-flight edit) exactly as-is.
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['HUMAN EDIT', 'shared', 'old tail']);
      const targetFrag = buildFragment(target, [
        'HUMAN EDIT',
        'shared',
        'new tail from git',
      ]);

      const block0Before = liveFrag.get(0); // the human's block instance
      const block1Before = liveFrag.get(1);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      // Only block 2 was replaced: one del + one ins.
      expect(applied).toBe(2);
      // The human's block and the shared block are the SAME instances (untouched).
      expect(liveFrag.get(0)).toBe(block0Before);
      expect(liveFrag.get(1)).toBe(block1Before);
      // Block 2 now carries git's content.
      expect(texts(liveFrag)).toEqual([
        'HUMAN EDIT',
        'shared',
        'new tail from git',
      ]);
    });

    it('appends a new trailing block without disturbing existing ones', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['a', 'b']);
      const targetFrag = buildFragment(target, ['a', 'b', 'c']);
      const a = liveFrag.get(0);
      const b = liveFrag.get(1);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(1); // single insert
      expect(liveFrag.get(0)).toBe(a);
      expect(liveFrag.get(1)).toBe(b);
      expect(texts(liveFrag)).toEqual(['a', 'b', 'c']);
    });

    it('deletes a removed block, keeping its neighbours', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['a', 'b', 'c']);
      const targetFrag = buildFragment(target, ['a', 'c']);
      const a = liveFrag.get(0);

      let applied = -1;
      live.transact(() => {
        applied = mergeXmlFragments(liveFrag, targetFrag);
      });

      expect(applied).toBe(1); // single delete
      expect(liveFrag.get(0)).toBe(a);
      expect(texts(liveFrag)).toEqual(['a', 'c']);
    });

    it('a fully different body is replaced (and stays valid)', () => {
      const live = new Y.Doc();
      const target = new Y.Doc();
      const liveFrag = buildFragment(live, ['x', 'y']);
      const targetFrag = buildFragment(target, ['p', 'q', 'r']);
      live.transact(() => mergeXmlFragments(liveFrag, targetFrag));
      expect(texts(liveFrag)).toEqual(['p', 'q', 'r']);
    });
  });

  describe('mergeXmlFragments3Way', () => {
    it('keeps a human edit to one block while applying a git change to another (3-way)', () => {
      // base (last synced): [a, b, c]. Human edited block 0 in the live doc; git
      // changed block 2 in the incoming file. 3-way must keep BOTH — the 2-way
      // merge would instead revert the human's block 0 to git's stale version.
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['HUMAN', 'b', 'c']);
      const targetFrag = buildFragment(target, ['a', 'b', 'GIT']);

      const humanBlock = liveFrag.get(0); // the human's live instance
      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );

      // Human's block preserved as the SAME instance; git's change applied.
      expect(liveFrag.get(0)).toBe(humanBlock);
      expect(texts(liveFrag)).toEqual(['HUMAN', 'b', 'GIT']);
    });

    it('a block both sides changed resolves to git (conflict policy)', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b', 'c']);
      const liveFrag = buildFragment(live, ['a', 'HUMAN', 'c']);
      const targetFrag = buildFragment(target, ['a', 'GIT', 'c']);

      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );
      expect(texts(liveFrag)).toEqual(['a', 'GIT', 'c']);
    });

    it('git change with no concurrent human edit (live == base) applies cleanly', () => {
      const base = new Y.Doc();
      const live = new Y.Doc();
      const target = new Y.Doc();
      const baseFrag = buildFragment(base, ['a', 'b']);
      const liveFrag = buildFragment(live, ['a', 'b']);
      const targetFrag = buildFragment(target, ['a', 'B2']);

      live.transact(() =>
        mergeXmlFragments3Way(liveFrag, targetFrag, baseFrag),
      );
      expect(texts(liveFrag)).toEqual(['a', 'B2']);
    });
  });

  describe('cloneXmlNode', () => {
    it('preserves text marks (XmlText delta) across docs', () => {
      const src = new Y.Doc();
      const srcFrag = src.getXmlFragment('default');
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'plain ');
      t.insert(6, 'bold', { bold: true });
      el.insert(0, [t]);
      srcFrag.insert(0, [el]);

      const dst = new Y.Doc();
      const dstFrag = dst.getXmlFragment('default');
      dstFrag.insert(0, [cloneXmlNode(srcFrag.get(0) as Y.XmlElement)]);

      const clonedText = (dstFrag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      expect(clonedText.toDelta()).toEqual([
        { insert: 'plain ' },
        { insert: 'bold', attributes: { bold: true } },
      ]);
    });
  });
});
