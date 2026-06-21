import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above imports, so the spies they reference must
// be declared via vi.hoisted (also hoisted). These are inspected by assertions.
const h = vi.hoisted(() => ({
  clear: vi.fn(),
  del: vi.fn(),
}));

// The module under test imports the app entry at load time — it must be mocked.
vi.mock("@/main.tsx", () => ({
  queryClient: { clear: h.clear },
}));
vi.mock("idb-keyval", () => ({
  del: h.del,
}));

import { clearOfflineCache } from "./clear-offline-cache";
import { OFFLINE_CACHE_KEY } from "./query-persister";

// jsdom does not provide indexedDB.databases() or Cache Storage, so the browser
// globals are stubbed per-test. We restore them afterwards.
const originalIndexedDB = (globalThis as any).indexedDB;
const originalCaches = (globalThis as any).caches;

beforeEach(() => {
  h.clear.mockClear();
  h.del.mockClear();
});

afterEach(() => {
  (globalThis as any).indexedDB = originalIndexedDB;
  (globalThis as any).caches = originalCaches;
  vi.restoreAllMocks();
});

describe("clearOfflineCache", () => {
  it("resolves without throwing when the browser globals are absent", async () => {
    (globalThis as any).indexedDB = undefined;
    delete (globalThis as any).caches;

    await expect(clearOfflineCache()).resolves.toBeUndefined();

    // The two store-agnostic steps still run.
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.del).toHaveBeenCalledWith(OFFLINE_CACHE_KEY);
  });

  it("deletes only `page.*` IndexedDB databases and only `api-get-cache` caches", async () => {
    const deleteDatabase = vi.fn((_name: string) => {
      const request: any = {};
      // Resolve the deletion on the next microtask, like a real IDBRequest.
      queueMicrotask(() => request.onsuccess && request.onsuccess());
      return request;
    });
    (globalThis as any).indexedDB = {
      databases: vi
        .fn()
        .mockResolvedValue([
          { name: "page.aaa" },
          { name: "page.bbb" },
          { name: "keyval-store" },
          { name: undefined },
        ]),
      deleteDatabase,
    };

    const cacheDelete = vi.fn().mockResolvedValue(true);
    (globalThis as any).caches = {
      keys: vi
        .fn()
        .mockResolvedValue([
          "workbox-runtime-https://app/api-get-cache",
          "other-cache",
        ]),
      delete: cacheDelete,
    };

    await expect(clearOfflineCache()).resolves.toBeUndefined();

    // Only the two page.* databases are deleted.
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
    expect(deleteDatabase).toHaveBeenCalledWith("page.aaa");
    expect(deleteDatabase).toHaveBeenCalledWith("page.bbb");

    // Only the api-get-cache entry is deleted.
    expect(cacheDelete).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith(
      "workbox-runtime-https://app/api-get-cache",
    );
  });

  it("never throws even if a step rejects (best-effort)", async () => {
    h.del.mockRejectedValueOnce(new Error("idb boom"));
    (globalThis as any).indexedDB = {
      databases: vi.fn().mockRejectedValue(new Error("databases boom")),
      deleteDatabase: vi.fn(),
    };
    (globalThis as any).caches = {
      keys: vi.fn().mockRejectedValue(new Error("caches boom")),
      delete: vi.fn(),
    };

    await expect(clearOfflineCache()).resolves.toBeUndefined();
    expect(h.clear).toHaveBeenCalledTimes(1);
  });
});
