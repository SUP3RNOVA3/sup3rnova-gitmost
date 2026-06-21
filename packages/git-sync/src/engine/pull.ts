/**
 * Pull cycle — Docmost -> vault (SPEC §6 "Docmost -> ФС").
 *
 * This increment turns the read-only mirror into the git-backed pull cycle:
 *
 *   1. ensureRepo(vault); refuse if a merge is in progress (SPEC §9/§12);
 *      ensureBranch("docmost", "main")   (SPEC §5 branches)
 *   2. checkout docmost
 *   3. fetch the live tree (listSpaceTree -> {pages, complete}) -> compute the
 *      desired `live` files (relPath via the pure sanitize/disambiguation layout)
 *   4. parse `existing` tracked .md files (pageId + relPath from docmost:meta)
 *   5. plan = planReconciliation(live, existing)   (pure, SPEC §5/§8); toDelete
 *      is absence-only, moves are separate
 *   6. decideAbsenceDeletions: SUPPRESS absence deletions on an incomplete tree
 *      fetch (SPEC §8) and behind the mass-delete guard (defense in depth)
 *   7. write each live page in its fixpoint form (normalize-on-write, SPEC §11);
 *      apply moved-old-path removals (only when the move write SUCCEEDED) and
 *      absence-delete removals (only when the decision allowed them)
 *   8. stageAll + commit on `docmost` with the provenance trailer (SPEC §7.3)
 *   9. checkout main + merge docmost (conflicts are surfaced, NOT auto-resolved,
 *      SPEC §9); push is deferred (SPEC §7)
 *  10. one-line summary
 *
 * DIRECTION IS Docmost -> vault ONLY. Nothing here ever writes to Docmost
 * (read-only: listSpaceTree + getPageJson). All git operations run against
 * the vault repo (`cwd = vaultPath`), never the source repo (see ./git.ts).
 *
 * VENDORED into gitmost (plan §2.1/§3.1): the client seam is the native
 * `GitSyncClient` (`Pick<GitSyncClient, ...>`), not the upstream REST
 * `DocmostClient`; the upstream CLI `main()` entry point is dropped (the gitmost
 * server drives the engine in-process). Engine LOGIC is byte-identical.
 */
import { dirname } from "node:path";
import { sep } from "node:path";
import { parseDocmostMarkdown } from "../lib/index";
import type { GitSyncClient } from "./client.types";
import { buildVaultLayout, type PageNode } from "./layout";
import {
  VaultGit,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "./git";
import {
  planReconciliation,
  decideAbsenceDeletions,
  type LiveEntry,
  type MovedEntry,
  type DeletionDecision,
} from "./reconcile";
import { stabilizePageFile, type PageMeta } from "./stabilize";

// Engine-only mirror branch (SPEC §5): the engine writes here, humans never do.
const DOCMOST_BRANCH = "docmost";
// Machine-readable provenance the loop-guard keys on (SPEC §7.3 / §12).
const SOURCE_TRAILER = "Docmost-Sync-Source: docmost";

// Number of pages fetched/stabilized concurrently. Bounded so a large space
// does not open thousands of simultaneous requests/conversions at once.
const CONCURRENCY = 6;
// How often to log incremental progress (every N completed pages).
const PROGRESS_EVERY = 25;

/** Convert a vault-relative path (forward-slash) to an absolute FS path. */
function relToAbs(vaultRoot: string, relPath: string): string {
  return [vaultRoot, ...relPath.split("/")].join("/");
}

/** Convert an absolute/relative segment list under the vault to a relPath. */
function segmentsToRelPath(segments: string[], stem: string): string {
  return [...segments, `${stem}.md`].join("/");
}

/**
 * Injectable IO for `readExisting` (R-Pull-1, test-strategy report §5). The real
 * `main` wires these to `git.listTrackedFiles("*.md")` and an `fs.readFile`
 * rooted at the vault; tests pass fakes so the parsing/skip rules are unit-
 * testable without a real git repo or filesystem.
 */
export interface ReadExistingDeps {
  /** List tracked .md paths (forward-slash, vault-relative). */
  listTracked: () => Promise<string[]>;
  /** Read a tracked file's text by its (forward-slash) vault-relative path. */
  readFile: (relPath: string) => Promise<string>;
}

/**
 * Read every tracked .md file in the vault and parse its `docmost:meta` to
 * recover `{ pageId, relPath }`. Files without a parseable pageId in meta are
 * skipped (they are not engine-tracked pages — e.g. a stray hand-written file).
 *
 * The IO is injected (R-Pull-1) so this is testable with fakes. Skip rules:
 *   - a `readFile` rejection (tracked but missing on disk, a mid-operation race)
 *     -> skipped, NOT thrown; the next pull converges;
 *   - unparseable meta (`parseDocmostMarkdown` throws) -> skipped;
 *   - parseable but no `pageId` in meta -> skipped.
 */
export async function readExisting(
  deps: ReadExistingDeps,
): Promise<{ pageId: string; relPath: string }[]> {
  const tracked = await deps.listTracked();
  const existing: { pageId: string; relPath: string }[] = [];
  for (const relPath of tracked) {
    // git ls-files always emits forward-slash paths; normalize just in case.
    const rel = relPath.split(sep).join("/");
    let text: string;
    try {
      text = await deps.readFile(rel);
    } catch {
      // Tracked but missing on disk (mid-operation race) — skip; the next pull
      // converges.
      continue;
    }
    let pageId: string | undefined;
    try {
      const { meta } = parseDocmostMarkdown(text);
      pageId = meta?.pageId;
    } catch {
      // Unparseable meta — not engine-tracked; leave it alone.
      pageId = undefined;
    }
    if (pageId) existing.push({ pageId, relPath: rel });
  }
  return existing;
}

/**
 * Input to the PURE `computePullActions` (R-Pull-2). All data, no IO: the live
 * tree nodes + completeness flag (from `listSpaceTree`) and the parsed
 * `existing` tracked files (from `readExisting`).
 */
export interface PullActionsInput {
  /** Live page nodes for the space (from `listSpaceTree`). */
  pages: PageNode[];
  /** Whether the live tree fetch was COMPLETE (SPEC §8 suppression). */
  treeComplete: boolean;
  /** Parsed tracked files: `{ pageId, relPath }` (from `readExisting`). */
  existing: { pageId: string; relPath: string }[];
}

/**
 * The PURE decisions object computed by `computePullActions` (no IO). It holds
 * the reconciliation plan plus the SPEC §8 absence-deletion decision, with the
 * suppression already folded in: `toDelete` is the POST-suppression set the
 * caller should actually remove (empty when `deletionDecision.apply` is false).
 */
export interface PullActions {
  /** Pages to (re)write at their relPath (add + update + move target). */
  toWrite: { pageId: string; relPath: string }[];
  /** Moves: write new path, then remove old path (only on a successful write). */
  moved: MovedEntry[];
  /**
   * Absence-based paths to delete AFTER suppression. Empty when the decision
   * suppressed deletions this cycle, so the caller can apply it unconditionally.
   */
  toDelete: string[];
  /** Why absence deletions were (or were not) applied (for logging + tests). */
  deletionDecision: DeletionDecision;
  /** Tracked-file count (for the suppression log messages). */
  existingCount: number;
  /** Planned absence-delete count BEFORE suppression (for the log message). */
  plannedDeleteCount: number;
}

/**
 * PURE pull-action planner (R-Pull-2, test-strategy report §5). Takes the live
 * tree nodes + completeness + existing tracked files and returns the full set of
 * decisions with NO IO:
 *
 *   - builds the vault layout (deterministic relPath per live page),
 *   - `planReconciliation` -> toWrite / moved / absence-toDelete,
 *   - `decideAbsenceDeletions` -> the SPEC §8 suppression (incomplete-fetch +
 *     empty-live + mass-delete guard), folded IN here so `toDelete` is the
 *     POST-suppression set (empty when suppressed).
 *
 * Moves are NOT governed by the suppression: a moved page is present in `live`,
 * so its old-path removal is real (the caller still gates it on the write
 * succeeding). The expensive content fetch / file write / git ops happen in the
 * thin `applyPullActions`.
 */
export function computePullActions(input: PullActionsInput): PullActions {
  const { pages, treeComplete, existing } = input;
  const layout = buildVaultLayout(pages);

  const live: LiveEntry[] = [];
  for (const p of pages) {
    if (!p || !p.id) continue;
    const entry = layout.get(p.id);
    if (!entry) continue;
    live.push({
      pageId: p.id,
      relPath: segmentsToRelPath(entry.segments, entry.stem),
    });
  }

  // Plan reconciliation (pure). `plan.toDelete` is ABSENCE-based only;
  // `plan.moved` carries move old-path removals separately.
  const plan = planReconciliation(live, existing);

  // Decide whether the ABSENCE-based deletions may be applied this cycle
  // (SPEC §8): incomplete-fetch suppression + empty-live + mass-delete guard.
  // Moves are NOT governed by this.
  const deletionDecision = decideAbsenceDeletions({
    treeComplete,
    liveCount: live.length,
    existingCount: existing.length,
    deleteCount: plan.toDelete.length,
  });

  return {
    toWrite: plan.toWrite,
    moved: plan.moved,
    // Fold the suppression in: a suppressed cycle deletes nothing.
    toDelete: deletionDecision.apply ? plan.toDelete : [],
    deletionDecision,
    existingCount: existing.length,
    plannedDeleteCount: plan.toDelete.length,
  };
}

/**
 * Injectable IO for `applyPullActions` (R-Pull-2). The real `main` wires these
 * to the live client, the vault git wrapper, and `node:fs/promises`; tests pass
 * fakes that RECORD calls so the ordering + the move-on-success data-loss guard
 * are testable without real git/fs/network.
 */
export interface ApplyPullActionsDeps {
  client: Pick<GitSyncClient, "getPageJson">;
  git: Pick<VaultGit, "stageAll" | "commit" | "checkout" | "merge">;
  /** Write a file by ABSOLUTE path (mkdir of the parent is done internally). */
  writeFile: (absPath: string, text: string) => Promise<void>;
  /** Recursive mkdir of an ABSOLUTE directory path. */
  mkdir: (absDir: string) => Promise<void>;
  /** Remove a file by ABSOLUTE path (force: a missing file is a no-op). */
  rm: (absPath: string) => Promise<void>;
}

/** Outcome counters from `applyPullActions` (for the summary + tests). */
export interface ApplyResult {
  written: number;
  movedApplied: number;
  deleted: number;
  failed: number;
  committed: boolean;
  merge: { ok: boolean; conflict: boolean; output: string };
}

/**
 * THIN IO applier (R-Pull-2). Performs the side effects in the EXACT current
 * order, with all the original safety guards preserved bit-for-bit:
 *
 *   1. for each `toWrite`: fetch content (`client.getPageJson`) -> stabilize
 *      (normalize-on-write fixpoint, SPEC §11) -> mkdir + write. One bad page
 *      never aborts the pull (bounded-concurrency pool, fault-tolerant).
 *   2. apply MOVE old-path removals — ONLY when the planner marked the old path
 *      removable AND the new-path write SUCCEEDED (the ⭐ data-loss guard: a
 *      failed move-write keeps the old path so the page never vanishes).
 *   3. apply (post-suppression) absence deletes.
 *   4. stageAll + commit on `docmost` (subject from ACTUAL written/deleted
 *      counts) + checkout main + merge docmost (conflicts surfaced, SPEC §9).
 *
 * `vaultRoot` roots the relPath -> absolute-path conversion for the fs deps.
 */
export async function applyPullActions(
  deps: ApplyPullActionsDeps,
  actions: PullActions,
  vaultRoot: string,
): Promise<ApplyResult> {
  const { client, git } = deps;

  // Emit the SPEC §8 suppression warnings (preserved from the original `main`).
  const decision = actions.deletionDecision;
  if (!decision.apply) {
    if (decision.reason === "incomplete-fetch") {
      console.warn(
        "pull: tree fetch incomplete — deletions suppressed this cycle (SPEC §8)",
      );
    } else if (decision.reason === "empty-live") {
      console.warn(
        `pull: live fetch returned 0 pages but ${actions.existingCount} file(s) are ` +
          `tracked — deletions suppressed this cycle (SPEC §8). Re-run when ` +
          `Docmost is reachable.`,
      );
    } else {
      console.warn(
        `pull: plan would delete ${actions.plannedDeleteCount} of ${actions.existingCount} ` +
          `tracked file(s) (mass-delete guard) — deletions suppressed this ` +
          `cycle (SPEC §8). Verify the live Docmost tree, then re-run.`,
      );
    }
  }

  // 1. Write each live page in its fixpoint form (normalize-on-write, SPEC §11).
  let written = 0;
  let failed = 0;
  let completed = 0;
  let nextIndex = 0;
  // pageIds whose write FAILED. A moved page whose new-path write failed must
  // NOT have its old path removed (otherwise the page vanishes entirely).
  const failedPageIds = new Set<string>();

  const writeOne = async (w: {
    pageId: string;
    relPath: string;
  }): Promise<void> => {
    try {
      const page = await client.getPageJson(w.pageId);
      const meta: PageMeta = {
        version: 1,
        pageId: page.id,
        slugId: page.slugId,
        title: page.title,
        spaceId: page.spaceId,
        parentPageId: page.parentPageId ?? null,
      };
      const text = await stabilizePageFile(page.content, meta);
      const abs = relToAbs(vaultRoot, w.relPath);
      await deps.mkdir(dirname(abs));
      await deps.writeFile(abs, text);
      written++;
    } catch (err) {
      failed++;
      failedPageIds.add(w.pageId);
      console.error(
        `pull: failed page ${w.pageId}:`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      completed++;
      if (completed % PROGRESS_EVERY === 0) {
        console.log(`pulled ${completed}/${actions.toWrite.length}`);
      }
    }
  };

  // Bounded-concurrency pool (dependency-free): a fixed set of runners each
  // take the next index until the write list is exhausted. One bad page never
  // aborts the whole pull (mirrors the fault-tolerant tree walk).
  const runner = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= actions.toWrite.length) return;
      await writeOne(actions.toWrite[i]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, actions.toWrite.length) || 1 },
      () => runner(),
    ),
  );

  // Helper: `rm` with force:true is a no-op if the file is already gone.
  const removePath = async (rel: string, what: string): Promise<boolean> => {
    try {
      await deps.rm(relToAbs(vaultRoot, rel));
      return true;
    } catch (err) {
      console.error(
        `pull: failed to ${what} ${rel}:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  // 2. Apply MOVE old-path removals. A moved page IS present in `live`, so its
  //    old path is genuinely stale — NOT subject to the incomplete-fetch
  //    suppression. BUT only remove the old path when (a) the planner marked it
  //    removable (not reused by another live page) AND (b) the new-path write
  //    actually SUCCEEDED — otherwise we would delete the only copy of a page
  //    whose move-write failed (⭐ data-loss guard).
  let movedApplied = 0;
  for (const m of actions.moved) {
    if (!m.removeOldPath) continue;
    if (failedPageIds.has(m.pageId)) {
      console.warn(
        `pull: move write for ${m.pageId} failed — keeping old path ` +
          `${m.fromRelPath} (SPEC §8)`,
      );
      continue;
    }
    if (await removePath(m.fromRelPath, "remove moved old path")) movedApplied++;
  }

  // 3. Apply ABSENCE-based deletions — `actions.toDelete` is ALREADY the
  //    post-suppression set (empty when the decision suppressed them, SPEC §8).
  let deleted = 0;
  for (const rel of actions.toDelete) {
    if (await removePath(rel, "delete")) deleted++;
  }

  // 4. Stage + commit on `docmost` (only if there is something to commit).
  //    Deterministic stabilized output means unchanged pages produce identical
  //    bytes -> git sees no diff -> no churn (SPEC §11). The subject reflects the
  //    ACTUAL work applied (pages written + files deleted), not the planned size,
  //    so a run with failures does not over-report (SPEC §5 nit).
  const subject =
    deleted > 0
      ? `docmost: sync ${written} page(s), ${deleted} deleted`
      : `docmost: sync ${written} page(s)`;
  await git.stageAll();
  const committed = await git.commit(subject, {
    authorName: BOT_AUTHOR_NAME,
    authorEmail: BOT_AUTHOR_EMAIL,
    trailers: [SOURCE_TRAILER],
  });

  // Merge docmost -> main. Conflicts are surfaced and left in git (SPEC §9);
  // we never push to Docmost. Push to a git remote is deferred (SPEC §7).
  await git.checkout(DEFAULT_BRANCH);
  const merge = await git.merge(DOCMOST_BRANCH);
  if (merge.conflict) {
    console.error(
      "pull: merge of docmost -> main CONFLICTED. Conflict markers were left " +
        "in the vault for manual resolution (SPEC §9). Nothing is pushed to " +
        "Docmost (read-only). Resolve locally, then re-run.",
    );
  } else if (!merge.ok) {
    console.error(`pull: merge of docmost -> main failed: ${merge.output}`);
  }
  console.log("pull: git push to remote is DEFERRED in this increment (SPEC §7).");

  return { written, movedApplied, deleted, failed, committed, merge };
}
