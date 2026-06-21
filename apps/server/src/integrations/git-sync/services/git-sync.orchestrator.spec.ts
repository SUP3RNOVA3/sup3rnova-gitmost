// Unit tests for the git-sync control plane (plan §9/§10/§11). The vendored
// engine (@docmost/git-sync) is fully mocked so we exercise ONLY the
// orchestrator's wiring: gating, the Redis leader lock + in-process mutex,
// the pull/push call order, the delete-cap anti-data-loss guard, the remote
// template substitution, and the idempotent interval lifecycle.
//
// The engine mock must be declared before importing the orchestrator so the
// module-graph import binds to the mocked functions (same idiom as the
// datasource spec's top-of-file jest.mock stubs that avoid the React graph).
jest.mock('@docmost/git-sync', () => ({
  readExisting: jest.fn(),
  computePullActions: jest.fn(),
  applyPullActions: jest.fn(),
  runPush: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import {
  readExisting,
  computePullActions,
  applyPullActions,
  runPush,
} from '@docmost/git-sync';
import { GitSyncOrchestrator } from './git-sync.orchestrator';

type AnyMock = jest.Mock;

const readExistingMock = readExisting as unknown as AnyMock;
const computePullActionsMock = computePullActions as unknown as AnyMock;
const applyPullActionsMock = applyPullActions as unknown as AnyMock;
const runPushMock = runPush as unknown as AnyMock;

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

  const db = {};

  const orchestrator = new GitSyncOrchestrator(
    env as any,
    dataSource as any,
    vaultRegistry as any,
    scheduler as any,
    redisService as any,
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

/** Reasonable engine defaults so a happy-path driveCycle completes. */
function primeEngineHappyPath(): void {
  readExistingMock.mockResolvedValue({});
  computePullActionsMock.mockReturnValue({ creates: [], updates: [], deletes: [] });
  applyPullActionsMock.mockResolvedValue({
    written: 0,
    deleted: 0,
    merge: { conflict: false },
  });
  runPushMock.mockResolvedValue({ mode: 'apply', failures: [], planned: { deletes: 0 } });
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
    it('releases the lock and clears the mutex when driveCycle throws, returning { error }', async () => {
      const built = build();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // Make the real apply runPush reject; dry-run still resolves first.
      runPushMock
        .mockResolvedValueOnce({ mode: 'apply', failures: [], planned: { deletes: 0 } })
        .mockRejectedValueOnce(new Error('boom'));

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res.ran).toBe(false);
      expect(res.error).toBe('boom');
      // CAS release was invoked (eval) and the space is no longer "running":
      expect(built.redis.eval).toHaveBeenCalledTimes(1);

      // A subsequent call can re-acquire (mutex cleared after the throw).
      runPushMock.mockResolvedValue({ mode: 'apply', failures: [], planned: { deletes: 0 } });
      const res2 = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res2.ran).toBe(true);
    });
  });

  describe('merge-in-progress guard', () => {
    it("returns skipped:'merge-in-progress' and runs no pull/push", async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const built = build({ vaultOverrides: { isMergeInProgress: jest.fn(async () => true) } });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res).toEqual({
        spaceId: 'space-1',
        ran: false,
        skipped: 'merge-in-progress',
      });
      expect(applyPullActionsMock).not.toHaveBeenCalled();
      expect(runPushMock).not.toHaveBeenCalled();
    });
  });

  describe('cycle order', () => {
    it('runs ensureRepo -> ensureBranch(docmost,main) -> checkout(docmost) -> applyPullActions in order', async () => {
      const order: string[] = [];
      const built = build({
        vaultOverrides: {
          ensureRepo: jest.fn(async () => {
            order.push('ensureRepo');
          }),
          ensureBranch: jest.fn(async (branch: string, base: string) => {
            order.push(`ensureBranch:${branch}:${base}`);
          }),
          checkout: jest.fn(async (branch: string) => {
            order.push(`checkout:${branch}`);
          }),
        },
      });
      applyPullActionsMock.mockImplementation(async () => {
        order.push('applyPullActions');
        return { written: 0, deleted: 0, merge: { conflict: false } };
      });

      await built.orchestrator.runOnce('space-1', 'ws-1');

      expect(order).toEqual([
        'ensureRepo',
        'ensureBranch:docmost:main',
        'checkout:docmost',
        'applyPullActions',
      ]);
    });
  });

  describe('delete cap (anti-data-loss)', () => {
    it('neutralizes deletePage on the apply client when planned deletes exceed the cap', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const built = build({ maxDeletes: 5 });
      // Dry-run plans 9 deletes (over the cap of 5); apply still runs.
      runPushMock
        .mockResolvedValueOnce({ mode: 'plan', failures: [], planned: { deletes: 9 } })
        .mockResolvedValueOnce({ mode: 'apply', failures: [], planned: { deletes: 0 } });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      expect(res.ran).toBe(true);
      expect(runPushMock).toHaveBeenCalledTimes(2);

      // The second runPush (real apply, dryRun:false) got a neutralized client.
      const [applyDeps, applyOpts] = runPushMock.mock.calls[1];
      expect(applyOpts).toEqual({ dryRun: false });
      const applyClient = applyDeps.makeClient();
      // deletePage is still a function (the engine may call it)...
      expect(typeof applyClient.deletePage).toBe('function');
      await applyClient.deletePage('p1');
      // ...but it is a NO-OP: the underlying real deletePage was NOT invoked.
      expect(built.client.deletePage).not.toHaveBeenCalled();
      // Creates/updates pass through to the real client.
      expect(applyClient.createPage).toBe(built.client.createPage);
    });

    it('fails safe: a throwing dry-run still suppresses deletes and does not throw', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const built = build({ maxDeletes: 5 });
      runPushMock
        .mockRejectedValueOnce(new Error('plan failed'))
        .mockResolvedValueOnce({ mode: 'apply', failures: [], planned: { deletes: 0 } });

      const res = await built.orchestrator.runOnce('space-1', 'ws-1');
      // The cycle still completes (ran:true), it does NOT throw.
      expect(res.ran).toBe(true);
      const [applyDeps] = runPushMock.mock.calls[1];
      const applyClient = applyDeps.makeClient();
      await applyClient.deletePage('p1');
      expect(built.client.deletePage).not.toHaveBeenCalled();
    });

    it('passes through the original client when planned deletes are within the cap', async () => {
      const built = build({ maxDeletes: 5 });
      runPushMock
        .mockResolvedValueOnce({ mode: 'plan', failures: [], planned: { deletes: 3 } })
        .mockResolvedValueOnce({ mode: 'apply', failures: [], planned: { deletes: 0 } });

      await built.orchestrator.runOnce('space-1', 'ws-1');
      const [applyDeps] = runPushMock.mock.calls[1];
      const applyClient = applyDeps.makeClient();
      // The ORIGINAL client is used (deletePage forwards to the real one).
      expect(applyClient).toBe(built.client);
      await applyClient.deletePage('p1');
      expect(built.client.deletePage).toHaveBeenCalledWith('p1');
    });
  });

  describe('remote template substitution', () => {
    it('substitutes {spaceId} into the gitRemote handed to runPush', async () => {
      const built = build({ remoteTemplate: 'git@h:vault-{spaceId}.git' });
      await built.orchestrator.runOnce('space-42', 'ws-1');
      // Inspect the settings on the dry-run call (first runPush).
      const [dryDeps] = runPushMock.mock.calls[0];
      expect(dryDeps.settings.gitRemote).toBe('git@h:vault-space-42.git');
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
