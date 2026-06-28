import { get, set, del } from "idb-keyval";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

// Structural subset of a TanStack Query we read when deciding what to persist.
// We avoid importing the branded `Query` class because the persist-client and
// react-query may resolve to different `@tanstack/query-core` copies, whose
// `Query` types are nominally incompatible (private brand). This structural
// shape stays assignable to whichever copy the persister expects.
type DehydratableQuery = {
  state: { status: string };
  queryKey: readonly unknown[];
};

// idb-keyval key under which TanStack Query persists its dehydrated cache.
// Exported so the logout cache-clear logic deletes the exact same key (no
// magic-string drift between persist and purge).
export const OFFLINE_CACHE_KEY = "gitmost-rq-cache";

// IndexedDB-backed storage adapter for TanStack Query's async persister.
const idbStorage = {
  getItem: (key: string) => get<string>(key).then((v) => v ?? null),
  setItem: (key: string, value: string) => set(key, value),
  removeItem: (key: string) => del(key),
};

const basePersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: OFFLINE_CACHE_KEY,
  throttleTime: 1000,
});

// When frozen, persistClient becomes a no-op so no new dehydrated snapshot is
// written to IndexedDB. This closes a logout data-leak race: clearing the cache
// (queryClient.clear()) fires `removed` cache events, each of which the persist
// subscription turns into a throttled persistClient call. The FIRST such call
// dehydrates a still-nearly-full snapshot and its async write can land AFTER the
// del() that clears the key, resurrecting the previous user's data (~180KB) in
// IndexedDB. Freezing before clear()/del() prevents any such rewrite. Re-enabled
// afterwards so the next (sign-in) session persists normally. See
// clear-offline-cache.ts.
let persistFrozen = false;

export function freezeOfflinePersistence(): void {
  persistFrozen = true;
}

export function unfreezeOfflinePersistence(): void {
  persistFrozen = false;
}

export const queryPersister = {
  persistClient: (persistedClient: Parameters<typeof basePersister.persistClient>[0]) =>
    persistFrozen ? Promise.resolve() : basePersister.persistClient(persistedClient),
  restoreClient: () => basePersister.restoreClient(),
  removeClient: () => basePersister.removeClient(),
};

// Only navigation/read query roots are persisted for offline reading.
// Volatile/auth queries (collab tokens, trash lists) are intentionally excluded.
//
// `currentUser` IS persisted: UserProvider gates the entire <Layout> subtree on
// useCurrentUser(), and offline the POST /api/users/me fails as a no-response
// network error. Without the persisted/hydrated user the gate blanked every
// authenticated route on an offline cold boot (#237/#238). It is the logged-in
// user's own profile (already mirrored to localStorage["currentUser"]), so
// persisting it to IndexedDB leaks nothing new while unlocking offline reads.
export const OFFLINE_PERSIST_ROOTS = new Set<string>([
  "pages",
  "sidebar-pages",
  "root-sidebar-pages",
  "breadcrumbs",
  "comments",
  "space",
  "spaces",
  "recent-changes",
  "currentUser",
]);

export function shouldDehydrateOfflineQuery(query: DehydratableQuery): boolean {
  return (
    query.state.status === "success" &&
    OFFLINE_PERSIST_ROOTS.has(String(query.queryKey?.[0]))
  );
}
