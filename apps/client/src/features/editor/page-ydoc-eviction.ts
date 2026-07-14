import { getDefaultStore } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import type { IndexeddbPersistence } from "y-indexeddb";
import { pageMetaCacheAtom } from "@/features/page/atoms/page-meta-cache-atom";
import { isLocalFirstEnabled } from "@/lib/config";

/**
 * Fail-closed destruction of a page's LOCAL ydoc when access is revoked
 * (#564, guard 3).
 *
 * With local-first on, the body is painted from the local ydoc BEFORE the
 * network answers. If the user has meanwhile lost access (or the page was
 * deleted), the page query answers 403/404 and the page renders not-found — but
 * the content would still be sitting in IndexedDB and would flash again on the
 * next visit. The collab path cannot help: an unauthorized room never syncs, so
 * it can never "correct" the local copy.
 *
 * So: on ANY page query failing with 403/404, destroy that page's local ydoc —
 * `IndexeddbPersistence.clearData()` when it is still mounted (destroys the
 * persistence and deletes the IDB database), otherwise a direct
 * `indexedDB.deleteDatabase()` of the same database name. Revoked content
 * survives neither on screen nor on disk.
 *
 * The MAIN scenario is a page never mounted in this session: a fresh tab /
 * reload / bookmark straight onto a page whose access was revoked. The editor
 * never mounts there (not-found renders instead), so BOTH halves of this module
 * are mount-independent:
 *  - the subscriber is installed at APP level (main.tsx), not from the editor;
 *  - the `slugId -> pageId` alias is resolved from the PERSISTED #563 page-meta
 *    boot cache (which stores every page under both aliases), not only from the
 *    session-scoped map a successful mount populates.
 */

/** The y-indexeddb database name the page editor uses for a page's body. */
export function pageYdocName(pageId: string): string {
  return `page.${pageId}`;
}

// Query keys are `["pages", <pageId | slugId>]`, while the ydoc is named by
// pageId. Aliases seen in THIS session (a mounted page), used ahead of the
// persisted boot cache: the boot cache is scope-gated (it is empty until `/me`
// resolves) and its writes are debounced, so this map is the immediate,
// always-correct source for pages this session actually opened.
// Bounded (#564 F9): an unbounded map would grow for every page visited in a
// long-lived session.
const MAX_SESSION_ALIASES = 500;
const ydocNameByQueryKey = new Map<string, string>();
// Live persistences, by ydoc name. Cleared on unmount.
const livePersistences = new Map<string, IndexeddbPersistence>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rememberAlias(key: string, documentName: string): void {
  // Re-insert to refresh insertion order (Map preserves it) so the oldest alias
  // is the eviction victim.
  ydocNameByQueryKey.delete(key);
  ydocNameByQueryKey.set(key, documentName);
  while (ydocNameByQueryKey.size > MAX_SESSION_ALIASES) {
    const oldest = ydocNameByQueryKey.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    ydocNameByQueryKey.delete(oldest);
  }
}

export function registerPageYdoc(opts: {
  documentName: string;
  persistence: IndexeddbPersistence;
  keys: (string | undefined | null)[];
}): void {
  livePersistences.set(opts.documentName, opts.persistence);
  for (const key of opts.keys) {
    if (key) rememberAlias(key, opts.documentName);
  }
}

/** Drop the live-persistence reference (the component is unmounting). */
export function unregisterPageYdoc(documentName: string): void {
  livePersistences.delete(documentName);
}

/** Test-only: forget every registration (including the install latch). */
export function resetPageYdocRegistryForTests(): void {
  ydocNameByQueryKey.clear();
  livePersistences.clear();
  installed = false;
}

/**
 * Map a `["pages", id]` query-key id to the page's ydoc database name.
 *
 * Three sources, in order of authority:
 *  1. this session's alias map (a page opened here — always exact);
 *  2. the PERSISTED #563 page-meta boot cache, which stores every page it has
 *     ever seen under BOTH its uuid and its slugId. This is what makes eviction
 *     work in its main scenario: a fresh session that opens a revoked page
 *     straight from a bookmark never mounts the editor, so (1) is empty — but
 *     the page was cached on an earlier visit, which is exactly the case where
 *     a local ydoc exists on disk;
 *  3. a bare uuid, which IS the ydoc name by construction.
 *
 * A slugId that is in none of them addresses a page this device never opened,
 * so it has no local ydoc to destroy.
 */
function resolveYdocName(queryKeyId: string): string | null {
  const known = ydocNameByQueryKey.get(queryKeyId);
  if (known) return known;

  try {
    const cached = getDefaultStore().get(pageMetaCacheAtom)[queryKeyId];
    if (cached?.id) return pageYdocName(cached.id);
  } catch {
    // A cache read must never block eviction; fall through to the uuid rule.
  }

  return UUID_RE.test(queryKeyId) ? pageYdocName(queryKeyId) : null;
}

/** Best-effort raw delete of the IDB database backing a destroyed ydoc. */
function deleteYdocDatabase(documentName: string): void {
  try {
    if (typeof indexedDB === "undefined") return;
    const request = indexedDB.deleteDatabase(documentName);
    // `deleteDatabase` resolves to a silent no-op while ANOTHER TAB still holds
    // the database open ("blocked"). Log it: the revoked content then survives
    // until that tab closes, and a silent failure of a fail-closed guard is the
    // worst possible failure mode to debug.
    request.onblocked = () => {
      console.warn(
        "[page-ydoc] eviction blocked — another tab holds the ydoc open",
        documentName,
      );
    };
    request.onerror = () => {
      console.warn("[page-ydoc] eviction failed", documentName, request.error);
    };
  } catch {
    // best effort — nothing else we can do here
  }
}

/**
 * Destroy the local ydoc for the page addressed by a `["pages", id]` query key.
 * Returns true when something was targeted for destruction.
 */
export async function evictPageYdoc(queryKeyId: string): Promise<boolean> {
  const documentName = resolveYdocName(queryKeyId);
  if (!documentName) return false;

  const persistence = livePersistences.get(documentName);
  livePersistences.delete(documentName);
  ydocNameByQueryKey.delete(queryKeyId);

  if (persistence) {
    try {
      // clearData() destroys the persistence AND deletes the IDB database.
      await persistence.clearData();
      return true;
    } catch {
      // fall through to the raw delete below
    }
  }
  deleteYdocDatabase(documentName);
  return true;
}

let installed = false;

/**
 * Subscribe ydoc eviction to page-query FAILURES, globally and independently of
 * what is mounted. Installed ONCE at app level (main.tsx): the revoked-page case
 * this exists for never mounts the page editor at all, so installing it from the
 * editor would mean the 403 is simply never heard.
 *
 * ORDERING (load-bearing): this must be installed BEFORE #563's
 * `installPageMetaEviction`, because that subscriber DELETES the page-meta entry
 * this one resolves the `slugId -> pageId` alias from. Query-cache listeners run
 * in registration order, and `resolveYdocName` runs synchronously here, so
 * installing first means the alias is still present when we read it.
 *
 * Returns the unsubscribe function (tests use it; the app keeps it for life).
 */
export function installPageYdocEviction(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    // Flag off → the body is never painted from the local ydoc ahead of the
    // server, so a 403/404 keeps doing exactly what it does today.
    if (!isLocalFirstEnabled()) return;
    if (event.type !== "updated") return;
    const query = event.query;
    if (query.state.status !== "error") return;

    const queryKey = query.queryKey;
    if (
      !Array.isArray(queryKey) ||
      queryKey[0] !== "pages" ||
      typeof queryKey[1] !== "string"
    ) {
      return;
    }

    const error = query.state.error as
      | { status?: number; response?: { status?: number } }
      | null
      | undefined;
    const status = error?.status ?? error?.response?.status;
    if (status !== 403 && status !== 404) return;

    void evictPageYdoc(queryKey[1]);
  });
}

/** Install once per app session (idempotent). */
export function installPageYdocEvictionOnce(queryClient: QueryClient): void {
  if (installed) return;
  installed = true;
  installPageYdocEviction(queryClient);
}
