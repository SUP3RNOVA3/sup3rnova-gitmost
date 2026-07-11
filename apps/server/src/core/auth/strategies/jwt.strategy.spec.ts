import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { JwtType } from '../dto/jwt-payload';

/**
 * Provenance derivation in JwtStrategy.validate (jwt.strategy.ts).
 *
 * The strategy must derive the agent-edit provenance from the SIGNED server-side
 * identity, never from a client-controlled field. The security invariant under
 * test: a user flagged is_agent stamps 'agent'; an ordinary user resolves to
 * 'user'; and an `actor` claim in the token CANNOT escalate a non-agent user
 * past the existing internal-AI-chat claim semantics (anti-spoof — a plain user
 * cannot obtain created_source='agent').
 *
 * The strategy is constructed directly with stub deps. The PassportStrategy base
 * only needs a secret at construction time; validate() is exercised on its own.
 */
describe('JwtStrategy — provenance derivation', () => {
  function makeStrategy(user: any) {
    const userRepo: any = { findById: jest.fn(async () => user) };
    const workspaceRepo: any = { findById: jest.fn(async () => ({ id: 'ws-1' })) };
    const userSessionRepo: any = { findActiveById: jest.fn() };
    const sessionActivityService: any = { trackActivity: jest.fn() };
    const environmentService: any = { getAppSecret: () => 'test-secret' };
    const moduleRef: any = {};

    const strategy = new JwtStrategy(
      userRepo,
      workspaceRepo,
      userSessionRepo,
      sessionActivityService,
      environmentService,
      moduleRef,
    );
    return { strategy, userRepo };
  }

  // A bare request whose `raw` collects the provenance the strategy stamps.
  const makeReq = () => ({ raw: {} as Record<string, any> });

  const accessPayload = (over?: Record<string, any>) => ({
    sub: 'user-1',
    email: 'u@test.local',
    workspaceId: 'ws-1',
    type: JwtType.ACCESS,
    ...over,
  });

  it("stamps actor='agent' for an is_agent user (derived from the signed identity)", async () => {
    const { strategy, userRepo } = makeStrategy({
      id: 'user-1',
      isAgent: true,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req = makeReq();

    await strategy.validate(req, accessPayload() as any);

    expect(req.raw.actor).toBe('agent');
    // External MCP agent: no internal ai_chats row → null.
    expect(req.raw.aiChatId).toBeNull();
    // Wiring guard (#143): the seam MUST opt into the isAgent flag, otherwise
    // findById omits it (it is not in baseFields) and provenance silently
    // degrades to 'user'.
    expect(userRepo.findById).toHaveBeenCalledWith(
      'user-1',
      'ws-1',
      expect.objectContaining({ includeIsAgent: true }),
    );
  });

  it("stamps actor='user' for an ordinary user", async () => {
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: false,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req = makeReq();

    await strategy.validate(req, accessPayload() as any);

    expect(req.raw.actor).toBe('user');
    expect(req.raw.aiChatId).toBeNull();
  });

  it("honors a SIGNED actor='agent' claim on a non-agent user's token (the internal AI-chat path)", async () => {
    // A non-agent user (the plain no-claim → 'user' case is covered above). A
    // token that DOES carry actor='agent' resolves to 'agent' — BY DESIGN: that
    // claim can only exist on a SERVER-MINTED provenance token (the internal AI
    // chat), never on a plain login token, because the token is signed with the
    // app secret. The guarantee is that a client cannot FORGE this signed claim,
    // not that the strategy ignores it. (A plain user still cannot obtain
    // 'agent' — they have no way to get such a token.)
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: false,
      deactivatedAt: null,
      deletedAt: null,
    });
    const req2 = makeReq();
    await strategy.validate(req2, accessPayload({ actor: 'agent', aiChatId: 'chat-1' }) as any);
    expect(req2.raw.actor).toBe('agent');
    expect(req2.raw.aiChatId).toBe('chat-1');
  });

  it('rejects a disabled is_agent user (Unauthorized) before stamping provenance', async () => {
    const { strategy } = makeStrategy({
      id: 'user-1',
      isAgent: true,
      deactivatedAt: new Date('2026-01-01'),
      deletedAt: null,
    });
    const req = makeReq();

    await expect(strategy.validate(req, accessPayload() as any)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(req.raw.actor).toBeUndefined();
  });
});

/**
 * Provenance derivation on the API-KEY path (jwt.strategy.validateApiKey, #486).
 *
 * The access-token path stamped provenance; the API-key path returned early
 * WITHOUT it, so an is_agent API key's REST writes recorded no 'agent' marker.
 * The API-key payload carries no signed claim, so provenance is resolved from the
 * SERVER-SIDE user returned by ApiKeyService.validateApiKey: isAgent -> 'agent',
 * otherwise 'user'; aiChatId is always null (an API key has no ai_chats row).
 *
 * The enterprise ApiKeyService is not bundled in the OSS build, so the strategy
 * loads it through an overridable `resolveApiKeyService` seam that we stub here.
 */
describe('JwtStrategy — API-key provenance derivation (#486)', () => {
  function makeApiKeyStrategy(validateApiKeyImpl: (p: any) => Promise<any>) {
    const userRepo: any = { findById: jest.fn() };
    const workspaceRepo: any = { findById: jest.fn() };
    const userSessionRepo: any = { findActiveById: jest.fn() };
    const sessionActivityService: any = { trackActivity: jest.fn() };
    const environmentService: any = { getAppSecret: () => 'test-secret' };
    const moduleRef: any = {};

    const strategy = new JwtStrategy(
      userRepo,
      workspaceRepo,
      userSessionRepo,
      sessionActivityService,
      environmentService,
      moduleRef,
    );
    // Stub the EE ApiKeyService seam (the real module is not in the OSS build).
    const validateApiKey = jest.fn(validateApiKeyImpl);
    jest
      .spyOn(strategy as any, 'resolveApiKeyService')
      .mockReturnValue({ validateApiKey });
    return { strategy, validateApiKey };
  }

  const makeReq = () => ({ raw: {} as Record<string, any> });
  const apiKeyPayload = () => ({
    sub: 'svc-1',
    workspaceId: 'ws-1',
    apiKeyId: 'key-1',
    type: JwtType.API_KEY,
  });

  it("stamps actor='agent' for an is_agent API key (from the validated user)", async () => {
    const validated = {
      user: { id: 'svc-1', isAgent: true },
      workspace: { id: 'ws-1' },
    };
    const { strategy, validateApiKey } = makeApiKeyStrategy(
      async () => validated,
    );
    const req = makeReq();

    const result = await strategy.validate(req, apiKeyPayload() as any);

    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(req.raw.actor).toBe('agent');
    // API keys carry no internal ai_chats row -> null.
    expect(req.raw.aiChatId).toBeNull();
    // The validated auth object is returned unchanged (req.user shape preserved).
    expect(result).toBe(validated);
  });

  it("stamps actor='user' for an ordinary (non-agent) API key", async () => {
    const { strategy } = makeApiKeyStrategy(async () => ({
      user: { id: 'u-1', isAgent: false },
      workspace: { id: 'ws-1' },
    }));
    const req = makeReq();

    await strategy.validate(req, apiKeyPayload() as any);

    expect(req.raw.actor).toBe('user');
    expect(req.raw.aiChatId).toBeNull();
  });

  it('throws Unauthorized (and stamps nothing) when the EE module is missing', async () => {
    const userRepo: any = { findById: jest.fn() };
    const strategy = new JwtStrategy(
      userRepo,
      { findById: jest.fn() } as any,
      { findActiveById: jest.fn() } as any,
      { trackActivity: jest.fn() } as any,
      { getAppSecret: () => 'test-secret' } as any,
      {} as any,
    );
    // EE not bundled: the seam returns null.
    jest.spyOn(strategy as any, 'resolveApiKeyService').mockReturnValue(null);
    const req = makeReq();

    await expect(
      strategy.validate(req, apiKeyPayload() as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(req.raw.actor).toBeUndefined();
  });
});
