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

import { warmInfiniteAll, warmPageYdoc } from "./make-offline";
import { queryClient } from "@/main.tsx";

const setQueryData = (queryClient as any).setQueryData as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  // Clear call history WITHOUT wiping the mock implementations the vi.mock
  // factories installed (vi.clearAllMocks would drop the constructor return
  // objects and break the provider/idb/yjs spies).
  setQueryData.mockClear();
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

  it("caps pagination at maxPages", async () => {
    // Always returns a non-null cursor — the cap is the only thing that stops it.
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [], meta: { nextCursor: "more" } });

    await warmInfiniteAll(["comments", "p1"], fetchPage, 2);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    const payload = setQueryData.mock.calls[0][1];
    expect(payload.pages).toHaveLength(2);
  });

  it("swallows errors and never writes the cache on failure", async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error("network"));

    await expect(
      warmInfiniteAll(["comments", "p1"], fetchPage),
    ).resolves.toBeUndefined();
    expect(setQueryData).not.toHaveBeenCalled();
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
