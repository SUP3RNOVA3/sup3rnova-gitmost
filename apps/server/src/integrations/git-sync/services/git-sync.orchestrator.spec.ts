// Unit tests for the git-sync control plane. The engine's `runCycle`
// (which owns the PULL->PUSH branch choreography) is mocked so we exercise ONLY
// the orchestrator's wiring: gating, the Redis leader lock + in-process mutex
// (via SpaceLockService), the delete-cap POLICY it injects as `resolveApplyClient`,
// the remote-template substitution in the settings it hands the engine, the
// external-push ingest, and the idempotent interval lifecycle. The cycle
// mechanics themselves are covered by the engine's own cycle round-trip spec.
//
// The engine mock must be declared before importing the orchestrator so the
// runtime `loadGitSync()` bridge resolves to the mocked `runCycle` (the ESM
// `@docmost/git-sync` package cannot be `require()`d under jest). The `mock`
// prefix lets the hoisted factory reference it.
const mockRunCycle = jest.fn();

jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    runCycle: mockRunCycle,
  })),
}));

import { Logger } from '@nestjs/common';
import {
  GitSyncOrchestrator,
  GitSyncLockHeldError,
} from './git-sync.orchestrator';
import { SpaceLockService } from './space-lock.service';

type AnyMock = jest.Mock;

const runCycleMock = mockRunCycle as unknown as AnyMock;

/** The default happy-path cycle result the engine returns. */
const OK_CYCLE = {
  ran: true,
  pull: { written: 0, deleted: 0, conflict: false },
  push: { mode: 'apply', failures: 0 },
};

interface BuildOptions {
  /** Env tunables (only the load-bearing ones are surfaced as overrides). */
  enabled?: boolean;
  serviceUserId?: string | undefined;
  maxDeletes?: number;
  remoteTemplate?: string | undefined;
  dataDir?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** A hook applied to the fake vault so a test can override its behaviour. */
  vaultOverrides?: Record<string, unknown>;
}

interface Built {
  orchestrator: GitSyncOrchestrator;
  env: Record<string, AnyMock>;
  dataSource: { bind: AnyMock };
  client: Record<string, AnyMock>;
  vaultRegistry: { getVault: AnyMock; vaultPath: AnyMock };
  vault: Record<string, AnyMock>;
  scheduler: Record<string, AnyMock>;
  redis: { set: AnyMock; eval: AnyMock };
  redisService: { getOrThrow: AnyMock };
  db: unknown;
}

function build(opts: BuildOptions = {}): Built {
  const {
    enabled = true,
    maxDeletes = 100,
    remoteTemplate = undefined,
    dataDir = '/vaults',
    pollIntervalMs = 15000,
    debounceMs = 2000,
    vaultOverrides = {},
  } = opts;
  // Distinguish "key omitted" (default to a valid id) from "key present but
  // undefined" (the no-service-user test deliberately sets it undefined).
  const serviceUserId = 'serviceUserId' in opts ? opts.serviceUserId : 'svc-user';

  const env: Record<string, AnyMock> = {
    isGitSyncEnabled: jest.fn(() => enabled),
    getGitSyncServiceUserId: jest.fn(() => serviceUserId),
    getGitSyncMaxDeletesPerCycle: jest.fn(() => maxDeletes),
    getGitSyncRemoteTemplate: jest.fn(() => remoteTemplate),
    getGitSyncDataDir: jest.fn(() => dataDir),
    getGitSyncPollIntervalMs: jest.fn(() => pollIntervalMs),
    getGitSyncDebounceMs: jest.fn(() => debounceMs),
  };

  // The read-side / write-side client the datasource hands back.
  const client: Record<string, AnyMock> = {
    listSpaceTree: jest.fn(async () => ({ pages: [], complete: true })),
    deletePage: jest.fn(async () => undefined),
    createPage: jest.fn(async () => undefined),
    updatePageBody: jest.fn(async () => undefined),
  };
  const dataSource = { bind: jest.fn(() => client) };

  // The fake VaultGit: every method the orchestrator calls is a jest.fn.
  const vault: Record<string, AnyMock> = {
    assertGitAvailable: jest.fn(async () => undefined),
    ensureRepo: jest.fn(async () => undefined),
    isMergeInProgress: jest.fn(async () => false),
    ensureBranch: jest.fn(async () => undefined),
    checkout: jest.fn(async () => undefined),
    listTrackedFiles: jest.fn(async () => []),
    ...(vaultOverrides as Record<string, AnyMock>),
  };
  const vaultRegistry = {
    getVault: jest.fn(async () => vault),
    vaultPath: jest.fn((spaceId: string) => `${dataDir}/${spaceId}`),
  };

  const scheduler: Record<string, AnyMock> = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  };

  const redis = {
    // Default: lock acquired. Tests override per-case.
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  };
  const redisService = { getOrThrow: jest.fn(() => redis) };

  // Chainable Kysely stub. `buildSettings` reads the space's
  // `gitSync.autoMergeConflicts` flag via
  // `selectFrom('spaces').select(...).where('id','=',id).executeTakeFirst()`;
  // default it to the SAFE off value. `enabledSpaces` uses `.execute()`.
  const db = (() => {
    const builder: any = {
      select: () => builder,
      where: () => builder,
      executeTakeFirst: async () => ({ autoMergeConflicts: false }),
      execute: async () => [],
    };
    return { selectFrom: () => builder };
  })();

  // The REAL SpaceLockService, constructed against the mock redis above, so all
  // existing lock assertions (lock-held, in-progress, leader lock, release CAS,
  // heartbeat) still exercise the same `redis.set`/`redis.eval` mock unchanged.
  const spaceLock = new SpaceLockService(redisService as any);

  const orchestrator = new GitSyncOrchestrator(
    env as any,
    dataSource as any,
    vaultRegistry as any,
    scheduler as any,
    spaceLock as any,
    db as any,
  );

  return {
    orchestrator,
    env,
    dataSource,
    client,
    vaultRegistry,
    vault,
    scheduler,
    redis,
    redisService,
    db,
  };
}

/** The engine runs a clean cycle by default. */
function primeEngineHappyPath(): void {
  runCycleMock.mockResolvedValue(OK_CYCLE);
}

/** Pull the `resolveApplyClient` hook out of the (single) runCycle call args. */
function lastResolveApplyClient(): (
  plannedDeletes: number,
  client: unknown,
) => unknown {
  const calls = runCycleMock.mock.calls;
  return calls[calls.length - 1][0].resolveApplyClient;
}

beforeEach(() => {
  jest.clearAllMocks();
  primeEngineHappyPath();
});

describe('GitSyncOrchestrator', () => {
  describe('runOnce gating', () => {
    it("short-circuits with skipped:'disabled' when git-sync is disabled", async () => {
      const { orchestrator, redis, vaultRegistry } = build({ enabled: false });
      const res = await orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({ spaceId: 'space-1', ran: false, skipped: 'disabled' });
      // No lock, no vault work performed.
      expect(redis.set).not.toHaveBeenCalled();
      expect(vaultRegistry.getVault).not.toHaveBeenCalled();
    });

    it("returns skipped:'no-service-user' when the service user id is falsy", async () => {
      const { orchestrator, redis } = build({ serviceUserId: undefined });
      const res = await orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'no-service-user',
      });
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('in-process mutex', () => {
    it("a second runOnce while the first is in-flight returns skipped:'in-progress'", async () => {
      const built = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Hang the first cycle inside driveCycle by stalling getVault.
      built.vaultRegistry.getVault.mockImplementationOnce(async () => {
        await gate;
        return built.vault;
      });

      const first = built.orchestrator.runOnce('space-1', 'ws-1');
      // Let the first call enter the running set + acquire the lock.
      await Promise.resolve();
      await Promise.resolve();

      const second = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(second).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'in-progress',
      });

      release();
      await first;
    });
  });

  describe('redis leader lock', () => {
    it("returns skipped:'lock-held' and cleans up the mutex when the lock is not acquired", async () => {
      const built = build();
      // First acquire fails (not 'OK'); a later acquire succeeds.
      built.redis.set
        .mockResolvedValueOnce(null)
        .mockResolvedValue('OK');

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'lock-held',
      });
      // The mutex must be clear: a subsequent call can acquire + run.
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
      expect(res2.skipped).toBeUndefined();
    });
  });

  describe('poisoned-space protection', () => {
    it('releases the lock and clears the mutex when the cycle throws, returning { error }', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      runCycleMock.mockRejectedValueOnce(new Error('boom'));

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res.ran).toBe(false);
      expect(res.error).toBe('boom');
      // CAS release was invoked (eval) and the space is no longer "running":
      expect(built.redis.eval).toHaveBeenCalledTimes(1);

      // A subsequent call can re-acquire (mutex cleared after the throw).
      runCycleMock.mockResolvedValue(OK_CYCLE);
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
    });
  });

  describe('cycle wiring', () => {
    it('drives runCycle with the space vault, the bound client, and settings', async () => {
      const built = build();
      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(runCycleMock).toHaveBeenCalledTimes(1);
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.spaceId).toBe('space-1');
      expect(deps.vault).toBe(built.vault);
      expect(deps.client).toBe(built.client);
      expect(deps.settings.vaultPath).toBe('/vaults/space-1');
      expect(typeof deps.resolveApplyClient).toBe('function');
      // The bound datasource identity is the (workspace, service-user) pair.
      expect(built.dataSource.bind).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        userId: 'svc-user',
      });
    });

    it("surfaces the engine's skipped status (e.g. merge-in-progress) verbatim", async () => {
      const built = build();
      runCycleMock.mockResolvedValue({ ran: false, skipped: 'merge-in-progress' });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'merge-in-progress',
      });
    });
  });

  describe('ingestExternalPush', () => {
    it('streams the receive-pack FIRST, then runs the Docmost cycle', async () => {
      const order: string[] = [];
      const built = build();
      runCycleMock.mockImplementation(async () => {
        order.push('cycle');
        return OK_CYCLE;
      });
      const runReceivePack = jest.fn(async () => {
        order.push('receive-pack');
      });

      await built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack);

      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // The cycle only runs AFTER the push commits land on main.
      expect(order).toEqual(['receive-pack', 'cycle']);
    });

    it('throws GitSyncLockHeldError and does NOT run the receive-pack when the lock is held', async () => {
      const built = build();
      built.redis.set.mockResolvedValue(null); // acquire fails → lock-held
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).rejects.toBeInstanceOf(GitSyncLockHeldError);

      // We must never write to the working tree concurrently with a cycle.
      expect(runReceivePack).not.toHaveBeenCalled();
      expect(runCycleMock).not.toHaveBeenCalled();
    });

    it('swallows a post-push cycle error (the push is durable; poll retries)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build();
      // The cycle throws AFTER the receive-pack already succeeded.
      runCycleMock.mockRejectedValueOnce(new Error('cycle boom'));
      const runReceivePack = jest.fn(async () => undefined);

      // Does NOT throw — the durable push must not be reported as failed.
      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).resolves.toBeUndefined();
      expect(runReceivePack).toHaveBeenCalledTimes(1);
      // Lock was still released (CAS eval) despite the cycle error.
      expect(built.redis.eval).toHaveBeenCalled();
    });

    it('runs the receive-pack but SKIPS the cycle when no service user is configured', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const built = build({ serviceUserId: undefined });
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).resolves.toBeUndefined();
      // The push is durable on main; the immediate cycle is skipped, not failed.
      expect(runReceivePack).toHaveBeenCalledTimes(1);
      expect(runCycleMock).not.toHaveBeenCalled();
    });

    it('refuses (LockHeldError) and runs nothing when git-sync is globally disabled', async () => {
      const built = build({ enabled: false });
      const runReceivePack = jest.fn(async () => undefined);

      await expect(
        built.orchestrator.ingestExternalPush('space-1', 'ws-1', runReceivePack),
      ).rejects.toBeInstanceOf(GitSyncLockHeldError);
      expect(runReceivePack).not.toHaveBeenCalled();
      expect(built.redis.set).not.toHaveBeenCalled();
    });
  });

  describe('delete cap (anti-data-loss)', () => {
    // The cap is now a POLICY the orchestrator injects as runCycle's
    // `resolveApplyClient` hook; the engine calls it with the dry-run's planned
    // delete count. We pull the hook out of the runCycle args and exercise it.
    it('suppresses deletePage (by throwing) when planned deletes exceed the cap', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const built = build({ maxDeletes: 5 });
      await built.orchestrator.runOnce('space-1', 'ws-1');

      const resolveApplyClient = lastResolveApplyClient();
      const applyClient = resolveApplyClient(9, built.client) as any;
      // deletePage is still a function (the engine calls it)...
      expect(typeof applyClient.deletePage).toBe('function');
      // ...but it THROWS, so the engine records a per-page failure and holds
      // `last-pushed` (a resolving no-op would advance past the dropped deletes
      // and never replay them — PR #119 review). The real deletePage is NOT hit.
      await expect(applyClient.deletePage('p1')).rejects.toThrow(/suppress/i);
      expect(built.client.deletePage).not.toHaveBeenCalled();
      // Creates/updates pass through to the real client.
      expect(applyClient.createPage).toBe(built.client.createPage);
    });

    it('fails safe: an Infinity planned-delete count (dry-run failed) is suppressed', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const built = build({ maxDeletes: 5 });
      await built.orchestrator.runOnce('space-1', 'ws-1');

      // runCycle passes Number.POSITIVE_INFINITY when its dry-run planning threw;
      // Infinity > cap → suppress (same throwing path).
      const resolveApplyClient = lastResolveApplyClient();
      const applyClient = resolveApplyClient(
        Number.POSITIVE_INFINITY,
        built.client,
      ) as any;
      await expect(applyClient.deletePage('p1')).rejects.toThrow(/suppress/i);
      expect(built.client.deletePage).not.toHaveBeenCalled();
    });

    it('passes through the original client when planned deletes are within the cap', async () => {
      const built = build({ maxDeletes: 5 });
      await built.orchestrator.runOnce('space-1', 'ws-1');

      const resolveApplyClient = lastResolveApplyClient();
      const applyClient = resolveApplyClient(3, built.client) as any;
      // The ORIGINAL client is used (deletePage forwards to the real one).
      expect(applyClient).toBe(built.client);
      await applyClient.deletePage('p1');
      expect(built.client.deletePage).toHaveBeenCalledWith('p1');
    });
  });

  describe('remote template substitution', () => {
    it('substitutes {spaceId} into the gitRemote settings handed to the engine', async () => {
      const built = build({ remoteTemplate: 'git@h:vault-{spaceId}.git' });
      await built.orchestrator.runOnce('space-42', 'ws-1');
      const [deps] = runCycleMock.mock.calls[0];
      expect(deps.settings.gitRemote).toBe('git@h:vault-space-42.git');
    });
  });

  describe('module lifecycle', () => {
    it('registers exactly one interval on init and tears it down idempotently on destroy', () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      built.orchestrator.onModuleInit();
      expect(built.scheduler.addInterval).toHaveBeenCalledTimes(1);
      const [name] = built.scheduler.addInterval.mock.calls[0];

      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
      expect(built.scheduler.deleteInterval).toHaveBeenCalledWith(name);

      // A second destroy is a no-op (guard against double-delete).
      built.orchestrator.onModuleDestroy();
      expect(built.scheduler.deleteInterval).toHaveBeenCalledTimes(1);
    });

    it('registers nothing on init when git-sync is disabled', () => {
      const built = build({ enabled: false });
      built.orchestrator.onModuleInit();
      expect(built.scheduler.addInterval).not.toHaveBeenCalled();
    });
  });
});
