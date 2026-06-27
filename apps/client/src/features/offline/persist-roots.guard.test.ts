import { describe, it, expect } from "vitest";

// The query modules transitively import the app entry (@/main.tsx) for the
// shared queryClient; mock it so importing the key factories has no side effects.
import { vi } from "vitest";
vi.mock("@/main.tsx", () => ({
  queryClient: { setQueryData: vi.fn(), getQueryData: vi.fn() },
}));

import { OFFLINE_PERSIST_ROOTS } from "./query-persister";
import { pageKeys } from "@/features/page/queries/page-query";
import { spaceKeys } from "@/features/space/queries/space-query";
import { RQ_KEY } from "@/features/comment/queries/comment-query";
import { userKeys } from "@/features/user/hooks/use-current-user";

/**
 * Architecture guard (#13): every string persisted via OFFLINE_PERSIST_ROOTS
 * must be the ROOT (queryKey[0]) of some exported query-key factory. If a
 * factory's root is renamed without updating the persist registry — or vice
 * versa — offline persist/warm silently breaks (persisted keys never match the
 * live queries). This turns that silent regression into a red build.
 *
 * Each factory is invoked with throwaway args; only queryKey[0] is inspected.
 */
function rootOf(key: readonly unknown[]): string {
  return String(key[0]);
}

const FACTORY_ROOTS = new Set<string>([
  rootOf(pageKeys.detail("x")),
  rootOf(pageKeys.sidebar({})),
  rootOf(pageKeys.rootSidebar("x")),
  rootOf(pageKeys.breadcrumbs("x")),
  rootOf(pageKeys.recentChanges("x")),
  rootOf(spaceKeys.detail("x")),
  rootOf(spaceKeys.list()),
  rootOf(RQ_KEY("x")),
  rootOf(userKeys.currentUser()),
]);

describe("OFFLINE_PERSIST_ROOTS is backed by real query-key factories", () => {
  it("maps every persisted root to an exported factory root", () => {
    const unbacked = [...OFFLINE_PERSIST_ROOTS].filter(
      (root) => !FACTORY_ROOTS.has(root),
    );
    expect(unbacked).toEqual([]);
  });
});
