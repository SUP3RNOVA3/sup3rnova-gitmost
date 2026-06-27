import { VaultGit } from "./git.js";
import { GitSyncClient } from "./client.types.js";
import { Settings } from "./settings.js";
import { readExisting, computePullActions, applyPullActions } from "./pull.js";
import { runPush } from "./push.js";

/**
 * Absolute-path filesystem primitives the cycle needs. Injected (not imported)
 * so the engine stays IO-free and unit-testable. `mkdir` is recursive; `rm` is
 * force (a missing file is a no-op).
 */
export interface CycleFs {
  readFile: (absPath: string) => Promise<string>;
  writeFile: (absPath: string, text: string) => Promise<void>;
  mkdir: (absDir: string) => Promise<void>;
  rm: (absPath: string) => Promise<void>;
}

export interface RunCycleDeps {
  spaceId: string;
  /** The Docmost seam (reads for pull, writes for push). */
  client: GitSyncClient;
  /** The per-space git vault (a real working repo). */
  vault: VaultGit;
  /** Engine settings; `vaultPath` roots the relPath -> absolute-path mapping. */
  settings: Settings;
  fs: CycleFs;
  log: (line: string) => void;
  /**
   * Optional cooperative-abort signal. The caller (orchestrator) wires this to
   * the per-space lock: if a heartbeat refresh cannot CONFIRM the lock is still
   * held (CAS-miss / Redis error), the signal is aborted and the cycle bails at
   * its next checkpoint (before the pull-apply and before the push-apply — the
   * two destructive write phases) instead of writing blind after a possible
   * lock loss. This is a COARSE best-effort guard; a fully fenced cross-process
   * single-writer still needs the fencing-token redesign (follow-up).
   */
  signal?: AbortSignal;
}

export interface RunCycleResult {
  ran: boolean;
  /** Set when the cycle short-circuited without running pull/push. */
  skipped?: "merge-in-progress";
  pull?: { written: number; deleted: number; conflict: boolean };
  push?: { mode: string; failures: number };
  /**
   * Forwarded from the push result: `true` when the push REFUSED to fast-forward
   * a divergent `docmost` mirror (the §5 invariant — `docmost` mirrors what
   * Docmost contains — is broken). Surfaced here so a caller driving `runCycle`
   * can detect the breach without scraping logs (red-team #15).
   */
  divergentDocmost?: boolean;
}

/**
 * Run ONE full reconcile cycle for a space: PULL (Docmost -> vault) then PUSH
 * (vault -> Docmost), under the engine's required branch choreography. This is
 * the single entry point the app drives — it owns the staging order so it can
 * never drift from the engine it ships with.
 *
 * Staging (the ⭐ data-loss-critical order, SPEC §6/§9):
 *   1. assertGitAvailable + ensureRepo (the git state store must exist).
 *   2. refuse on an unresolved merge (a prior conflicting pull); next checkout
 *      would fail otherwise.
 *   3. ensureBranch('docmost','main') + checkout('docmost'). Pull writes MUST
 *      land on `docmost`, not `main`: applyPullActions commits on `docmost`,
 *      then checks out `main` and merges docmost -> main. Writing Docmost
 *      content straight onto `main` would clobber local file edits before push
 *      can diff them.
 *   4. PULL: readExisting -> listSpaceTree -> computePullActions -> apply.
 *   5. PUSH: vault -> Docmost apply.
 *
 * Lock POLICY lives in the caller; this owns only the mechanics. Deletes are
 * soft (Trash, reversible) and always logged, so there is no per-cycle
 * delete-cap — engine convergence is the guard against phantom deletions.
 */
export async function runCycle(deps: RunCycleDeps): Promise<RunCycleResult> {
  const { spaceId, client, vault, settings, fs, log, signal } = deps;
  const vaultRoot = settings.vaultPath;
  const abs = (relPath: string) => `${vaultRoot}/${relPath}`;

  // 1. The engine state store is git: make sure the repo + branches exist
  //    before any tracked-file listing or diff.
  await vault.assertGitAvailable();
  await vault.ensureRepo();

  // 2. RECOVER from a vault left mid-merge by a PRIOR cycle (SPEC §9 wedge fix).
  //    A leftover merge used to WEDGE THE WHOLE SPACE: this check returned
  //    `skipped: "merge-in-progress"` so EVERY later cycle skipped the entire
  //    space (all pages, both directions) forever, with no recovery. The pull
  //    phase below no longer leaves the vault mid-merge (it commits a conflicting
  //    merge with markers and isolates the one bad page), but a vault wedged by a
  //    PRE-FIX build (or a manual/interrupted git op) must still self-heal.
  //    So instead of skipping, ABORT the stale half-merge and continue — the
  //    fresh pull re-runs and, on a real conflict, commits-with-markers rather
  //    than re-wedging. A stray unmerged index that `merge --abort` can't clear
  //    (no MERGE_HEAD) is force-cleared with a hard reset to HEAD.
  if (await vault.isMergeInProgress()) {
    log(
      `vault was left mid-merge by a prior cycle — aborting the stale merge and ` +
        `continuing so the space is not wedged (SPEC §9 recovery).`,
    );
    await vault.abortMerge();
    if (await vault.isMergeInProgress()) {
      log(
        `vault still mid-merge after 'merge --abort' — hard-resetting to HEAD ` +
          `to recover (SPEC §9).`,
      );
      await vault.resetHardToHead();
    }
  }

  // 3. Pull writes happen on `docmost`; be on it BEFORE applying (see docstring).
  await vault.ensureBranch("docmost", "main");
  await vault.checkout("docmost");

  // 4. PULL --------------------------------------------------------------------
  const existing = await readExisting({
    listTracked: () => vault.listTrackedFiles("*.md"),
    readFile: (relPath) => fs.readFile(abs(relPath)),
  });

  const tree = await client.listSpaceTree(spaceId);
  const pullActions = computePullActions({
    pages: tree.pages,
    treeComplete: tree.complete,
    existing,
  });

  // Bail before the first destructive write phase if the lock was lost.
  signal?.throwIfAborted();

  const pullResult = await applyPullActions(
    {
      client,
      git: vault,
      writeFile: (absPath, text) => fs.writeFile(absPath, text),
      mkdir: (absDir) => fs.mkdir(absDir),
      rm: (absPath) => fs.rm(absPath),
      log,
    },
    pullActions,
    vaultRoot,
  );

  // 5. PUSH --------------------------------------------------------------------
  const pushDeps = {
    settings,
    git: vault,
    makeClient: () => client,
    readFile: (relPath: string) => fs.readFile(abs(relPath)),
    writeFile: (relPath: string, text: string) => fs.writeFile(abs(relPath), text),
    log,
  };

  // Bail before pushing to Docmost if the lock was lost during pull.
  signal?.throwIfAborted();

  const pushResult = await runPush(pushDeps, { dryRun: false });

  return {
    ran: true,
    pull: {
      written: pullResult.written,
      deleted: pullResult.deleted,
      conflict: pullResult.merge.conflict,
    },
    push: {
      mode: pushResult.mode,
      failures: pushResult.failures?.length ?? 0,
    },
    // Forward a divergent-`docmost` escalation so the caller can act on the §5
    // invariant breach without scraping logs (red-team #15).
    divergentDocmost: pushResult.divergentDocmost ?? false,
  };
}
