import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";

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
vi.mock("@/features/page/queries/page-query", () => ({
  invalidateOnCreatePage: vi.fn(),
}));

// In-memory idb-keyval so the REAL queryPersister round-trips through a fake
// store (the actual persist -> reload -> restore path, not a hand-built blob).
const store = new Map<string, string>();
vi.mock("idb-keyval", () => ({
  get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? undefined)),
  set: vi.fn((k: string, v: string) => {
    store.set(k, v);
    return Promise.resolve();
  }),
  del: vi.fn((k: string) => {
    store.delete(k);
    return Promise.resolve();
  }),
}));

import { queryPersister } from "./query-persister";
import {
  offlineMutationKeys,
  registerOfflineMutationDefaults,
} from "./offline-mutations";

const BUSTER = "test-buster";

beforeEach(() => {
  store.clear();
  h.createPage.mockReset().mockResolvedValue({ id: "new-page" });
  h.movePage.mockReset().mockResolvedValue(undefined);
  h.createComment.mockReset().mockResolvedValue({ id: "new-comment" });
});

afterEach(() => {
  // onlineManager is a global singleton; leave it in the default online state.
  onlineManager.setOnline(true);
});

describe("offline paused-mutation resume across a reload", () => {
  // This is the #120 silent-data-loss reproduction: a paused mutation persisted
  // to IndexedDB while offline, then the tab RELOADS while still offline, must
  // resume on reconnect. It exercises the real persister round-trip plus the two
  // boot-time fixes the app wiring relies on:
  //   (a) onlineManager seeded to the real offline state so the later reconnect
  //       is a true offline->online transition that auto-resumes, and
  //   (b) resumePausedMutations() called after the persister restores (what the
  //       PersistQueryClientProvider onSuccess does), with mutation defaults
  //       registered BEFORE the resume so the rehydrated mutation has a fn.
  it("replays a rehydrated paused create on reconnect (mutationFn fires)", async () => {
    // --- Tab 1, OFFLINE: user creates a page; it pauses and gets persisted. ---
    onlineManager.setOnline(false); // (a) boot seeded offline

    const client1 = new QueryClient();
    registerOfflineMutationDefaults(client1);
    const observer = client1.getMutationCache().build(client1, {
      mutationKey: offlineMutationKeys.createPage,
    });
    observer.state.isPaused = true;
    observer.state.status = "pending";
    observer.state.variables = { spaceId: "s1", title: "Offline page" };

    await persistQueryClientSave({
      // Cast: persist-client-core and react-query may resolve to different
      // @tanstack/query-core copies whose QueryClient brands are nominally
      // incompatible (see query-persister.ts). Structurally identical at runtime.
      queryClient: client1 as any,
      persister: queryPersister,
      buster: BUSTER,
      dehydrateOptions: { shouldDehydrateMutation: () => true },
    });
    // The paused mutation is now in the persisted store.
    expect(store.size).toBe(1);

    // --- RELOAD while still offline: fresh client restores from the SAME
    //     persister. Defaults are registered BEFORE restore/resume. ---
    const client2 = new QueryClient();
    registerOfflineMutationDefaults(client2);
    client2.mount(); // subscribes to onlineManager (auto-resume on reconnect)

    await persistQueryClientRestore({
      queryClient: client2 as any,
      persister: queryPersister,
      buster: BUSTER,
    });
    expect(client2.getMutationCache().getAll()).toHaveLength(1);

    // (b) onSuccess wiring resumes after restore — but we are still OFFLINE, so
    // the mutation must stay paused and NOT fire yet.
    await client2.resumePausedMutations();
    expect(h.createPage).not.toHaveBeenCalled();

    // --- RECONNECT: the offline->online transition auto-resumes the paused
    //     mutation and its registered default mutationFn finally fires. ---
    onlineManager.setOnline(true);

    await vi.waitFor(() => {
      expect(h.createPage).toHaveBeenCalledTimes(1);
    });
    expect(h.createPage).toHaveBeenCalledWith({
      spaceId: "s1",
      title: "Offline page",
    });

    client2.unmount();
  });
});
