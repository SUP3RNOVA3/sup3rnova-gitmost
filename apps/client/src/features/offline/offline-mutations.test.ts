import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, hydrate, dehydrate } from "@tanstack/react-query";

// Stub the network services so a replayed mutation hits a spy, not the network.
const h = vi.hoisted(() => ({
  createPage: vi.fn(),
  movePage: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("@/features/page/services/page-service", () => ({
  createPage: h.createPage,
  movePage: h.movePage,
}));
vi.mock("@/features/comment/services/comment-service", () => ({
  createComment: h.createComment,
}));
// page-query pulls in the app entry (queryClient) and a lot of UI deps via its
// cache helpers; we only need invalidateOnCreatePage to be a no-op here.
vi.mock("@/features/page/queries/page-query", () => ({
  invalidateOnCreatePage: vi.fn(),
}));

import {
  offlineMutationKeys,
  registerOfflineMutationDefaults,
} from "./offline-mutations";

beforeEach(() => {
  h.createPage.mockReset().mockResolvedValue({ id: "new-page" });
  h.movePage.mockReset().mockResolvedValue(undefined);
  h.createComment.mockReset().mockResolvedValue({ id: "new-comment" });
});

describe("registerOfflineMutationDefaults", () => {
  it("registers a default mutationFn for every offline mutation key", () => {
    const qc = new QueryClient();
    registerOfflineMutationDefaults(qc);

    for (const key of Object.values(offlineMutationKeys)) {
      const defaults = qc.getMutationDefaults(key);
      expect(typeof defaults?.mutationFn).toBe("function");
    }
  });

  // The headline durability guarantee: a paused mutation dehydrated into
  // IndexedDB while offline must, after a reload, have a mutationFn so
  // resumePausedMutations() actually replays the write on reconnect.
  it("makes a rehydrated paused create replayable by resumePausedMutations", async () => {
    // 1) Simulate the offline tab: a paused create mutation gets dehydrated.
    const offlineClient = new QueryClient();
    const observer = offlineClient.getMutationCache().build(offlineClient, {
      mutationKey: offlineMutationKeys.createPage,
    });
    // Force the dehydrate-worthy paused state (offline = isPaused) with the
    // payload the user submitted before losing connectivity.
    observer.state.isPaused = true;
    observer.state.status = "pending";
    observer.state.variables = { spaceId: "s1", title: "Offline page" };

    const dehydrated = dehydrate(offlineClient, {
      shouldDehydrateMutation: () => true,
    });
    expect(dehydrated.mutations).toHaveLength(1);
    // The dehydrated mutation carries NO mutationFn (functions aren't
    // serializable) — only its key + variables survive the reload.
    expect((dehydrated.mutations[0] as any).mutationFn).toBeUndefined();

    // 2) Simulate the fresh page after reload: register defaults, then hydrate
    //    the persisted paused mutation back in.
    const freshClient = new QueryClient();
    registerOfflineMutationDefaults(freshClient);
    hydrate(freshClient, dehydrated);

    expect(freshClient.getMutationCache().getAll()).toHaveLength(1);

    // 3) Reconnect: replay the paused mutations.
    await freshClient.resumePausedMutations();

    // The default mutationFn ran with the persisted variables — the write is
    // NOT silently dropped.
    expect(h.createPage).toHaveBeenCalledTimes(1);
    expect(h.createPage).toHaveBeenCalledWith({
      spaceId: "s1",
      title: "Offline page",
    });
  });

  it("makes a rehydrated paused move replayable by resumePausedMutations", async () => {
    const offlineClient = new QueryClient();
    const observer = offlineClient.getMutationCache().build(offlineClient, {
      mutationKey: offlineMutationKeys.movePage,
    });
    observer.state.isPaused = true;
    observer.state.status = "pending";
    observer.state.variables = { pageId: "p1", parentPageId: null, position: "a" };

    const dehydrated = dehydrate(offlineClient, {
      shouldDehydrateMutation: () => true,
    });

    const freshClient = new QueryClient();
    registerOfflineMutationDefaults(freshClient);
    hydrate(freshClient, dehydrated);
    await freshClient.resumePausedMutations();

    expect(h.movePage).toHaveBeenCalledTimes(1);
    expect(h.movePage).toHaveBeenCalledWith({
      pageId: "p1",
      parentPageId: null,
      position: "a",
    });
  });
});
