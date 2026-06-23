/**
 * Public surface of `@docmost/git-sync`.
 *
 * Phase A vendors only the PURE converter + pure engine modules
 * from docmost-sync. Server integration (GitmostDataSource, orchestrator,
 * VaultGit, pull/push) is added in later steps.
 */

// Pure converter (markdown <-> ProseMirror, file envelope, canonicalization).
export {
  serializeDocmostMarkdown,
  serializeDocmostMarkdownBody,
  parseDocmostMarkdown,
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  canonicalizeContent,
  docsCanonicallyEqual,
} from "./lib/index";
export type { DocmostMdMeta } from "./lib/index";

// Pure engine (no IO): reconcile planner, vault layout, sanitize, stabilize,
// loop-guard body hash.
export {
  planReconciliation,
  decideAbsenceDeletions,
  MASS_DELETE_MIN_EXISTING,
  MASS_DELETE_FRACTION,
} from "./engine/reconcile";
export type {
  LiveEntry,
  ExistingEntry,
  WriteEntry,
  MovedEntry,
  ReconciliationPlan,
  DeletionDecision,
} from "./engine/reconcile";

export { buildVaultLayout } from "./engine/layout";
export type { PageNode, VaultEntry } from "./engine/layout";

export { sanitizeTitle, disambiguate } from "./engine/sanitize";

export { stabilizePageFile } from "./engine/stabilize";
export type { PageMeta } from "./engine/stabilize";

export { bodyHash } from "./engine/loop-guard";

// IO engine: the client seam, the VaultGit git wrapper, the
// pull (Docmost->FS) + push (FS->Docmost) planners/appliers, and the (pure)
// settings parser. The engine consumes the native `GitSyncClient` seam (server
// implements it) — the upstream REST `DocmostClient` is NOT vendored.
export type { GitSyncClient, GitSyncPageNodeLite } from "./engine/client.types";

export {
  VaultGit,
  vaultGitEnv,
  buildCommitMessage,
  BOT_AUTHOR_NAME,
  BOT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "./engine/git";
export type { DiffEntry, MergeResult, CommitOptions } from "./engine/git";

export {
  readExisting,
  computePullActions,
  applyPullActions,
} from "./engine/pull";
export type {
  ReadExistingDeps,
  PullActionsInput,
  PullActions,
  ApplyPullActionsDeps,
  ApplyResult,
} from "./engine/pull";

export {
  classifyRenameMoves,
  computePushActions,
  applyPushActions,
  runPush,
  parentFolderFile,
  parseArgs,
  LAST_PUSHED_REF,
  DOCMOST_BRANCH,
  LOCAL_AUTHOR_NAME,
  LOCAL_AUTHOR_EMAIL,
  LOCAL_SOURCE_TRAILER,
} from "./engine/push";
export type {
  CreateAction,
  UpdateAction,
  DeleteAction,
  RenameMoveAction,
  RenameMoveActionClassified,
  ClassifyRenameMovesDeps,
  PushActions,
  PushActionsInput,
  MetaSide,
  ApplyPushDeps,
  WrittenBackPage,
  PushedPageRecord,
  PushFailure,
  PushNoop,
  ApplyPushResult,
  PushDeps,
  PushRunResult,
  PushParsedArgs,
} from "./engine/push";

export { parseSettings, envSchema } from "./engine/settings";
export type { Settings } from "./engine/settings";

export { loadSettingsOrExit } from "./engine/config-errors";
