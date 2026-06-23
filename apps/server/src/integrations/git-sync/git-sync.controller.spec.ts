// Unit tests for the ops/testing controller. The orchestrator, env,
// and the workspace-ability factory are hand-built mocks. We assert the admin
// guard (non-admin -> ForbiddenException, no orchestrator call), that trigger
// uses the workspace from request context (never the body), and that status
// returns the env-derived object.
import { ForbiddenException } from '@nestjs/common';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { GitSyncController } from './git-sync.controller';

type AnyMock = jest.Mock;

interface Built {
  controller: GitSyncController;
  orchestrator: { runOnce: AnyMock };
  env: Record<string, AnyMock>;
  workspaceAbility: { createForUser: AnyMock };
  ability: { cannot: AnyMock };
}

function build(opts: { cannot?: boolean } = {}): Built {
  const { cannot = false } = opts;
  const ability = { cannot: jest.fn(() => cannot) };
  const workspaceAbility = { createForUser: jest.fn(() => ability) };

  const orchestrator = {
    runOnce: jest.fn(async () => ({ spaceId: 'space-1', ran: true })),
  };
  const env: Record<string, AnyMock> = {
    isGitSyncEnabled: jest.fn(() => true),
    getGitSyncDataDir: jest.fn(() => '/vaults'),
    getGitSyncPollIntervalMs: jest.fn(() => 15000),
    getGitSyncDebounceMs: jest.fn(() => 2000),
    getGitSyncServiceUserId: jest.fn(() => 'svc-user'),
  };

  const controller = new GitSyncController(
    orchestrator as any,
    env as any,
    workspaceAbility as any,
  );
  return { controller, orchestrator, env, workspaceAbility, ability };
}

const USER = { id: 'user-1' } as any;
const WORKSPACE = { id: 'ctx-ws' } as any;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GitSyncController', () => {
  describe('trigger', () => {
    it('blocks a non-admin: throws ForbiddenException and never calls runOnce', async () => {
      const { controller, orchestrator, ability } = build({ cannot: true });

      await expect(
        controller.trigger({ spaceId: 'space-1' } as any, USER, WORKSPACE),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(ability.cannot).toHaveBeenCalledWith(
        WorkspaceCaslAction.Manage,
        WorkspaceCaslSubject.Settings,
      );
      expect(orchestrator.runOnce).not.toHaveBeenCalled();
    });

    it('admin: calls runOnce(dto.spaceId, workspace.id) using the workspace from context', async () => {
      const { controller, orchestrator } = build({ cannot: false });

      // The body carries an attacker-controlled workspaceId that must be ignored.
      const res = await controller.trigger(
        { spaceId: 'space-1', workspaceId: 'evil-ws' } as any,
        USER,
        WORKSPACE,
      );

      expect(orchestrator.runOnce).toHaveBeenCalledWith('space-1', 'ctx-ws');
      expect(res).toEqual({ spaceId: 'space-1', ran: true });
    });
  });

  describe('status', () => {
    it('blocks a non-admin: throws ForbiddenException and never reads env', async () => {
      const { controller, env, ability } = build({ cannot: true });

      await expect(controller.status(USER, WORKSPACE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(ability.cannot).toHaveBeenCalledWith(
        WorkspaceCaslAction.Manage,
        WorkspaceCaslSubject.Settings,
      );
      // The admin guard short-circuits before the env-derived status is built.
      expect(env.isGitSyncEnabled).not.toHaveBeenCalled();
    });

    it('admin: returns the env-derived status object', async () => {
      const { controller } = build({ cannot: false });

      const res = await controller.status(USER, WORKSPACE);

      expect(res).toEqual({
        enabled: true,
        dataDir: '/vaults',
        pollIntervalMs: 15000,
        debounceMs: 2000,
        serviceUserConfigured: true,
      });
    });
  });
});
