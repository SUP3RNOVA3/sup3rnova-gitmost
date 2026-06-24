/**
 * The vault SIDECAR index — `.gitmost/index.json`. It holds the ONLY service
 * metadata that is not derivable from the vault itself: a page's stable identity
 * (`pageId`) and its collision-disambiguation token (`slugId`), keyed by the
 * file's vault-relative (forward-slash) path. Everything else is derived:
 *   - title       -> the file/folder name (stem),
 *   - parentPageId-> the enclosing folder's `index.md` (path-as-truth),
 *   - spaceId     -> the vault is the space,
 *   - updatedAt   -> git history.
 *
 * Keeping identity here (not in a `docmost:meta` block inside every file) lets
 * the `.md` files stay CLEAN markdown that any third-party editor (Obsidian, …)
 * reads and writes directly. This module is PURE (parse/serialize/lookup); all
 * file IO is the caller's (injected), matching the rest of the engine.
 */

/** Where the sidecar lives inside a space vault (vault-relative, forward-slash). */
export const VAULT_INDEX_PATH = ".gitmost/index.json";

/** Per-file identity record. `slugId` is optional (a freshly adopted file has
 *  none until Docmost assigns one on create). */
export interface VaultIndexEntry {
  pageId: string;
  slugId?: string;
}

export interface VaultIndex {
  version: number;
  /** The space this vault mirrors (one repo per space). Informational. */
  spaceId?: string;
  /** file path (forward-slash, vault-relative) -> identity. */
  pages: Map<string, VaultIndexEntry>;
}

const CURRENT_VERSION = 1;

export function emptyVaultIndex(spaceId?: string): VaultIndex {
  return { version: CURRENT_VERSION, spaceId, pages: new Map() };
}

/**
 * Parse `.gitmost/index.json`. TOLERANT by construction — a missing file
 * (`null`), invalid JSON, or a malformed entry must never crash a sync cycle, so
 * those degrade to an empty index / skipped entries (the engine then treats the
 * affected files as un-tracked and re-derives identity, rather than losing data).
 */
export function parseVaultIndex(text: string | null | undefined): VaultIndex {
  if (text == null || text.trim() === "") return emptyVaultIndex();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyVaultIndex();
  }
  if (typeof raw !== "object" || raw === null) return emptyVaultIndex();
  const obj = raw as Record<string, unknown>;
  const index = emptyVaultIndex(
    typeof obj.spaceId === "string" ? obj.spaceId : undefined,
  );
  if (typeof obj.version === "number") index.version = obj.version;
  const pages = obj.pages;
  if (typeof pages === "object" && pages !== null) {
    for (const [path, value] of Object.entries(pages as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.pageId !== "string" || entry.pageId === "") continue;
      index.pages.set(path, {
        pageId: entry.pageId,
        ...(typeof entry.slugId === "string" ? { slugId: entry.slugId } : {}),
      });
    }
  }
  return index;
}

/**
 * Serialize to STABLE JSON: object keys sorted so the file produces minimal,
 * deterministic git diffs (a re-sync that changes nothing yields byte-identical
 * output — no churn, which the loop-guard relies on). Trailing newline.
 */
export function serializeVaultIndex(index: VaultIndex): string {
  const pages: Record<string, VaultIndexEntry> = {};
  for (const path of [...index.pages.keys()].sort()) {
    const e = index.pages.get(path)!;
    pages[path] = e.slugId
      ? { pageId: e.pageId, slugId: e.slugId }
      : { pageId: e.pageId };
  }
  const out: Record<string, unknown> = { version: index.version };
  if (index.spaceId) out.spaceId = index.spaceId;
  out.pages = pages;
  return JSON.stringify(out, null, 2) + "\n";
}

// --- lookups (pure) --------------------------------------------------------

/** The pageId tracked at `path`, or undefined. */
export function pageIdAt(index: VaultIndex, path: string): string | undefined {
  return index.pages.get(path)?.pageId;
}

/** The slugId tracked at `path`, or undefined. */
export function slugIdAt(index: VaultIndex, path: string): string | undefined {
  return index.pages.get(path)?.slugId;
}

/**
 * Reverse lookup: the CURRENT path of a pageId, or undefined. Used by push to
 * decide identity — a vanished file whose pageId still resolves to a (different)
 * tracked path is a MOVE, not a delete.
 */
export function pathForPageId(
  index: VaultIndex,
  pageId: string,
): string | undefined {
  for (const [path, entry] of index.pages) {
    if (entry.pageId === pageId) return path;
  }
  return undefined;
}

/** The set of all pageIds currently tracked in the index. */
export function trackedPageIds(index: VaultIndex): Set<string> {
  const ids = new Set<string>();
  for (const entry of index.pages.values()) ids.add(entry.pageId);
  return ids;
}

// --- mutations (in place; the index is a builder during a cycle) -----------

export function setEntry(
  index: VaultIndex,
  path: string,
  entry: VaultIndexEntry,
): void {
  index.pages.set(path, entry);
}

export function removeAt(index: VaultIndex, path: string): void {
  index.pages.delete(path);
}

/** Move a tracked entry from one path to another (a rename/reparent), keeping
 *  its identity. No-op if `fromPath` is not tracked. */
export function moveEntry(
  index: VaultIndex,
  fromPath: string,
  toPath: string,
): void {
  const entry = index.pages.get(fromPath);
  if (!entry) return;
  index.pages.delete(fromPath);
  index.pages.set(toPath, entry);
}
