import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above imports, so any spy they reference must be
// declared with vi.hoisted (which is hoisted as well). These shared spies are
// inspected by the assertions below.
const h = vi.hoisted(() => ({
  ydocDestroy: vi.fn(),
  idbDestroy: vi.fn(),
  providerOn: vi.fn(),
  providerOff: vi.fn(),
  providerDestroy: vi.fn(),
}));

// The module under test imports the app entry at load time — it must be mocked.
vi.mock("@/main.tsx", () => ({
  queryClient: { setQueryData: vi.fn(), prefetchQuery: vi.fn() },
}));
vi.mock("@/features/page/services/page-service", () => ({
  getPageById: vi.fn(),
  getPageBreadcrumbs: vi.fn(),
  getSidebarPages: vi.fn(),
  getAllSidebarPages: vi.fn(),
}));
vi.mock("@/features/space/services/space-service.ts", () => ({
  getSpaceById: vi.fn(),
}));
vi.mock("@/features/comment/services/comment-service", () => ({
  getPageComments: vi.fn(),
}));

// Use the `function` form (not an arrow) so Vitest binds the constructor return
// value when the module under test calls `new Y.Doc()` etc.
vi.mock("yjs", () => ({
  Doc: vi.fn(function () {
    return { destroy: h.ydocDestroy };
  }),
}));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: vi.fn(function () {
    return { destroy: h.idbDestroy };
  }),
}));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: vi.fn(function () {
    return { on: h.providerOn, off: h.providerOff, destroy: h.providerDestroy };
  }),
}));

import {
  warmInfiniteAll,
  warmPageYdoc,
  makePageAvailableOffline,
} from "./make-offline";
import { queryClient } from "@/main.tsx";
import {
  getPageById,
  getPageBreadcrumbs,
  getSidebarPages,
} from "@/features/page/services/page-service";
import { getPageComments } from "@/features/comment/services/comment-service";

const setQueryData = (queryClient as any).setQueryData as ReturnType<
  typeof vi.fn
>;
const prefetchQuery = (queryClient as any).prefetchQuery as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  // Clear call history WITHOUT wiping the mock implementations the vi.mock
  // factories installed (vi.clearAllMocks would drop the constructor return
  // objects and break the provider/idb/yjs spies).
  setQueryData.mockClear();
  prefetchQuery.mockReset();
  prefetchQuery.mockResolvedValue(undefined);
  (getPageById as ReturnType<typeof vi.fn>).mockReset();
  (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockReset();
  (getSidebarPages as ReturnType<typeof vi.fn>).mockReset();
  (getPageComments as ReturnType<typeof vi.fn>).mockReset();
  h.ydocDestroy.mockClear();
  h.idbDestroy.mockClear();
  h.providerOn.mockClear();
  h.providerOff.mockClear();
  h.providerDestroy.mockClear();
});

describe("warmInfiniteAll", () => {
  it("warms a single page and writes the InfiniteData cache shape", async () => {
    const res = { items: [{ id: 1 }], meta: { nextCursor: null } };
    const fetchPage = vi.fn().mockResolvedValue(res);

    await warmInfiniteAll(["comments", "p1"], fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
    expect(setQueryData).toHaveBeenCalledTimes(1);
    expect(setQueryData).toHaveBeenCalledWith(["comments", "p1"], {
      pages: [res],
      pageParams: [undefined],
    });
  });

  it("walks the cursor chain across multiple pages", async () => {
    const r0 = { items: [], meta: { nextCursor: "c1" } };
    const r1 = { items: [], meta: { nextCursor: "c2" } };
    const r2 = { items: [], meta: { nextCursor: null } };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(r0)
      .mockResolvedValueOnce(r1)
      .mockResolvedValueOnce(r2);

    await warmInfiniteAll(["comments", "p1"], fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([
      undefined,
      "c1",
      "c2",
    ]);
    const payload = setQueryData.mock.calls[0][1];
    expect(payload.pages).toEqual([r0, r1, r2]);
    expect(payload.pageParams).toEqual([undefined, "c1", "c2"]);
  });

  it("caps pagination at maxPages and reports the truncation (returns false)", async () => {
    // Always returns a non-null cursor — the cap is the only thing that stops it.
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [], meta: { nextCursor: "more" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Hitting maxPages with a cursor still pending is a truncated warm: the
    // (partial) cache is still written, but the result is reported as false.
    await expect(
      warmInfiniteAll(["comments", "p1"], fetchPage, 2),
    ).resolves.toBe(false);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    const payload = setQueryData.mock.calls[0][1];
    expect(payload.pages).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("returns true on success", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [], meta: { nextCursor: null } });

    await expect(
      warmInfiniteAll(["comments", "p1"], fetchPage),
    ).resolves.toBe(true);
  });

  it("reports errors (returns false) and never writes the cache on failure", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("network"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      warmInfiniteAll(["comments", "p1"], fetchPage),
    ).resolves.toBe(false);
    expect(setQueryData).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("makePageAvailableOffline", () => {
  const okPage = {
    id: "uuid-1",
    slugId: "slug-1",
    space: { slug: "space-slug" },
  };

  it("returns ok:true with no failures when every step succeeds", async () => {
    (getPageById as ReturnType<typeof vi.fn>).mockResolvedValue(okPage);
    (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getSidebarPages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    (getPageComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });

    const result = await makePageAvailableOffline({
      pageId: "uuid-1",
      spaceId: "space-uuid",
    });

    expect(result).toEqual({ ok: true, failed: [] });
  });

  it("returns ok:false with the failed step label when a warm step fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (getPageById as ReturnType<typeof vi.fn>).mockResolvedValue(okPage);
    (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getSidebarPages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    // Comments warm fails -> labeled "comments".
    (getPageComments as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network"),
    );

    const result = await makePageAvailableOffline({
      pageId: "uuid-1",
      spaceId: "space-uuid",
    });

    expect(result.ok).toBe(false);
    expect(result.failed).toContain("comments");
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // Helper: the page-ids passed to the sidebar-children warm (its query key is
  // ["sidebar-pages", { pageId, spaceId }]) — i.e. which nodes were prefetched.
  const warmedSidebarIds = () =>
    prefetchQuery.mock.calls
      .map((c) => c[0])
      .filter((opts: any) => opts?.queryKey?.[0] === "sidebar-pages")
      .map((opts: any) => opts.queryKey[1]?.pageId);

  it("warms the page + every ancestor's children once and skips the self-ancestor guard", async () => {
    (getPageById as ReturnType<typeof vi.fn>).mockResolvedValue(okPage);
    // Breadcrumbs include two real ancestors, the page's OWN id (must be skipped
    // by the ancestorId === pageId guard so it is not warmed twice), and a
    // malformed entry with no id (also skipped).
    (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "anc-1" },
      { id: "uuid-1" }, // === pageId -> guard
      { id: "anc-2" },
      {}, // no id -> skipped
    ]);
    (getSidebarPages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    (getPageComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });

    const result = await makePageAvailableOffline({
      pageId: "uuid-1",
      spaceId: "space-uuid",
    });

    const ids = warmedSidebarIds();
    // The page's own children (warmSidebarChildren(pageId)) plus each real
    // ancestor — exactly once each. The self-ancestor (uuid-1 in breadcrumbs) is
    // NOT a second warm: uuid-1 appears once (from the page's own children call).
    expect(ids).toEqual(["uuid-1", "anc-1", "anc-2"]);
    expect(ids.filter((id: string) => id === "uuid-1")).toHaveLength(1);
    expect(result).toEqual({ ok: true, failed: [] });
  });

  it("dedupes repeated tree failures into a single 'tree' label", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (getPageById as ReturnType<typeof vi.fn>).mockResolvedValue(okPage);
    (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "anc-1" },
      { id: "anc-2" },
    ]);
    (getSidebarPages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    (getPageComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    // Fail ONLY the sidebar-children prefetches (page-own + both ancestors = 3
    // failures); the currentUser/space prefetches still resolve.
    prefetchQuery.mockImplementation(async (opts: any) => {
      if (opts?.queryKey?.[0] === "sidebar-pages") throw new Error("network");
      return undefined;
    });

    const result = await makePageAvailableOffline({
      pageId: "uuid-1",
      spaceId: "space-uuid",
    });

    // Three node warms failed but the contract collapses them to one "tree".
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(["tree"]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("records 'breadcrumbs' (not 'tree') when the breadcrumbs lookup rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (getPageById as ReturnType<typeof vi.fn>).mockResolvedValue(okPage);
    // Ancestor discovery fails -> the ancestor-walk is recorded as "breadcrumbs".
    (getPageBreadcrumbs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network"),
    );
    (getSidebarPages as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });
    (getPageComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      meta: { nextCursor: null },
    });

    const result = await makePageAvailableOffline({
      pageId: "uuid-1",
      spaceId: "space-uuid",
    });

    // The page's own children still warmed fine (prefetch resolves), so the only
    // failure is the breadcrumbs lookup.
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(["breadcrumbs"]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("warmPageYdoc", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on synced, detaches the listener once, and tears everything down (settle-once)", async () => {
    const promise = warmPageYdoc("p1", "ws://x");

    // Grab the synced handler the provider registered.
    expect(h.providerOn).toHaveBeenCalledWith("synced", expect.any(Function));
    const handler = h.providerOn.mock.calls.find(
      (c) => c[0] === "synced",
    )![1] as () => void;

    handler();
    await expect(promise).resolves.toBeUndefined();

    // Listener detached and everything cleaned up.
    expect(h.providerOff).toHaveBeenCalledWith("synced", expect.any(Function));
    expect(h.providerDestroy).toHaveBeenCalledTimes(1);
    expect(h.idbDestroy).toHaveBeenCalledTimes(1);
    expect(h.ydocDestroy).toHaveBeenCalledTimes(1);

    // Firing the handler again must NOT re-run cleanup (settled guard).
    handler();
    expect(h.providerDestroy).toHaveBeenCalledTimes(1);
    expect(h.idbDestroy).toHaveBeenCalledTimes(1);
    expect(h.ydocDestroy).toHaveBeenCalledTimes(1);
  });

  it("resolves and cleans up after the timeout when synced never fires", async () => {
    vi.useFakeTimers();
    const promise = warmPageYdoc("p1", "ws://x");

    // Do not fire "synced"; let the 8s safety timeout settle it.
    await vi.advanceTimersByTimeAsync(8000);
    await expect(promise).resolves.toBeUndefined();

    expect(h.providerDestroy).toHaveBeenCalledTimes(1);
    expect(h.idbDestroy).toHaveBeenCalledTimes(1);
    expect(h.ydocDestroy).toHaveBeenCalledTimes(1);
  });
});
