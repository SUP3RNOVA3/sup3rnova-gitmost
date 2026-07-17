import { getDefaultStore } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import type { IndexeddbPersistence } from "y-indexeddb";
import { pageMetaCacheAtom } from "@/features/page/atoms/page-meta-cache-atom";
import { scopeKeyAtom } from "@/features/page/tree/atoms/open-tree-nodes-atom";
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

/**
 * Prefix shared by EVERY page-body ydoc IndexedDB database. The namespacing
 * below, the enumeration-based purge, the Firefox registry fallback, and the
 * legacy migration all key off this single constant so they can never drift
 * apart.
 */
export const PAGE_YDOC_PREFIX = "page.";

/**
 * The y-indexeddb database name the page editor uses for a page's body.
 *
 * NAMESPACED BY SCOPE (#626). Before this, the body ydoc lived under a bare
 * `page.<pageId>` with NO workspace/user namespace, so on a shared device the
 * next user who opened the same page id (in this or ANOTHER workspace) inherited
 * the PREVIOUS user's local ydoc as the starting state — and with local-first
 * phase 2 (#564) the body is painted from that local ydoc BEFORE the network
 * answers 403/404, flashing another user's content on screen.
 *
 * The name now embeds the SAME `<workspace>:<user>` scope key the tree/meta boot
 * caches use (`scopeKeyAtom`, the #563 mechanism), yielding
 * `page.<scopeKey>.<pageId>`. Two scopes therefore get two distinct databases.
 *
 * Fail-closed for anon: a signed-out / not-yet-resolved state resolves the scope
 * to `anon:anon` (see `scopeKeyAtom`). Real ids are uuids and never the literal
 * "anon", so an anon name can never collide with a real user's — mirroring how
 * the #563 caches treat the `anon` segment (they additionally REFUSE it; the
 * ydoc cannot refuse — the editor always needs a doc — but the editor only ever
 * mounts after `/me` resolves, so a real scope is in hand by then anyway).
 */
export function pageYdocName(pageId: string, scopeKey: string): string {
  return `${PAGE_YDOC_PREFIX}${scopeKey}.${pageId}`;
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

  // The ydoc name is scoped by (workspace, user). A 403/404 belongs to the
  // CURRENTLY signed-in user whose page it is, so the name to destroy is built
  // from the current scope — the same value page-editor used to create the doc.
  const scopeKey = getDefaultStore().get(scopeKeyAtom);

  try {
    const cached = getDefaultStore().get(pageMetaCacheAtom)[queryKeyId];
    if (cached?.id) return pageYdocName(cached.id, scopeKey);
  } catch {
    // A cache read must never block eviction; fall through to the uuid rule.
  }

  return UUID_RE.test(queryKeyId) ? pageYdocName(queryKeyId, scopeKey) : null;
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

// ---------------------------------------------------------------------------
// #626 — cross-user hygiene for the page-body ydoc databases.
//
// Namespacing (above) is the PRIMARY defense: a new user simply cannot address
// the previous user's scoped database. The purge + migration below are
// belt-and-suspenders — they physically remove the on-disk copies so revoked /
// signed-out content leaves the machine, and they clean up the pre-#626 legacy
// `page.<pageId>` databases that predate namespacing.
// ---------------------------------------------------------------------------

// Firefox does NOT implement `indexedDB.databases()`, so enumeration-based purge
// cannot see the ydoc databases there. We keep a best-effort registry of the
// ydoc DB names this browser has opened (in localStorage) so the purge can still
// delete them by name on Firefox. Enumeration remains the primary path where it
// exists; the registry is a superset-covering fallback.
const YDOC_DB_REGISTRY_KEY = "pageYdoc.dbNames.v1";
// Bound the registry like the session alias map: a long-lived browser must not
// grow this array without limit.
const MAX_REGISTRY_ENTRIES = 500;

function readYdocDbRegistry(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(YDOC_DB_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Record a ydoc database name so the Firefox purge fallback can find it later.
 * Called by page-editor when it opens the local persistence. No-op for names
 * that aren't ours, and never throws (storage may be disabled/full).
 */
export function rememberYdocDbName(name: string): void {
  if (!name.startsWith(PAGE_YDOC_PREFIX)) return;
  try {
    if (typeof localStorage === "undefined") return;
    const names = readYdocDbRegistry().filter((n) => n !== name);
    names.push(name);
    while (names.length > MAX_REGISTRY_ENTRIES) names.shift();
    localStorage.setItem(YDOC_DB_REGISTRY_KEY, JSON.stringify(names));
  } catch {
    // best-effort registry — the namespacing is the real defense
  }
}

function clearYdocDbRegistry(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(YDOC_DB_REGISTRY_KEY);
  } catch {
    // ignore
  }
}

/**
 * A ydoc database name is LEGACY (pre-#626) when it is un-namespaced:
 * `page.<pageId>`. Since every namespaced name embeds the `<workspace>:<user>`
 * scope key — which ALWAYS contains a `:` — while a bare pageId (a uuid) never
 * does, the presence of a `:` after the prefix cleanly distinguishes the new
 * shape from the legacy one. This is scope-independent, so the migration can
 * never mistake the CURRENT user's freshly-namespaced database for a legacy one.
 */
function isLegacyYdocName(name: string): boolean {
  if (!name.startsWith(PAGE_YDOC_PREFIX)) return false;
  return !name.slice(PAGE_YDOC_PREFIX.length).includes(":");
}

/**
 * Purge EVERY `page.`-prefixed ydoc IndexedDB database. Called wherever the
 * meta/tree boot caches are swept (logout, sign-in-as-different-user, 401), so
 * one user's local page bodies never survive into another user's session on a
 * shared device.
 *
 * Degrades gracefully and NEVER throws:
 *  - the localStorage registry is deleted SYNCHRONOUSLY first, so on Firefox (no
 *    `indexedDB.databases()`) and on every browser the known names are dropped
 *    before the caller's full-page navigation tears this module down;
 *  - where `indexedDB.databases()` exists, it additionally sweeps any
 *    `page.`-prefixed database the registry missed (e.g. opened by another tab).
 *
 * A database currently OPEN by the active editor is not force-closed here — the
 * browser defers such a delete until the last connection closes ("blocked"),
 * which `deleteYdocDatabase` logs. On logout/401 the imminent full-page reload
 * closes it; the namespacing already prevents cross-user reads in the meantime.
 */
export function purgePageYdocDatabases(): void {
  if (typeof indexedDB === "undefined") return;

  // 1. Registry-driven, synchronous, Firefox-safe.
  for (const name of readYdocDbRegistry()) {
    if (name.startsWith(PAGE_YDOC_PREFIX)) deleteYdocDatabase(name);
  }
  clearYdocDbRegistry();

  // 2. Enumeration-driven, best-effort (unsupported in Firefox → skipped).
  if (typeof indexedDB.databases === "function") {
    try {
      indexedDB
        .databases()
        .then((dbs) => {
          for (const db of dbs) {
            if (db.name && db.name.startsWith(PAGE_YDOC_PREFIX)) {
              deleteYdocDatabase(db.name);
            }
          }
        })
        .catch(() => {
          // enumeration failed at runtime — the registry path already ran
        });
    } catch {
      // some environments throw synchronously — ignore
    }
  }
}

// One-time legacy migration guard. `v1` so a future re-migration can bump it.
const YDOC_MIGRATION_FLAG = "pageYdoc.legacyPurged.v1";

/**
 * ONE-TIME migration (#626): on the first launch of the namespaced build, delete
 * the legacy un-namespaced `page.<pageId>` databases left by earlier versions.
 * The body is authoritative on the server; the local ydoc is only a cache, so
 * dropping it is safe (it re-hydrates from collab on next open).
 *
 * Guarded by a localStorage flag so it runs exactly once. It only ever deletes
 * databases whose name does NOT match the new `page.<scopeKey>.<pageId>` shape
 * (see `isLegacyYdocName`), so the current user's freshly-namespaced databases
 * are never touched. Where enumeration is unavailable (Firefox) it simply marks
 * itself done: `purgePageYdocDatabases()` there only walks the localStorage name
 * registry, which never held the legacy un-namespaced names, so a legacy database
 * on Firefox is not physically deleted by anything. That is orphan data-at-rest,
 * not an active leak — the namespacing prevents any new build from opening it.
 */
export function migratePageYdocDatabasesOnce(): void {
  if (typeof indexedDB === "undefined") return;

  let alreadyRun = false;
  try {
    alreadyRun =
      typeof localStorage !== "undefined" &&
      localStorage.getItem(YDOC_MIGRATION_FLAG) === "1";
  } catch {
    // Storage unreadable → cannot record the run, so skip to avoid re-sweeping
    // on every boot. The prefix purge still covers legacy DBs on logout/sign-in.
    return;
  }
  if (alreadyRun) return;

  const markDone = () => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(YDOC_MIGRATION_FLAG, "1");
      }
    } catch {
      // best-effort — nothing else to do
    }
  };

  if (typeof indexedDB.databases !== "function") {
    // Cannot enumerate the legacy names (they predate the registry), so there is
    // nothing to do here on Firefox — and the registry-only purge cannot reach
    // them either, so a legacy database persists as orphan data-at-rest. The
    // namespacing still prevents any new build from opening it. Mark done.
    markDone();
    return;
  }

  try {
    indexedDB
      .databases()
      .then((dbs) => {
        for (const db of dbs) {
          if (db.name && isLegacyYdocName(db.name)) {
            deleteYdocDatabase(db.name);
          }
        }
      })
      .catch(() => {
        // enumeration failed — leave legacy DBs for the prefix purge
      })
      .finally(markDone);
  } catch {
    // synchronous throw — record the run so we don't retry every boot
    markDone();
  }
}

/** Test-only: reset the one-time migration flag. */
export function resetPageYdocMigrationForTests(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(YDOC_MIGRATION_FLAG);
    }
  } catch {
    // ignore
  }
}
