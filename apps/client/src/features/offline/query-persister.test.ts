import { describe, it, expect, vi, afterEach } from "vitest";

// In-memory idb-keyval so we can observe whether the persister actually writes.
const h = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));
vi.mock("idb-keyval", () => h);

import {
  shouldDehydrateOfflineQuery,
  OFFLINE_PERSIST_ROOTS,
  queryPersister,
  freezeOfflinePersistence,
  unfreezeOfflinePersistence,
} from "./query-persister";

// Small helper to build the structural query shape the predicate reads.
const makeQuery = (status: string, queryKey: readonly unknown[]) =>
  ({ state: { status }, queryKey }) as any;

describe("shouldDehydrateOfflineQuery", () => {
  it("returns true for a successful query whose root is in the allowlist", () => {
    expect(shouldDehydrateOfflineQuery(makeQuery("success", ["pages", "abc"]))).toBe(
      true,
    );
    expect(
      shouldDehydrateOfflineQuery(
        makeQuery("success", ["sidebar-pages", { pageId: "p", spaceId: "s" }]),
      ),
    ).toBe(true);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["comments", "p1"])),
    ).toBe(true);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["space", "s"])),
    ).toBe(true);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["recent-changes"])),
    ).toBe(true);
    // currentUser is persisted so the auth-gated Layout can hydrate offline.
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["currentUser"])),
    ).toBe(true);
  });

  it("returns false when the status is not success (status gate)", () => {
    expect(
      shouldDehydrateOfflineQuery(makeQuery("pending", ["pages", "abc"])),
    ).toBe(false);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("error", ["pages", "abc"])),
    ).toBe(false);
  });

  it("returns false for a successful query whose root is NOT in the allowlist (privacy gate)", () => {
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["collab-token", "ws"])),
    ).toBe(false);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["trash", "s"])),
    ).toBe(false);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", ["unknown"])),
    ).toBe(false);
  });

  it("returns false for an empty/undefined queryKey", () => {
    // String(undefined) is not a member of the allowlist.
    expect(shouldDehydrateOfflineQuery(makeQuery("success", []))).toBe(false);
    expect(
      shouldDehydrateOfflineQuery(makeQuery("success", undefined as any)),
    ).toBe(false);
  });
});

describe("OFFLINE_PERSIST_ROOTS", () => {
  it("contains exactly the expected 9 navigation/read roots", () => {
    const expected = [
      "pages",
      "sidebar-pages",
      "root-sidebar-pages",
      "breadcrumbs",
      "comments",
      "space",
      "spaces",
      "recent-changes",
      "currentUser",
    ];
    expect(OFFLINE_PERSIST_ROOTS.size).toBe(9);
    for (const root of expected) {
      expect(OFFLINE_PERSIST_ROOTS.has(root)).toBe(true);
    }
  });

  it("does NOT contain volatile/auth keys", () => {
    expect(OFFLINE_PERSIST_ROOTS.has("collab-token")).toBe(false);
    expect(OFFLINE_PERSIST_ROOTS.has("trash")).toBe(false);
  });
});

describe("freeze/unfreeze persistence (logout no-late-write guard)", () => {
  const dummyClient = {
    timestamp: Date.now(),
    buster: "",
    clientState: { mutations: [], queries: [] },
  } as any;

  afterEach(() => {
    // Always leave persistence enabled so other tests/sessions persist normally.
    unfreezeOfflinePersistence();
    h.set.mockClear();
  });

  it("does NOT write to storage while frozen", async () => {
    freezeOfflinePersistence();
    await queryPersister.persistClient(dummyClient);
    expect(h.set).not.toHaveBeenCalled();
  });

  it("resumes writing to storage once unfrozen", async () => {
    freezeOfflinePersistence();
    unfreezeOfflinePersistence();
    await queryPersister.persistClient(dummyClient);
    expect(h.set).toHaveBeenCalledTimes(1);
  });
});
