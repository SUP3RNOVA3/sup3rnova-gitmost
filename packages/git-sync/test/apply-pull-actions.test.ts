import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { applyPullActions } from '../src/engine/pull';
import type {
  PullActions,
  ApplyPullActionsDeps,
} from '../src/engine/pull';
import type { DeletionDecision } from '../src/engine/reconcile';

// R-Pull-2 (test-strategy report §5): `applyPullActions` is the THIN IO half of
// the pull cycle. These tests drive it with FAKES that record every call — no
// real git, fs, or network — so the ordering and the ⭐ move-on-success
// data-loss guard are verifiable. SPEC §8 (delete suppression) + SPEC §5 (commit
// subject reflects ACTUAL counts) are asserted here.

const VAULT = '/vault';

/** A getPageJson fake: returns a minimal page whose content stabilizes cheaply. */
function makeClient(opts?: { failFor?: Set<string> }) {
  const calls: string[] = [];
  const client = {
    getPageJson: vi.fn(async (pageId: string) => {
      calls.push(pageId);
      if (opts?.failFor?.has(pageId)) {
        throw new Error(`fetch failed for ${pageId}`);
      }
      return {
        id: pageId,
        slugId: `slug-${pageId}`,
        title: `Title ${pageId}`,
        spaceId: 'space',
        parentPageId: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        // A trivial doc so stabilizePageFile (the real one) runs fast.
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: pageId }] },
          ],
        },
      };
    }),
  };
  return { client, calls };
}

/** A git fake recording the order of ops; merge result is configurable. */
function makeGit(merge: { ok: boolean; conflict: boolean; output?: string } = {
  ok: true,
  conflict: false,
}) {
  const order: string[] = [];
  let committedSubject: string | undefined;
  const git = {
    stageAll: vi.fn(async () => {
      order.push('stageAll');
    }),
    commit: vi.fn(async (subject: string) => {
      order.push(`commit:${subject}`);
      committedSubject = subject;
      return true;
    }),
    checkout: vi.fn(async (branch: string) => {
      order.push(`checkout:${branch}`);
    }),
    merge: vi.fn(async () => {
      order.push('merge');
      return { ok: merge.ok, conflict: merge.conflict, output: merge.output ?? '' };
    }),
  };
  return {
    git,
    order,
    get committedSubject() {
      return committedSubject;
    },
  };
}

/** A recording fs fake: writes/mkdirs/rms tracked in arrays. */
function makeFs(opts?: { failWriteFor?: Set<string> }) {
  const writes: { abs: string; text: string }[] = [];
  const mkdirs: string[] = [];
  const rms: string[] = [];
  const fs = {
    writeFile: vi.fn(async (abs: string, text: string) => {
      // Fail a specific destination path if asked (to simulate a write failure).
      if (opts?.failWriteFor?.has(abs)) {
        throw new Error(`write failed for ${abs}`);
      }
      writes.push({ abs, text });
    }),
    mkdir: vi.fn(async (abs: string) => {
      mkdirs.push(abs);
    }),
    rm: vi.fn(async (abs: string) => {
      rms.push(abs);
    }),
  };
  return { fs, writes, mkdirs, rms };
}

function deps(
  client: any,
  git: any,
  fs: ReturnType<typeof makeFs>,
): ApplyPullActionsDeps {
  return {
    client,
    git,
    writeFile: fs.fs.writeFile,
    mkdir: fs.fs.mkdir,
    rm: fs.fs.rm,
  };
}

const APPLY: DeletionDecision = { apply: true };

function actions(partial: Partial<PullActions>): PullActions {
  return {
    toWrite: [],
    moved: [],
    toDelete: [],
    deletionDecision: APPLY,
    existingCount: 0,
    plannedDeleteCount: 0,
    ...partial,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyPullActions — happy path (write + commit + merge)', () => {
  it('fetches, writes each page, stages, commits, checks out main, merges', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [
          { pageId: 'p1', relPath: 'A.md' },
          { pageId: 'p2', relPath: 'Sub/B.md' },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.committed).toBe(true);
    expect(res.merge).toEqual({ ok: true, conflict: false, output: '' });

    // Both pages were fetched and written at their absolute paths.
    expect(client.getPageJson).toHaveBeenCalledTimes(2);
    const writtenPaths = fs.writes.map((w) => w.abs).sort();
    expect(writtenPaths).toEqual(['/vault/A.md', '/vault/Sub/B.md']);

    // The git op order is: stageAll -> commit -> checkout main -> merge.
    expect(g.order).toEqual([
      'stageAll',
      `commit:docmost: sync 2 page(s)`,
      'checkout:main',
      'merge',
    ]);
  });
});

describe('applyPullActions — ordering (write before move/delete before commit)', () => {
  it('does writes, then move-old-path removals, then deletes, then commit/merge', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
        toDelete: ['Dead.md'],
        plannedDeleteCount: 1,
        existingCount: 3,
      }),
      VAULT,
    );

    // The write to the new path happened (the page was fetched first).
    expect(fs.writes.map((w) => w.abs)).toEqual(['/vault/New/M.md']);
    // The move old-path removal AND the absence delete both ran, old path first.
    expect(fs.rms).toEqual(['/vault/Old/M.md', '/vault/Dead.md']);
    // git ops happen AFTER all fs work.
    expect(g.order).toEqual([
      'stageAll',
      'commit:docmost: sync 1 page(s), 1 deleted',
      'checkout:main',
      'merge',
    ]);
  });
});

describe('applyPullActions — ⭐ data-loss guard (move-on-success)', () => {
  it('does NOT remove the OLD path when the new-path write FAILS', async () => {
    // The page "m" is being moved Old/M.md -> New/M.md, but its new-path write
    // FAILS. Removing the old path now would erase the only copy of the page.
    // The guard must KEEP the old path.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs({ failWriteFor: new Set(['/vault/New/M.md']) });

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
      }),
      VAULT,
    );

    // The write failed -> recorded as a failure, nothing written.
    expect(res.failed).toBe(1);
    expect(res.written).toBe(0);
    expect(fs.writes).toEqual([]);
    // ⭐ The OLD path was NOT removed: the data-loss guard kept it.
    expect(fs.rms).not.toContain('/vault/Old/M.md');
    expect(fs.rms).toEqual([]);
    expect(res.movedApplied).toBe(0);

    // The commit subject reflects ACTUAL counts: 0 written, 0 deleted.
    expect(g.committedSubject).toBe('docmost: sync 0 page(s)');
  });

  it('DOES remove the old path when the new-path write SUCCEEDS', async () => {
    // Same move, but the write succeeds -> the old path is safely removed. This
    // is the positive control proving the guard is keyed on write success.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs(); // no write failures

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'Old/M.md',
            toRelPath: 'New/M.md',
            removeOldPath: true,
          },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(1);
    expect(res.movedApplied).toBe(1);
    expect(fs.rms).toContain('/vault/Old/M.md');
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
  });

  it('honours removeOldPath:false (path reused by another live page is kept)', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'm', relPath: 'New/M.md' }],
        moved: [
          {
            pageId: 'm',
            fromRelPath: 'X.md',
            toRelPath: 'New/M.md',
            removeOldPath: false, // X.md is a live target of another page
          },
        ],
      }),
      VAULT,
    );

    // The reused old path is never removed.
    expect(fs.rms).not.toContain('/vault/X.md');
    expect(fs.rms).toEqual([]);
  });
});

describe('applyPullActions — deletion suppression (SPEC §8)', () => {
  it('skips deletions when the decision SUPPRESSES them (toDelete already empty)', async () => {
    // computePullActions empties toDelete when suppressed, but assert the applier
    // ALSO does no removals and the subject omits the deleted count.
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        // Suppressed: toDelete is empty even though 5 were planned.
        toDelete: [],
        deletionDecision: { apply: false, reason: 'incomplete-fetch' },
        plannedDeleteCount: 5,
        existingCount: 6,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(0);
    expect(fs.rms).toEqual([]);
    // Subject reflects 0 deleted (no ", N deleted" suffix).
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
    // The suppression warning was emitted.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/tree fetch incomplete/),
    );
  });

  it('applies deletions present in toDelete when the decision allows them', async () => {
    const { client } = makeClient();
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [{ pageId: 'p1', relPath: 'A.md' }],
        toDelete: ['Dead1.md', 'Dead2.md'],
        deletionDecision: APPLY,
        plannedDeleteCount: 2,
        existingCount: 5,
      }),
      VAULT,
    );

    expect(res.deleted).toBe(2);
    expect(fs.rms).toEqual(['/vault/Dead1.md', '/vault/Dead2.md']);
    // Subject reflects ACTUAL written + deleted counts.
    expect(g.committedSubject).toBe('docmost: sync 1 page(s), 2 deleted');
  });
});

describe('applyPullActions — commit subject reflects ACTUAL counts', () => {
  it('counts only SUCCESSFUL writes when some page fetches fail', async () => {
    // p2 fetch fails; the subject must say 1 page (only p1 was written), not 2.
    const { client } = makeClient({ failFor: new Set(['p2']) });
    const g = makeGit();
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({
        toWrite: [
          { pageId: 'p1', relPath: 'A.md' },
          { pageId: 'p2', relPath: 'B.md' },
        ],
      }),
      VAULT,
    );

    expect(res.written).toBe(1);
    expect(res.failed).toBe(1);
    expect(g.committedSubject).toBe('docmost: sync 1 page(s)');
  });
});

describe('applyPullActions — merge result is surfaced, not swallowed', () => {
  it('returns conflict:true on a conflicting merge (no auto-resolve)', async () => {
    const { client } = makeClient();
    const g = makeGit({ ok: false, conflict: true, output: 'CONFLICT' });
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [{ pageId: 'p1', relPath: 'A.md' }] }),
      VAULT,
    );
    expect(res.merge.conflict).toBe(true);
    expect(res.merge.ok).toBe(false);
  });

  it('returns ok:false conflict:false on a non-conflict merge failure', async () => {
    const { client } = makeClient();
    const g = makeGit({ ok: false, conflict: false, output: 'some error' });
    const fs = makeFs();

    const res = await applyPullActions(
      deps(client, g.git, fs),
      actions({ toWrite: [{ pageId: 'p1', relPath: 'A.md' }] }),
      VAULT,
    );
    expect(res.merge.ok).toBe(false);
    expect(res.merge.conflict).toBe(false);
  });
});
