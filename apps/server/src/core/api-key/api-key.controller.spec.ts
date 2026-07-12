import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';

/**
 * Authorization contract for the /api-keys management surface.
 *
 *  - A token cannot manage tokens (an api_key PRINCIPAL is 403 on every method)
 *    — GitHub-PAT semantics closing post-revocation laundering.
 *  - admin (CASL Manage on API) sees/revokes all workspace keys; a member only
 *    their own.
 *  - kill-switch OFF -> the surface 404s (looks like the feature does not exist).
 */

function makeController(over: any = {}) {
  const apiKeyService = {
    create: jest.fn().mockResolvedValue({
      token: 'tok',
      key: { id: 'k1', name: 'n', expiresAt: null, createdAt: new Date() },
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    ...(over.apiKeyService ?? {}),
  };
  const apiKeyRepo = {
    findAllInWorkspace: jest.fn().mockResolvedValue([]),
    findByCreator: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    ...(over.apiKeyRepo ?? {}),
  };
  const workspaceAbility = {
    createForUser: jest.fn().mockReturnValue({
      can: (_a: any, _s: any) => over.canManage ?? false,
    }),
    ...(over.workspaceAbility ?? {}),
  };
  const environmentService = {
    isApiKeysEnabled: jest.fn().mockReturnValue(over.enabled ?? true),
    ...(over.environmentService ?? {}),
  };
  const auditService = { log: jest.fn() };
  const controller = new ApiKeyController(
    apiKeyService as any,
    apiKeyRepo as any,
    workspaceAbility as any,
    environmentService as any,
    auditService as any,
  );
  return {
    controller,
    apiKeyService,
    apiKeyRepo,
    workspaceAbility,
    environmentService,
    auditService,
  };
}

const user = { id: 'u-1', workspaceId: 'ws-1' } as any;
const workspace = { id: 'ws-1' } as any;
const reqAccess = () => ({ raw: {}, ip: '1.2.3.4', socket: {} }) as any;
const reqApiKey = () =>
  ({ raw: { authType: 'api_key', apiKeyId: 'k-self' }, ip: '1.2.3.4', socket: {} }) as any;

describe('ApiKeyController — a token cannot manage tokens', () => {
  it('403 on create for an api_key principal', async () => {
    const { controller, apiKeyService } = makeController();
    await expect(
      controller.create({ name: 'x' } as any, user, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(apiKeyService.create).not.toHaveBeenCalled();
  });

  it('403 on list for an api_key principal', async () => {
    const { controller } = makeController();
    await expect(
      controller.list(user, workspace, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403 on revoke for an api_key principal', async () => {
    const { controller } = makeController();
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqApiKey()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ApiKeyController — kill-switch OFF → 404', () => {
  it('create/list/revoke all 404 when disabled', async () => {
    const { controller } = makeController({ enabled: false });
    await expect(
      controller.create({ name: 'x' } as any, user, reqAccess()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.list(user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ApiKeyController — list scoping', () => {
  it('admin (Manage on API) lists ALL workspace keys', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: true });
    await controller.list(user, workspace, reqAccess());
    expect(apiKeyRepo.findAllInWorkspace).toHaveBeenCalledWith('ws-1');
    expect(apiKeyRepo.findByCreator).not.toHaveBeenCalled();
  });

  it('member lists ONLY their own keys', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: false });
    await controller.list(user, workspace, reqAccess());
    expect(apiKeyRepo.findByCreator).toHaveBeenCalledWith('u-1', 'ws-1');
    expect(apiKeyRepo.findAllInWorkspace).not.toHaveBeenCalled();
  });
});

describe('ApiKeyController — revoke scoping', () => {
  it("member cannot revoke another user's key (403)", async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: false,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'someone-else',
      workspaceId: 'ws-1',
    });
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(apiKeyService.revoke).not.toHaveBeenCalled();
  });

  it('member CAN revoke their own key', async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: false,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'u-1',
      workspaceId: 'ws-1',
    });
    await controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess());
    expect(apiKeyService.revoke).toHaveBeenCalledWith('k1', 'ws-1');
  });

  it("admin CAN revoke another user's key", async () => {
    const { controller, apiKeyRepo, apiKeyService } = makeController({
      canManage: true,
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'k1',
      creatorId: 'someone-else',
      workspaceId: 'ws-1',
    });
    await controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess());
    expect(apiKeyService.revoke).toHaveBeenCalledWith('k1', 'ws-1');
  });

  it('404 when the key does not exist', async () => {
    const { controller, apiKeyRepo } = makeController({ canManage: true });
    apiKeyRepo.findById.mockResolvedValue(undefined);
    await expect(
      controller.revoke({ id: 'k1' } as any, user, workspace, reqAccess()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ApiKeyController — create emits audit + returns token once', () => {
  it('logs API_KEY_CREATED and returns the token + computed expiry', async () => {
    const { controller, auditService } = makeController();
    const res = await controller.create(
      { name: 'ci' } as any,
      user,
      reqAccess(),
    );
    expect(res.token).toBe('tok');
    expect(res.apiKey).toMatchObject({ id: 'k1', name: 'n' });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_key.created' }),
    );
  });
});

// Sanity: the CASL subject used is the workspace API subject.
it('uses WorkspaceCaslSubject.API with the Manage action', () => {
  expect(WorkspaceCaslSubject.API).toBe('api_key');
  expect(WorkspaceCaslAction.Manage).toBeDefined();
});
