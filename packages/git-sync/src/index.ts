/**
 * Public surface of `@docmost/git-sync`.
 *
 * Phase A (plan §12.A) vendors only the PURE converter + pure engine modules
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
