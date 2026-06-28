import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
} from '../src/engine/git';
import { applyPullActions, type PullActions } from '../src/engine/pull';

/**
 * QA #119 round-2 — the docmost -> main merge must NEVER commit raw conflict
 * markers onto the published `main` (external clones would see them and the body
 * re-conflicts every cycle while git and the DB silently diverge). These run
 * against a REAL temp git repo:
 *
 *   1. SPURIOUS conflict (the root cause): two sides that differ ONLY in
 *      trailing/empty lines (normalize-on-write vs a user's blank-line append)
 *      must NOT conflict — they auto-normalize, no markers, and stay in sync over
 *      repeated cycles.
 *   2. GENUINE same-block conflict: still must not leak raw markers into `main`
 *      (auto-resolved to the git/main side; the docmost side stays recoverable on
 *      the `docmost` branch).
 *
 * Skips gracefully if git is unavailable.
 */

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** PullActions with everything empty except the given overrides. */
function actions(partial: Partial<PullActions> = {}): PullActions {
  return {
    toWrite: [],
    moved: [],
    toDelete: [],
    deletionDecision: { apply: true },
    existingCount: 0,
    plannedDeleteCount: 0,
    ...partial,
  };
}

/** Real-fs/real-git deps for applyPullActions (no client calls when toWrite empty). */
function realDeps(git: VaultGit) {
  return {
    client: {
      getPageJson: async () => {
        throw new Error('getPageJson should not be called in these tests');
      },
    },
    git,
    writeFile: async (abs: string, text: string) => {
      await writeFile(abs, text, 'utf8');
    },
    mkdir: async (abs: string) => {
      await mkdir(abs, { recursive: true });
    },
    rm: async (abs: string) => {
      await rm(abs, { force: true });
    },
    log: () => {},
  };
}

const PAGE = (body: string) => `---\ngitmost_id: p1\n---\n\n${body}`;

describe('pull merge — spurious vs genuine conflict (real git)', () => {
  let available = false;
  let dir: string;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function commitOn(git: VaultGit, subject: string): Promise<void> {
    await git.stageAll();
    await git.commit(subject, {
      authorName: BOT_AUTHOR_NAME,
      authorEmail: BOT_AUTHOR_EMAIL,
    });
  }

  /**
   * Build a repo where `main` and `docmost` have DIVERGED from a shared base on
   * the SAME file, so `applyPullActions`'s docmost -> main merge does a real
   * 3-way merge. `ours`/`theirs`/`base` are the file BODIES for main/docmost/base.
   */
  async function divergedRepo(opts: {
    base: string;
    ours: string;
    theirs: string;
  }): Promise<{ vault: string; git: VaultGit; file: string }> {
    dir = await mkdtemp(join(tmpdir(), 'docmost-conflict-'));
    const git = new VaultGit(dir);
    await git.ensureRepo();
    await git.ensureBranch('docmost', 'main');
    const file = 'Doc.md';

    // base commit on main, then re-fork docmost from it (merge-base = base).
    await writeFile(join(dir, file), PAGE(opts.base), 'utf8');
    await commitOn(git, 'base');
    await execFileAsync('git', ['branch', '-f', 'docmost', 'main'], { cwd: dir });

    // docmost side.
    await git.checkout('docmost');
    await writeFile(join(dir, file), PAGE(opts.theirs), 'utf8');
    await commitOn(git, 'docmost: change');

    // main side (diverges from base too -> a real 3-way merge, not a ff).
    await git.checkout('main');
    await writeFile(join(dir, file), PAGE(opts.ours), 'utf8');
    await commitOn(git, 'local: change');

    // The cycle calls applyPullActions while on `docmost`.
    await git.checkout('docmost');
    return { vault: dir, git, file };
  }

  it('SPURIOUS: a trailing-blank-only diff does NOT conflict, no markers, stays in sync', async () => {
    if (!available) return;
    // base ends "World\n\n", main appends another blank, docmost normalizes to one.
    const { vault, git, file } = await divergedRepo({
      base: 'World\n\n',
      ours: 'World\n\n\n',
      theirs: 'World\n',
    });

    const res = await applyPullActions(realDeps(git), actions(), vault);

    // No GENUINE conflict reported.
    expect(res.merge.conflict).toBe(false);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual([]);
    // The vault is not wedged mid-merge.
    expect(await git.isMergeInProgress()).toBe(false);

    // `main` carries the clean normalized body — NO conflict markers.
    const onMain = await readFile(join(vault, file), 'utf8');
    expect(onMain).not.toContain('<<<<<<<');
    expect(onMain).not.toContain('=======');
    expect(onMain).not.toContain('>>>>>>>');
    expect(onMain).toContain('World');

    // A SECOND identical pull cycle is a clean no-op (git and content stay in
    // sync — no re-conflict, no churn). docmost is now an ancestor of main.
    await git.checkout('docmost');
    const res2 = await applyPullActions(realDeps(git), actions(), vault);
    expect(res2.merge.conflict).toBe(false);
    expect(res2.conflictedPaths).toEqual([]);
    const onMain2 = await readFile(join(vault, file), 'utf8');
    expect(onMain2).not.toContain('<<<<<<<');
  });

  it('GENUINE: a same-block content conflict does NOT leak raw markers into main', async () => {
    if (!available) return;
    const { vault, git, file } = await divergedRepo({
      base: 'Original line\n',
      ours: 'Edited by GIT\n',
      theirs: 'Edited by DOCMOST\n',
    });

    const res = await applyPullActions(realDeps(git), actions(), vault);

    // A genuine conflict is detected + auto-resolved (git wins) — reported, clean.
    expect(res.merge.conflict).toBe(true);
    expect(res.merge.ok).toBe(true);
    expect(res.conflictedPaths).toEqual([file]);
    expect(await git.isMergeInProgress()).toBe(false);

    const onMain = await readFile(join(vault, file), 'utf8');
    // CARDINAL invariant: no raw conflict markers ever on the published main.
    expect(onMain).not.toContain('<<<<<<<');
    expect(onMain).not.toContain('=======');
    expect(onMain).not.toContain('>>>>>>>');
    // Git/main side won the published branch.
    expect(onMain).toContain('Edited by GIT');
    expect(onMain).not.toContain('Edited by DOCMOST');

    // The docmost side stays recoverable on the `docmost` branch.
    const onDocmost = await git.showFileAtRef('docmost', file);
    expect(onDocmost).toContain('Edited by DOCMOST');
  });
});
