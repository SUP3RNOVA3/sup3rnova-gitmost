import { describe, expect, it, vi } from 'vitest';
import { runPush, LAST_PUSHED_REF, DOCMOST_BRANCH } from '../src/engine/push';
import type { PushDeps } from '../src/engine/push';
import type { Settings } from '../src/engine/settings';
import { runCycle, type RunCycleDeps } from '../src/engine/cycle';
import { serializePageFile } from '../src/lib/page-file';

// Red-team confirmations for PR #119 (git-sync). Each test asserts the DESIRED
// behavior, so it FAILS today iff the bug is real.

function makeSettings(): Settings {
  return {
    docmostApiUrl: 'https://docmost.example.com',
    docmostEmail: 'you@example.com',
    docmostPassword: 'secret',
    docmostSpaceId: 'space-1',
    vaultPath: '/vault',
    pollIntervalMs: 15000,
    debounceMs: 2000,
    logLevel: 'info',
  } as Settings;
}

// ---------------------------------------------------------------------------
// #13 — conflict markers must never reach Docmost (SPEC §9), even when there is
// NO in-progress merge (markers committed on `main` by some other path). The
// behavior is now gated by the per-space `autoMergeConflicts` setting:
//   - DEFAULT (off): a still-conflicted page is NOT pushed — it is recorded as a
//     per-page FAILURE and the refs are NOT advanced, so the user resolves the
//     git conflict first.
//   - ON: the marker lines are stripped and both sides' content is pushed.
// ---------------------------------------------------------------------------
function makePushGit(opts: {
  changes: { status: 'A' | 'M' | 'D' | 'R' | 'C'; path: string; oldPath?: string }[];
  lastPushed?: string | null;
}) {
  const calls = { updateRef: [] as { ref: string; target: string }[] };
  const git: PushDeps['git'] = {
    assertGitAvailable: vi.fn(async () => {}),
    ensureRepo: vi.fn(async () => {}),
    isMergeInProgress: vi.fn(async () => false), // NO merge in progress
    checkout: vi.fn(async () => {}),
    stageAll: vi.fn(async () => {}),
    commit: vi.fn(async () => false),
    readRef: vi.fn(async (ref: string) =>
      ref === LAST_PUSHED_REF ? (opts.lastPushed ?? 'base-sha') : null,
    ),
    revParse: vi.fn(async (ref: string) => {
      if (ref === DOCMOST_BRANCH) return 'doc-sha';
      if (ref === 'main') return 'main-sha';
      return null;
    }),
    diffNameStatus: vi.fn(async () => opts.changes),
    showFileAtRef: vi.fn(async () => null),
    updateRef: vi.fn(async (ref: string, target: string) => {
      calls.updateRef.push({ ref, target });
    }),
    fastForwardBranch: vi.fn(async () => ({ ok: true })),
    listTrackedFiles: vi.fn(async () => [] as string[]),
  };
  return { git, calls };
}

describe('#13 conflict markers reach Docmost', () => {
  const conflictBody =
    '<<<<<<< HEAD\nmy line\n=======\ntheir line\n>>>>>>> feature\n';

  function makeConflictDeps(settings: Settings) {
    const file = serializePageFile('p-1', conflictBody);
    const { git, calls } = makePushGit({
      changes: [{ status: 'M', path: 'Doc.md' }],
    });

    const importPageMarkdown = vi.fn(async () => ({ success: true }));
    const client = {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      importPageMarkdown,
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
    };

    const deps: PushDeps = {
      settings,
      git,
      makeClient: () => client as any,
      readFile: vi.fn(async (path: string) => {
        if (path === 'Doc.md') return file;
        throw new Error(`no such file: ${path}`);
      }),
      writeFile: vi.fn(async () => {}),
      log: () => {},
    };
    return { deps, importPageMarkdown, calls };
  }

  it('DEFAULT (autoMergeConflicts off): does NOT push a conflicted page; records a failure and holds the refs', async () => {
    // makeSettings() leaves autoMergeConflicts undefined -> the SAFE default.
    const { deps, importPageMarkdown, calls } = makeConflictDeps(makeSettings());

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The conflicted page is NOT pushed to Docmost at all.
    expect(importPageMarkdown).not.toHaveBeenCalled();

    // It is recorded as a per-page failure (so the user resolves the git conflict
    // first), and because there is a failure the last-pushed ref is NOT advanced.
    expect(res.applied?.failures).toEqual([
      expect.objectContaining({
        kind: 'update',
        pageId: 'p-1',
        path: 'Doc.md',
      }),
    ]);
    expect(res.applied?.failures[0].error).toMatch(/conflict markers/i);
    expect(res.applied?.lastPushedAdvanced).toBe(false);
    expect(calls.updateRef).toHaveLength(0);
  });

  it('autoMergeConflicts on: strips the markers and pushes a clean body', async () => {
    const { deps, importPageMarkdown } = makeConflictDeps({
      ...makeSettings(),
      autoMergeConflicts: true,
    });

    const res = await runPush(deps, { dryRun: false });
    expect(res.mode).toBe('apply');

    // The body actually sent to Docmost (2nd positional arg is the markdown body).
    expect(importPageMarkdown).toHaveBeenCalledTimes(1);
    const pushedBody: string = importPageMarkdown.mock.calls[0][1] as any;

    // The marker SYNTAX is stripped; both sides' content survives.
    expect(pushedBody).not.toContain('<<<<<<<');
    expect(pushedBody).not.toContain('=======');
    expect(pushedBody).not.toContain('>>>>>>>');
    expect(pushedBody).toContain('my line');
    expect(pushedBody).toContain('their line');
  });
});

// ---------------------------------------------------------------------------
// #15 — a divergent `docmost` mirror (fastForwardBranch refuses) is escalated by
// runPush (`divergentDocmost: true`), but runCycle forwards only {mode, failures}
// — the divergence is DROPPED from RunCycleResult. DESIRED: the cycle result
// surfaces the divergence so the caller can act on it.
// ---------------------------------------------------------------------------
function fakeVault(overrides: Record<string, any> = {}) {
  const order: string[] = [];
  const rec =
    (name: string, ret?: any) =>
    async (...args: any[]) => {
      order.push(args.length ? `${name}:${args.join(',')}` : name);
      return ret;
    };
  const vault: any = {
    order,
    assertGitAvailable: rec('assertGitAvailable'),
    ensureRepo: rec('ensureRepo'),
    isMergeInProgress: vi.fn(async () => false),
    ensureBranch: rec('ensureBranch'),
    checkout: rec('checkout'),
    listTrackedFiles: vi.fn(async () => [] as string[]),
    stageAll: rec('stageAll'),
    commit: rec('commit', false),
    merge: rec('merge', { ok: true, conflict: false, output: '' }),
    readRef: vi.fn(async () => null),
    revParse: vi.fn(async () => 'main-commit-sha'),
    diffNameStatus: vi.fn(async () => [] as any[]),
    showFileAtRef: vi.fn(async () => ''),
    updateRef: rec('updateRef'),
    // The mirror diverged: the ff is REFUSED. runPush escalates this as
    // divergentDocmost; the question is whether runCycle surfaces it.
    fastForwardBranch: rec('fastForwardBranch', {
      ok: false,
      reason: 'not-fast-forward',
    }),
    ...overrides,
  };
  return vault;
}

function baseDeps(vault: any, over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  return {
    spaceId: 'space-1',
    client: {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      getPageJson: vi.fn(),
      importPageMarkdown: vi.fn(),
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
      listRecentSince: vi.fn(),
      listTrash: vi.fn(),
      restorePage: vi.fn(),
    } as any,
    vault,
    settings: { vaultPath: '/vault' } as any,
    fs: {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    },
    log: vi.fn(),
    ...over,
  };
}

describe('#15 divergence dropped by runCycle', () => {
  it('surfaces the divergent `docmost` mirror in RunCycleResult', async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);

    // The push DID refuse to fast-forward the divergent mirror.
    expect(vault.order).toContain(
      'fastForwardBranch:docmost,main-commit-sha',
    );

    // DESIRED: the cycle result surfaces the divergence (some warning/flag), so a
    // caller driving runCycle can see the §5 invariant breach without scraping
    // logs. Today RunCycleResult.push is only {mode, failures}.
    const divergence =
      (res as any).divergentDocmost ??
      (res.push as any)?.divergentDocmost ??
      (res as any).warning;
    expect(divergence).toBeTruthy();
  });
});
