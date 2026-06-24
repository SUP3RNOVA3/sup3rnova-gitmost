import { describe, expect, it } from 'vitest';
import { computePushActions } from '../src/engine/push';
import type { DiffEntry, MetaSide } from '../src/engine/push';
import type { DocmostMdMeta } from '../src/lib/index';

// FS→Docmost push, FIRST increment (SPEC §6). `computePushActions` is the PURE
// half: it classifies each `git diff --name-status` row into a Docmost action by
// `pageId` identity (SPEC §4/§8), with NO IO — the `metaAt` resolver is injected.
// These tests cover every classification incl. edges.

/** Build a `metaAt` resolver from a `path|side -> meta` table. */
function metaTable(
  table: Record<string, DocmostMdMeta | null>,
): (path: string, side: MetaSide) => DocmostMdMeta | null {
  return (path, side) => {
    const key = `${path}|${side}`;
    return key in table ? table[key] : null;
  };
}

function meta(partial: Partial<DocmostMdMeta>): DocmostMdMeta {
  return { version: 1, ...partial };
}

describe('computePushActions — A (added)', () => {
  it('added file with NO pageId -> create', () => {
    const changes: DiffEntry[] = [{ status: 'A', path: 'New.md' }];
    const metaAt = metaTable({
      'New.md|current': meta({ title: 'New', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([{ path: 'New.md' }]);
    expect(actions.updates).toEqual([]);
    expect(actions.deletes).toEqual([]);
    expect(actions.renamesMoves).toEqual([]);
    expect(actions.skipped).toEqual([]);
  });

  it('added file with NO meta at all -> skipped (a create needs a spaceId)', () => {
    // No meta -> no spaceId -> cannot create (Docmost create_page requires it).
    const changes: DiffEntry[] = [{ status: 'A', path: 'Plain.md' }];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Plain.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file with meta but NO spaceId -> skipped (create-without-spaceId)', () => {
    // Partial human meta (title only, no spaceId) -> refuse to create.
    const changes: DiffEntry[] = [{ status: 'A', path: 'Partial.md' }];
    const metaAt = metaTable({
      'Partial.md|current': meta({ title: 'Partial' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Partial.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file with an EMPTY-string spaceId -> skipped (create-without-spaceId)', () => {
    // An empty spaceId is not a usable target either.
    const changes: DiffEntry[] = [{ status: 'A', path: 'Empty.md' }];
    const metaAt = metaTable({
      'Empty.md|current': meta({ title: 'E', spaceId: '' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.creates).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'Empty.md', status: 'A', reason: 'create-without-spaceId' },
    ]);
  });

  it('added file WITH a pageId (restored/copied) -> update (page exists)', () => {
    const changes: DiffEntry[] = [{ status: 'A', path: 'Restored.md' }];
    const metaAt = metaTable({
      'Restored.md|current': meta({ pageId: 'p-restored', title: 'R' }),
    });
    const actions = computePushActions({ changes, metaAt });
    // The page already exists -> push content as an UPDATE, never a duplicate.
    expect(actions.updates).toEqual([
      { pageId: 'p-restored', path: 'Restored.md' },
    ]);
    expect(actions.creates).toEqual([]);
  });
});

describe('computePushActions — M (modified)', () => {
  it('modified file with a pageId -> update content', () => {
    const changes: DiffEntry[] = [{ status: 'M', path: 'Doc.md' }];
    const metaAt = metaTable({
      'Doc.md|current': meta({ pageId: 'p-doc' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.updates).toEqual([{ pageId: 'p-doc', path: 'Doc.md' }]);
    expect(actions.skipped).toEqual([]);
  });

  it('modified file with NO pageId -> skipped (no target to update)', () => {
    const changes: DiffEntry[] = [{ status: 'M', path: 'Untracked.md' }];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.updates).toEqual([]);
    expect(actions.skipped).toEqual([
      {
        path: 'Untracked.md',
        status: 'M',
        reason: 'modified file has no pageId in meta',
      },
    ]);
  });
});

describe('computePushActions — D (deleted)', () => {
  it('deleted file recovers pageId from the PRE-IMAGE meta -> delete', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    // The file is gone from `current`; its pageId lives in the `prev` pre-image.
    const metaAt = metaTable({
      'Gone.md|prev': meta({ pageId: 'p-gone' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p-gone' }]);
    expect(actions.skipped).toEqual([]);
  });

  it('deleted file with NO recoverable pageId -> skipped (untracked guard §8)', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Stray.md' }];
    // No pre-image pageId -> the untracked-file guard skips it (never deletes a
    // page that was never tracked, SPEC §8).
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.deletes).toEqual([]);
    expect(actions.skipped).toEqual([
      {
        path: 'Stray.md',
        status: 'D',
        reason: 'deleted file has no recoverable pageId (pre-image meta)',
      },
    ]);
  });

  it('uses the PREV side, not current, to recover the deleted pageId', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    // A stale `current` meta must NOT be used; only the pre-image counts.
    const metaAt = metaTable({
      'Gone.md|current': meta({ pageId: 'WRONG' }),
      'Gone.md|prev': meta({ pageId: 'p-correct' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p-correct' }]);
  });
});

describe('computePushActions — R/C (renamed/moved)', () => {
  it('renamed file -> renamesMoves (record only; resolution deferred)', () => {
    const changes: DiffEntry[] = [
      { status: 'R', path: 'New/Path.md', oldPath: 'Old/Path.md', score: 100 },
    ];
    const metaAt = metaTable({
      'New/Path.md|current': meta({ pageId: 'p-moved' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-moved', oldPath: 'Old/Path.md', newPath: 'New/Path.md' },
    ]);
    // It is NOT also recorded as a create/update/delete.
    expect(actions.creates).toEqual([]);
    expect(actions.updates).toEqual([]);
    expect(actions.deletes).toEqual([]);
  });

  it('copy (C) is recorded like a rename for the deferred apply', () => {
    const changes: DiffEntry[] = [
      { status: 'C', path: 'Copy.md', oldPath: 'Src.md', score: 90 },
    ];
    const metaAt = metaTable({
      'Copy.md|current': meta({ pageId: 'p-copy' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-copy', oldPath: 'Src.md', newPath: 'Copy.md' },
    ]);
  });

  it('renamed file with NO pageId -> skipped', () => {
    const changes: DiffEntry[] = [
      { status: 'R', path: 'New.md', oldPath: 'Old.md', score: 100 },
    ];
    const actions = computePushActions({ changes, metaAt: metaTable({}) });
    expect(actions.renamesMoves).toEqual([]);
    expect(actions.skipped).toEqual([
      { path: 'New.md', status: 'R', reason: 'renamed/moved file has no pageId in meta' },
    ]);
  });
});

describe('computePushActions — mixed batch', () => {
  it('classifies a realistic mixed diff in one pass', () => {
    const changes: DiffEntry[] = [
      { status: 'A', path: 'Fresh.md' }, // create
      { status: 'A', path: 'Restored.md' }, // update (has pageId)
      { status: 'M', path: 'Edited.md' }, // update
      { status: 'D', path: 'Removed.md' }, // delete
      { status: 'R', path: 'Dst.md', oldPath: 'Srcc.md', score: 100 }, // move
    ];
    const metaAt = metaTable({
      'Fresh.md|current': meta({ title: 'Fresh', spaceId: 'sp' }),
      'Restored.md|current': meta({ pageId: 'p-rest' }),
      'Edited.md|current': meta({ pageId: 'p-edit' }),
      'Removed.md|prev': meta({ pageId: 'p-rm' }),
      'Dst.md|current': meta({ pageId: 'p-mv' }),
    });
    const actions = computePushActions({ changes, metaAt });

    expect(actions.creates).toEqual([{ path: 'Fresh.md' }]);
    expect(actions.updates).toEqual([
      { pageId: 'p-rest', path: 'Restored.md' },
      { pageId: 'p-edit', path: 'Edited.md' },
    ]);
    expect(actions.deletes).toEqual([{ pageId: 'p-rm' }]);
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p-mv', oldPath: 'Srcc.md', newPath: 'Dst.md' },
    ]);
    expect(actions.skipped).toEqual([]);
  });
});

describe('computePushActions — ghost-move coalescing (data-loss guard)', () => {
  // git's `-M` rename detection misses a move when the files are too dissimilar
  // (tiny meta-only files after a layout reshuffle of `_`-fallback names). git
  // then reports the move as a DELETE of the old path + an ADD of the new one.
  // Taken literally this soft-deletes a page that merely MOVED. The classifier
  // must recognize the shared pageId and emit a rename/move, never a delete.
  it('D(old)+A(new) of the SAME pageId -> rename/move, NOT a delete', () => {
    const changes: DiffEntry[] = [
      { status: 'D', path: '_ ~slug.md' },
      { status: 'A', path: '_.md' },
    ];
    const metaAt = metaTable({
      '_ ~slug.md|prev': meta({ pageId: 'p1', title: '', spaceId: 'sp1' }),
      '_.md|current': meta({ pageId: 'p1', title: '', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([]); // the page is NEVER trashed
    expect(actions.updates).toEqual([]); // not a spurious update either
    expect(actions.renamesMoves).toEqual([
      { pageId: 'p1', oldPath: '_ ~slug.md', newPath: '_.md' },
    ]);
    // The suppressed delete is recorded as a skip with a clear reason.
    expect(actions.skipped).toEqual([
      {
        path: '_ ~slug.md',
        status: 'D',
        reason: 'ghost-move (re-added at a new path) — not a deletion',
      },
    ]);
  });

  it('a real delete (no matching add) is STILL a delete', () => {
    const changes: DiffEntry[] = [{ status: 'D', path: 'Gone.md' }];
    const metaAt = metaTable({
      'Gone.md|prev': meta({ pageId: 'p9', title: 'Gone', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'p9' }]);
    expect(actions.renamesMoves).toEqual([]);
  });

  it('an unrelated D + A (different pageIds) are a real delete + a real update', () => {
    const changes: DiffEntry[] = [
      { status: 'D', path: 'A.md' },
      { status: 'A', path: 'B.md' },
    ];
    const metaAt = metaTable({
      'A.md|prev': meta({ pageId: 'pa', title: 'A', spaceId: 'sp1' }),
      'B.md|current': meta({ pageId: 'pb', title: 'B', spaceId: 'sp1' }),
    });
    const actions = computePushActions({ changes, metaAt });
    expect(actions.deletes).toEqual([{ pageId: 'pa' }]);
    expect(actions.updates).toEqual([{ pageId: 'pb', path: 'B.md' }]);
    expect(actions.renamesMoves).toEqual([]);
  });
});
