import { describe, it, expect, vi } from "vitest";
import { runCycle, type RunCycleDeps } from "../src/engine/cycle";

// A fake VaultGit recording the staging calls. An EMPTY vault/tree lets the real
// readExisting/computePullActions/applyPullActions/runPush run trivially (no
// files, no pages) so we can assert runCycle's choreography without real git.
function fakeVault(overrides: Record<string, any> = {}) {
  const order: string[] = [];
  const rec =
    (name: string, ret?: any) =>
    async (...args: any[]) => {
      order.push(args.length ? `${name}:${args.join(",")}` : name);
      return ret;
    };
  const vault: any = {
    order,
    assertGitAvailable: rec("assertGitAvailable"),
    ensureRepo: rec("ensureRepo"),
    isMergeInProgress: vi.fn(async () => false),
    ensureBranch: rec("ensureBranch"),
    checkout: rec("checkout"),
    listTrackedFiles: vi.fn(async () => [] as string[]),
    // push-side git surface (empty diff -> a clean no-op push)
    stageAll: rec("stageAll"),
    commit: rec("commit", { committed: false }),
    merge: rec("merge", { ok: true, conflict: false, output: "" }),
    readRef: vi.fn(async () => null),
    revParse: vi.fn(async () => "0000000000000000000000000000000000000000"),
    diffNameStatus: vi.fn(async () => [] as any[]),
    showFileAtRef: vi.fn(async () => ""),
    updateRef: rec("updateRef"),
    fastForwardBranch: rec("fastForwardBranch", { ok: true }),
    ...overrides,
  };
  return vault;
}

function baseDeps(vault: any, over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  return {
    spaceId: "space-1",
    client: {
      listSpaceTree: vi.fn(async () => ({ pages: [], complete: true })),
      getPageJson: vi.fn(),
      importPageMarkdown: vi.fn(),
      createPage: vi.fn(),
      deletePage: vi.fn(),
      movePage: vi.fn(),
      renamePage: vi.fn(),
      listRecentSince: vi.fn(),
      listTrash: vi.fn(),
      restorePage: vi.fn(),
    } as any,
    vault,
    settings: { vaultPath: "/vault" } as any,
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    },
    log: vi.fn(),
    ...over,
  };
}

describe("runCycle (composition)", () => {
  it("short-circuits with skipped:'merge-in-progress' and runs no pull/push", async () => {
    const vault = fakeVault({ isMergeInProgress: vi.fn(async () => true) });
    const deps = baseDeps(vault);

    const res = await runCycle(deps);

    expect(res).toEqual({ ran: false, skipped: "merge-in-progress" });
    // Never advanced to the pull (listSpaceTree) or push.
    expect(deps.client.listSpaceTree).not.toHaveBeenCalled();
    expect(vault.order).not.toContain("checkout:docmost");
  });

  it("stages ensureRepo -> ensureBranch(docmost,main) -> checkout(docmost) BEFORE pulling", async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault);

    const res = await runCycle(deps);

    expect(res.ran).toBe(true);
    const ensureRepoIdx = vault.order.indexOf("ensureRepo");
    const ensureBranchIdx = vault.order.indexOf("ensureBranch:docmost,main");
    const checkoutIdx = vault.order.indexOf("checkout:docmost");
    expect(ensureRepoIdx).toBeGreaterThanOrEqual(0);
    expect(ensureBranchIdx).toBeGreaterThan(ensureRepoIdx);
    expect(checkoutIdx).toBeGreaterThan(ensureBranchIdx);
    expect(deps.client.listSpaceTree).toHaveBeenCalledTimes(1);
  });

  it("consults the resolveApplyClient hook with the planned delete count", async () => {
    const vault = fakeVault();
    const hook = vi.fn((_planned: number, c: any) => c);
    const deps = baseDeps(vault, { resolveApplyClient: hook });

    await runCycle(deps);

    // An empty vault plans zero deletes; the hook is still consulted so the
    // caller's policy always sees the count (and a dry-run preceded it).
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toBe(0);
  });

  it("skips the dry-run entirely when no resolveApplyClient hook is given", async () => {
    const vault = fakeVault();
    const deps = baseDeps(vault); // no resolveApplyClient

    const res = await runCycle(deps);
    expect(res.ran).toBe(true);
    // With no cap hook there is a single runPush (the apply) — no dry-run pass.
    // diffNameStatus is read once per runPush; assert a single planning pass.
    expect(vault.diffNameStatus).toHaveBeenCalledTimes(1);
  });
});
