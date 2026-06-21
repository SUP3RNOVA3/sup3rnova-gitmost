import { describe, expect, it } from 'vitest';
// markdownToProseMirror lives next to the markdown->HTML preprocessors
// (preprocessCallouts, bridgeTaskLists). Those helpers are NOT exported, so we
// exercise them through the public entry point, which runs the full
// markdown -> preprocessCallouts -> marked -> bridgeTaskLists -> generateJSON
// pipeline. Importing this module mutates the global DOM via jsdom (required for
// @tiptap/html under Node) — expected, same as the property test.
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// Find every node of a given type anywhere in a ProseMirror doc tree.
const findAll = (node: any, type: string, acc: any[] = []): any[] => {
  if (node && node.type === type) acc.push(node);
  for (const child of node?.content || []) findAll(child, type, acc);
  return acc;
};
// Concatenate all text within a subtree (order-preserving).
const allText = (node: any): string => {
  if (node?.type === 'text') return node.text || '';
  return (node?.content || []).map(allText).join('');
};

// ---------------------------------------------------------------------------
// 3. preprocessCallouts — two uncovered branches.
//
// (a) NESTED callouts: an inner `:::type ... :::` inside an outer callout body
//     must be matched at its own nesting level (the depth counter) and emerge as
//     a callout NESTED inside the outer callout — not flattened or mis-closed.
// (b) A `:::` line INSIDE a fenced code block must NOT be treated as a callout
//     delimiter: the scanner tracks code fences and copies their lines verbatim,
//     so the outer callout's matching `:::` is the one AFTER the fence closes.
// ---------------------------------------------------------------------------
describe('preprocessCallouts: nested callouts + code-fenced ":::"', () => {
  it('(a) parses a callout nested inside another callout', async () => {
    const md = [
      ':::info',
      'outer text',
      ':::warning',
      'inner text',
      ':::',
      ':::',
    ].join('\n');

    const docNode = await markdownToProseMirror(md);

    // Exactly two callouts, and one is nested inside the other.
    const callouts = findAll(docNode, 'callout');
    expect(callouts).toHaveLength(2);

    const outer = docNode.content?.[0];
    expect(outer?.type).toBe('callout');
    expect(outer?.attrs?.type).toBe('info');

    // The inner callout is a CHILD of the outer one (not a sibling at doc level).
    const innerCallouts = (outer?.content || []).filter(
      (n: any) => n.type === 'callout',
    );
    expect(innerCallouts).toHaveLength(1);
    expect(innerCallouts[0].attrs?.type).toBe('warning');

    // Both bodies kept their text.
    expect(allText(outer)).toContain('outer text');
    expect(allText(innerCallouts[0])).toContain('inner text');
  });

  it('(b) a ":::" line inside a fenced code block is NOT a callout delimiter', async () => {
    // The inner ``` ... ``` fence contains a `:::` line. If preprocessCallouts
    // treated it as the closing fence, the callout would terminate early and the
    // code text would leak out. The correct behavior: the fence content survives
    // verbatim in a codeBlock, and the callout closes at the LAST ":::".
    const md = [
      ':::info',
      'before code',
      '```',
      ':::',
      'still inside the code fence',
      '```',
      'after code',
      ':::',
    ].join('\n');

    const docNode = await markdownToProseMirror(md);

    // One callout wrapping everything (it did not close early on the fenced ":::")
    const callouts = findAll(docNode, 'callout');
    expect(callouts).toHaveLength(1);
    const callout = callouts[0];

    // The code block is a CHILD of the callout and still contains the ":::" line.
    const codeBlocks = findAll(callout, 'codeBlock');
    expect(codeBlocks).toHaveLength(1);
    expect(allText(codeBlocks[0])).toContain(':::');
    expect(allText(codeBlocks[0])).toContain('still inside the code fence');

    // The text before and after the fence is part of the callout, not a stray
    // top-level paragraph created by an early close.
    expect(allText(callout)).toContain('before code');
    expect(allText(callout)).toContain('after code');
  });
});

// ---------------------------------------------------------------------------
// 4. bridgeTaskLists — numbered checklist + mixed-list negative.
//
// (a) A NUMBERED checklist (`1. [x] ...`) is rendered by marked as an <ol> of
//     checkbox <li>s. The bridge must convert it to a taskList AND rename the
//     <ol> to a <ul> so generateJSON does NOT also match the orderedList rule
//     and emit a phantom empty orderedList beside the real taskList.
// (b) NEGATIVE: a MIXED list (some items have checkboxes, some don't) must NOT
//     be converted — it stays an ordinary bullet/numbered list.
// ---------------------------------------------------------------------------
describe('bridgeTaskLists: numbered checklist + mixed-list negative', () => {
  it('(a) a numbered <ol> checklist becomes a taskList with NO phantom orderedList', async () => {
    const md = ['1. [x] done', '2. [ ] todo'].join('\n');

    const docNode = await markdownToProseMirror(md);

    // It became a taskList...
    const taskLists = findAll(docNode, 'taskList');
    expect(taskLists).toHaveLength(1);

    const items = (taskLists[0].content || []).filter(
      (n: any) => n.type === 'taskItem',
    );
    expect(items).toHaveLength(2);
    expect(items[0].attrs?.checked).toBe(true);
    expect(items[1].attrs?.checked).toBe(false);
    expect(allText(items[0])).toContain('done');
    expect(allText(items[1])).toContain('todo');

    // ...and NO phantom (empty) orderedList survived the <ol> -> <ul> rename.
    const orderedLists = findAll(docNode, 'orderedList');
    expect(orderedLists).toHaveLength(0);
  });

  it('(b) a MIXED list (some items checkboxed, some not) is NOT converted to a taskList', async () => {
    const md = ['- [x] checked item', '- plain item'].join('\n');

    const docNode = await markdownToProseMirror(md);

    // The bridge requires EVERY direct <li> to carry its own checkbox; one plain
    // item disqualifies the whole list, so it stays a bulletList.
    expect(findAll(docNode, 'taskList')).toHaveLength(0);
    expect(findAll(docNode, 'taskItem')).toHaveLength(0);

    const bulletLists = findAll(docNode, 'bulletList');
    expect(bulletLists).toHaveLength(1);
    const listItems = findAll(bulletLists[0], 'listItem');
    expect(listItems).toHaveLength(2);
    // Both items survive as ordinary list items (text preserved).
    expect(allText(bulletLists[0])).toContain('checked item');
    expect(allText(bulletLists[0])).toContain('plain item');
  });
});
