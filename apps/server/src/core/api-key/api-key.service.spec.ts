import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { JwtType } from '../auth/dto/jwt-payload';

/**
 * Security contract for ApiKeyService.validate — the single validator shared by
 * jwt.strategy (REST) and the /mcp Bearer router.
 *
 * Invariants under test:
 *  - Anti-enumeration: every DEFINITE deny (missing/revoked/expired row, disabled
 *    user, workspace mismatch, kill-switch off) throws the SAME bare
 *    UnauthorizedException — an agent cannot distinguish expired from revoked.
 *  - deny-on-decision / 5xx-on-infra: an UNEXPECTED (infra) error PROPAGATES as
 *    itself (→ 5xx), never masked as a 401.
 *  - Expiry is read from the ROW, never a JWT exp claim.
 *  - No validate cache (each call re-reads the row → immediate revocation).
 */

const APP_SECRET = 'secret';

function makeDeps(over: Partial<Record<string, any>> = {}) {
  const apiKeyRepo = {
    findById: jest.fn(),
    insert: jest.fn(),
    softDelete: jest.fn(),
    touchLastUsed: jest.fn().mockResolvedValue(undefined),
    ...(over.apiKeyRepo ?? {}),
  };
  const userRepo = {
    findById: jest.fn(),
    ...(over.userRepo ?? {}),
  };
  const workspaceRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'ws-1' }),
    ...(over.workspaceRepo ?? {}),
  };
  const tokenService = {
    generateApiToken: jest.fn().mockResolvedValue('minted.jwt.token'),
    ...(over.tokenService ?? {}),
  };
  const environmentService = {
    isApiKeysEnabled: jest.fn().mockReturnValue(true),
    getApiKeysEnabledRaw: jest.fn().mockReturnValue(undefined),
    getAppSecret: jest.fn().mockReturnValue(APP_SECRET),
    ...(over.environmentService ?? {}),
  };
  const service = new (ApiKeyService as unknown as new (...a: any[]) => ApiKeyService)(
    apiKeyRepo,
    userRepo,
    workspaceRepo,
    tokenService,
    environmentService,
  );
  return { service, apiKeyRepo, userRepo, workspaceRepo, tokenService, environmentService };
}

const payload = (over: Record<string, any> = {}) => ({
  sub: 'u-1',
  workspaceId: 'ws-1',
  apiKeyId: 'key-1',
  type: JwtType.API_KEY,
  ...over,
});

const activeRow = (over: Record<string, any> = {}) => ({
  id: 'key-1',
  name: 'k',
  creatorId: 'u-1',
  workspaceId: 'ws-1',
  expiresAt: null,
  lastUsedAt: null,
  deletedAt: null,
  ...over,
});

const activeUser = (over: Record<string, any> = {}) => ({
  id: 'u-1',
  workspaceId: 'ws-1',
  deactivatedAt: null,
  deletedAt: null,
  isAgent: false,
  ...over,
});

describe('ApiKeyService.validate', () => {
  it('returns { user, workspace } for a valid active key', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    userRepo.findById.mockResolvedValue(activeUser());

    const res = await service.validate(payload() as any);

    expect(res.user).toMatchObject({ id: 'u-1' });
    expect(res.workspace).toMatchObject({ id: 'ws-1' });
    // Loads isAgent so downstream provenance does not silently degrade.
    expect(userRepo.findById).toHaveBeenCalledWith('u-1', 'ws-1', {
      includeIsAgent: true,
    });
  });

  // --- Anti-enumeration: every deny is the SAME bare 401 -------------------
  const denyCases: Array<[string, (d: ReturnType<typeof makeDeps>) => void]> = [
    [
      'missing/orphaned row',
      (d) => d.apiKeyRepo.findById.mockResolvedValue(undefined),
    ],
    [
      'revoked (soft-deleted → findById returns undefined)',
      (d) => d.apiKeyRepo.findById.mockResolvedValue(undefined),
    ],
    [
      'expired (expires_at in the past)',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(
          activeRow({ expiresAt: new Date(Date.now() - 1000) }),
        );
        d.userRepo.findById.mockResolvedValue(activeUser());
      },
    ],
    [
      'disabled user',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(
          activeUser({ deactivatedAt: new Date() }),
        );
      },
    ],
    [
      'user not found',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(undefined);
      },
    ],
    [
      'creator/sub mismatch',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow({ creatorId: 'other' }));
        d.userRepo.findById.mockResolvedValue(activeUser());
      },
    ],
    [
      'workspace row missing',
      (d) => {
        d.apiKeyRepo.findById.mockResolvedValue(activeRow());
        d.userRepo.findById.mockResolvedValue(activeUser());
        d.workspaceRepo.findById.mockResolvedValue(undefined);
      },
    ],
    [
      'kill-switch OFF',
      (d) => d.environmentService.isApiKeysEnabled.mockReturnValue(false),
    ],
    [
      'malformed payload (missing apiKeyId)',
      () => undefined,
    ],
  ];

  it.each(denyCases)(
    'throws a bare UnauthorizedException with NO message for: %s',
    async (label, arrange) => {
      const deps = makeDeps();
      arrange(deps);
      const p =
        label === 'malformed payload (missing apiKeyId)'
          ? (payload({ apiKeyId: undefined }) as any)
          : (payload() as any);

      const err = await deps.service.validate(p).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Anti-enumeration: identical, class-less message for every failure mode.
      expect(err.message).toBe('Unauthorized');
    },
  );

  it('kill-switch OFF denies BEFORE any DB read', async () => {
    const { service, apiKeyRepo, environmentService } = makeDeps();
    environmentService.isApiKeysEnabled.mockReturnValue(false);

    await expect(service.validate(payload() as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.findById).not.toHaveBeenCalled();
  });

  // --- Infra error propagates (5xx), NOT masked as 401 ---------------------
  it('PROPAGATES an infra (DB) error instead of masking it as 401', async () => {
    const { service, apiKeyRepo } = makeDeps();
    const boom = new Error('connection terminated');
    apiKeyRepo.findById.mockRejectedValue(boom);

    await expect(service.validate(payload() as any)).rejects.toBe(boom);
  });

  // --- No cache: revocation is immediate on the next call ------------------
  it('re-reads the row on every call (no validate cache → immediate revocation)', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow());
    userRepo.findById.mockResolvedValue(activeUser());
    await service.validate(payload() as any);

    // Now the key is revoked (row invisible) — the very next call denies.
    apiKeyRepo.findById.mockResolvedValue(undefined);
    await expect(service.validate(payload() as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.findById).toHaveBeenCalledTimes(2);
  });

  // --- last_used_at is throttled + fire-and-forget -------------------------
  it('touches last_used_at when stale and skips when fresh', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    userRepo.findById.mockResolvedValue(activeUser());

    // Stale (never used) -> touch.
    apiKeyRepo.findById.mockResolvedValue(activeRow({ lastUsedAt: null }));
    await service.validate(payload() as any);
    expect(apiKeyRepo.touchLastUsed).toHaveBeenCalledTimes(1);

    // Fresh (used 1 minute ago) -> skip.
    apiKeyRepo.touchLastUsed.mockClear();
    apiKeyRepo.findById.mockResolvedValue(
      activeRow({ lastUsedAt: new Date(Date.now() - 60_000) }),
    );
    await service.validate(payload() as any);
    expect(apiKeyRepo.touchLastUsed).not.toHaveBeenCalled();
  });

  it('a failing last_used_at touch never fails the request', async () => {
    const { service, apiKeyRepo, userRepo } = makeDeps();
    apiKeyRepo.findById.mockResolvedValue(activeRow({ lastUsedAt: null }));
    userRepo.findById.mockResolvedValue(activeUser());
    apiKeyRepo.touchLastUsed.mockRejectedValue(new Error('write failed'));

    await expect(service.validate(payload() as any)).resolves.toMatchObject({
      user: { id: 'u-1' },
    });
  });
});

describe('ApiKeyService.create (mint-then-insert, no exp)', () => {
  it('mints the JWT BEFORE inserting the row and returns the token once', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    const order: string[] = [];
    tokenService.generateApiToken.mockImplementation(async () => {
      order.push('mint');
      return 'tok';
    });
    apiKeyRepo.insert.mockImplementation(async (row: any) => {
      order.push('insert');
      return { ...row, createdAt: new Date() };
    });

    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;
    const res = await service.create(user, 'my key');

    expect(order).toEqual(['mint', 'insert']);
    expect(res.token).toBe('tok');
    // The id is generated before minting and reused for the row.
    const mintArg = tokenService.generateApiToken.mock.calls[0][0];
    const insertArg = apiKeyRepo.insert.mock.calls[0][0];
    expect(mintArg.apiKeyId).toBe(insertArg.id);
  });

  it('applies the 1-year default when expiresAt is undefined', async () => {
    const { service, apiKeyRepo } = makeDeps();
    apiKeyRepo.insert.mockImplementation(async (row: any) => row);
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await service.create(user, 'k');

    const insertArg = apiKeyRepo.insert.mock.calls[0][0];
    const days =
      (insertArg.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(367);
  });

  it('honors an explicit null (unlimited)', async () => {
    const { service, apiKeyRepo } = makeDeps();
    apiKeyRepo.insert.mockImplementation(async (row: any) => row);
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await service.create(user, 'k', null);

    expect(apiKeyRepo.insert.mock.calls[0][0].expiresAt).toBeNull();
  });

  it('does NOT insert a row when minting fails (mint-then-insert → inert)', async () => {
    const { service, apiKeyRepo, tokenService } = makeDeps();
    tokenService.generateApiToken.mockRejectedValue(new Error('mint failed'));
    const user = { id: 'u-1', workspaceId: 'ws-1' } as any;

    await expect(service.create(user, 'k')).rejects.toThrow('mint failed');
    expect(apiKeyRepo.insert).not.toHaveBeenCalled();
  });
});
