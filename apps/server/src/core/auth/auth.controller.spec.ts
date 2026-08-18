import { AuthController } from './auth.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the injected dependency tokens (e.g. AUDIT_SERVICE) at compile(),
// and this smoke test only needs the controller to construct.
describe('AuthController', () => {
  let controller: AuthController;
  let workosAuthService: any;

  beforeEach(() => {
    workosAuthService = {
      getAuthorizationUrl: jest.fn(),
    };
    controller = new AuthController(
      {} as any, // authService
      {} as any, // sessionService
      { getAppUrl: jest.fn().mockReturnValue('https://wiki.sup3rnova.com') } as any,
      {} as any, // moduleRef
      workosAuthService,
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns an explicit 302 for WorkOS authorization', async () => {
    workosAuthService.getAuthorizationUrl.mockResolvedValue(
      'https://auth.sup3rnova.com/user_management/authorize',
    );
    const redirect = jest.fn();
    const status = jest.fn().mockReturnValue({ redirect });

    await controller.workosLogin(
      { id: 'workspace-id' } as any,
      {} as any,
      { status } as any,
    );

    expect(status).toHaveBeenCalledWith(302);
    expect(redirect).toHaveBeenCalledWith(
      'https://auth.sup3rnova.com/user_management/authorize',
    );
  });
});
