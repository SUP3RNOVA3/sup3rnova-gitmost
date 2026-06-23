import * as Y from 'yjs';

import { diff3Plan } from './three-way-merge';
import { buildLcsTable } from './lcs';

/**
 * Block-level merge of an incoming (git) page body into a LIVE Yjs document,
 * replacing the previous full-body "delete everything + re-insert" write that
 * clobbered concurrent human edits on every sync (review #5 — "do the write as a
 * merge").
 *
 * Strategy: diff the two documents at TOP-LEVEL BLOCK granularity (an LCS over a
 * canonical structural serialization of each block) and apply only the minimal
 * insert/delete operations. Blocks that are byte-identical on both sides are
 * left UNTOUCHED in the live doc — so a human editing one paragraph is unaffected
 * when git changes a different paragraph, and an unchanged re-sync is a complete
 * no-op (zero Yjs operations). Yjs then CRDT-merges the minimal ops with any
 * concurrent edits.
 *
 * Limitation (honest): this is a 2-way merge (live vs incoming). For a block that
 * BOTH sides changed since the last sync it cannot tell which is newer without a
 * common ancestor, so the incoming (git) version wins for that one block. A full
 * 3-way merge would need the last-synced base plumbed from the engine; the common
 * cases — unchanged resync, and edits to DIFFERENT blocks — are handled losslessly.
 */

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlHook;

/**
 * Canonical, comparable serialization of a Yjs XML node (structure + text +
 * marks + attributes), with attribute keys sorted so equal blocks always produce
 * an identical string regardless of attribute insertion order.
 */
export function serializeXmlNode(node: unknown): unknown {
  if (node instanceof Y.XmlText) {
    return { t: node.toDelta() };
  }
  if (node instanceof Y.XmlElement) {
    const attrs = node.getAttributes() as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(attrs).sort()) sorted[k] = attrs[k];
    return {
      n: node.nodeName,
      a: sorted,
      c: node.toArray().map(serializeXmlNode),
    };
  }
  // XmlHook / unknown: fall back to a stable string so it compares by identity
  // of its serialized form (these do not occur in the Docmost block schema).
  return { u: String(node) };
}

const key = (node: unknown): string => JSON.stringify(serializeXmlNode(node));

/**
 * Deep-clone a detached/owned Yjs XML node into a fresh node that can be inserted
 * into ANOTHER document (Yjs types are bound to their doc, so cross-doc moves are
 * impossible — we rebuild). Preserves nodeName, attributes, text+marks (via the
 * XmlText delta) and the full child subtree.
 */
export function cloneXmlNode(node: XmlNode): Y.XmlElement | Y.XmlText {
  if (node instanceof Y.XmlText) {
    const t = new Y.XmlText();
    const delta = node.toDelta();
    if (delta.length) t.applyDelta(delta);
    return t;
  }
  if (node instanceof Y.XmlElement) {
    const el = new Y.XmlElement(node.nodeName);
    const attrs = node.getAttributes() as Record<string, unknown>;
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k] as string);
    const kids = node.toArray().map((c) => cloneXmlNode(c as XmlNode));
    if (kids.length) el.insert(0, kids);
    return el;
  }
  // Best-effort for any other node type (XmlHook — does not occur in the
  // Docmost block schema): an empty paragraph so the merge never crashes.
  return new Y.XmlElement('paragraph');
}

type Op =
  | { op: 'keep' }
  | { op: 'del' }
  | { op: 'ins'; bi: number };

/**
 * LCS-based edit script turning sequence `a` (live block keys) into `b` (incoming
 * block keys): a run of keep/del/ins ops. O(n*m) table — fine for page block
 * counts.
 */
export function diffBlocks(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = buildLcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'keep' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del' });
      i++;
    } else {
      ops.push({ op: 'ins', bi: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: 'del' });
    i++;
  }
  while (j < m) {
    ops.push({ op: 'ins', bi: j });
    j++;
  }
  return ops;
}

/**
 * Merge `target` block children into `live`, mutating `live` in place with the
 * minimal set of inserts/deletes. MUST be called inside a Yjs transaction.
 * Returns the number of block operations applied (0 == content already identical).
 */
export function mergeXmlFragments(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
): number {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const liveKeys = liveKids.map(key);
  const targetKeys = targetKids.map(key);

  const ops = diffBlocks(liveKeys, targetKeys);

  let cursor = 0; // index into the LIVE fragment as we mutate it
  let applied = 0;
  for (const op of ops) {
    if (op.op === 'keep') {
      cursor++;
    } else if (op.op === 'del') {
      live.delete(cursor, 1); // remove the live block at the cursor; do not advance
      applied++;
    } else {
      live.insert(cursor, [cloneXmlNode(targetKids[op.bi] as XmlNode)]);
      cursor++;
      applied++;
    }
  }
  return applied;
}

/**
 * THREE-WAY block merge: reconcile `live` toward `target` using `base` (the
 * last-synced common ancestor) so a block only the human changed is KEPT and a
 * block only git changed is taken — instead of git's version always winning
 * (review #5). Conflicts (both changed the same block) resolve to git.
 *
 * Implementation: diff3Plan computes the merged block ORDER (picks from live or
 * target); we materialize that as a virtual target fragment and reuse the 2-way
 * `mergeXmlFragments` to splice it into `live` minimally (so untouched live block
 * instances — and their in-flight edits — stay put). MUST be called inside a Yjs
 * transaction. Returns the number of block operations applied.
 */
export function mergeXmlFragments3Way(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
  base: Y.XmlFragment,
): number {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const liveKeys = liveKids.map(key);
  const targetKeys = targetKids.map(key);
  const baseKeys = base.toArray().map(key);

  const plan = diff3Plan(baseKeys, liveKeys, targetKeys);

  // Build the merged block sequence in a throwaway doc, cloning from whichever
  // side each pick came from, then 2-way merge it back into the live fragment.
  const merged = new Y.Doc();
  const mergedFrag = merged.getXmlFragment('default');
  const nodes = plan.map((p) =>
    cloneXmlNode(
      (p.src === 'live' ? liveKids[p.index] : targetKids[p.index]) as XmlNode,
    ),
  );
  if (nodes.length) mergedFrag.insert(0, nodes);

  return mergeXmlFragments(live, mergedFrag);
}
