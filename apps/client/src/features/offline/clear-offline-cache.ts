import { del } from "idb-keyval";

import { queryClient } from "@/main.tsx";
import { OFFLINE_CACHE_KEY } from "./query-persister";

/**
 * Best-effort purge of all of the current user's offline data from the browser.
 *
 * On logout the previous user's private data would otherwise linger locally and
 * be readable by the next person on the device. This clears the three offline
 * stores the app writes:
 *   1. the in-memory + IndexedDB-persisted TanStack Query cache (idb-keyval key
 *      `OFFLINE_CACHE_KEY`),
 *   2. the Yjs page documents (IndexedDB databases named `page.<id>` created by
 *      y-indexeddb in make-offline.ts), and
 *   3. any legacy service worker `api-get-cache` Cache Storage entry. The
 *      Workbox runtime no longer creates this cache (the GET /api NetworkFirst
 *      rule was removed — offline reads come from the persisted RQ cache), so
 *      this is now a defensive cleanup for caches left by older app versions.
 *
 * Fully best-effort: every step is isolated so a single failure neither blocks
 * the remaining steps nor throws to the caller (logout must never be blocked on
 * cache cleanup). Callers may ignore the resolved value.
 *
 * Limitations:
 *   - Deleting the Yjs page databases relies on `indexedDB.databases()`, which
 *     is unavailable in some browsers (notably Firefox). There we skip silently;
 *     those `page.<id>` databases are then left in place.
 *   - Cache Storage clearing only runs where `caches` exists (secure contexts /
 *     service-worker-capable browsers).
 */
export async function clearOfflineCache(): Promise<void> {
  // 1a. Drop the in-memory query cache immediately.
  try {
    queryClient.clear();
  } catch {
    // best-effort: ignore in-memory cache reset failures
  }

  // 1b. Delete the persisted RQ cache from IndexedDB.
  try {
    await del(OFFLINE_CACHE_KEY);
  } catch {
    // best-effort: ignore persisted-cache deletion failures
  }

  // 2. Delete the Yjs page IndexedDB databases (`page.<id>`).
  // `indexedDB.databases()` is not implemented everywhere (e.g. Firefox); when
  // it is missing we cannot enumerate the page databases, so we skip silently.
  try {
    if (
      typeof indexedDB !== "undefined" &&
      typeof indexedDB.databases === "function"
    ) {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        const name = db?.name;
        if (typeof name !== "string" || !name.startsWith("page.")) continue;
        try {
          // Fire-and-forget delete; await a thin wrapper so a slow delete does
          // not race the page teardown, but never reject on it.
          await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          });
        } catch {
          // best-effort per database
        }
      }
    }
  } catch {
    // best-effort: ignore enumeration/deletion failures
  }

  // 3. Clear any legacy service worker API cache. Current builds no longer
  // create it, but an older client may have left an "api-get-cache" entry
  // (Workbox may prefix the name), so match by substring rather than exact name.
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.includes("api-get-cache"))
          .map((key) => caches.delete(key)),
      );
    }
  } catch {
    // best-effort: ignore Cache Storage failures
  }
}
