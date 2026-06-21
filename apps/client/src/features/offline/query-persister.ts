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

// IndexedDB-backed storage adapter for TanStack Query's async persister.
const idbStorage = {
  getItem: (key: string) => get<string>(key).then((v) => v ?? null),
  setItem: (key: string, value: string) => set(key, value),
  removeItem: (key: string) => del(key),
};

export const queryPersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: "gitmost-rq-cache",
  throttleTime: 1000,
});

// Only navigation/read query roots are persisted for offline reading.
// Volatile/auth queries (collab tokens, trash lists) are intentionally excluded.
export const OFFLINE_PERSIST_ROOTS = new Set<string>([
  "pages",
  "sidebar-pages",
  "root-sidebar-pages",
  "breadcrumbs",
  "comments",
  "space",
  "spaces",
  "recent-changes",
]);

export function shouldDehydrateOfflineQuery(query: DehydratableQuery): boolean {
  return (
    query.state.status === "success" &&
    OFFLINE_PERSIST_ROOTS.has(String(query.queryKey?.[0]))
  );
}
