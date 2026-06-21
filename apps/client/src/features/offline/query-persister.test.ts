import { describe, it, expect } from "vitest";
import {
  shouldDehydrateOfflineQuery,
  OFFLINE_PERSIST_ROOTS,
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
  it("contains exactly the expected 8 navigation/read roots", () => {
    const expected = [
      "pages",
      "sidebar-pages",
      "root-sidebar-pages",
      "breadcrumbs",
      "comments",
      "space",
      "spaces",
      "recent-changes",
    ];
    expect(OFFLINE_PERSIST_ROOTS.size).toBe(8);
    for (const root of expected) {
      expect(OFFLINE_PERSIST_ROOTS.has(root)).toBe(true);
    }
  });

  it("does NOT contain volatile/auth keys", () => {
    expect(OFFLINE_PERSIST_ROOTS.has("collab-token")).toBe(false);
    expect(OFFLINE_PERSIST_ROOTS.has("trash")).toBe(false);
  });
});
