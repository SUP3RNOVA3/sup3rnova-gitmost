import { AuthController } from './auth.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the injected dependency tokens (e.g. AUDIT_SERVICE) at compile(),
// and this smoke test only needs the controller to construct.
describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(() => {
    controller = new AuthController(
      {} as any, // authService
      {} as any, // sessionService
      {} as any, // environmentService
      {} as any, // moduleRef
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // The EE MFA module is absent in this repo, so require() throws and is caught;
  // login falls through to authService.login -> setAuthCookie -> returnToken.
  describe('login returnToken branch', () => {
    const workspace = { id: 'ws1', enforceSso: false };

    const makeController = () => {
      const authService = {
        login: jest.fn().mockResolvedValue('jwt-token-123'),
      };
      const environmentService = {
        getCookieExpiresIn: jest.fn().mockReturnValue(new Date()),
        isHttps: jest.fn().mockReturnValue(false),
      };
      const ctrl = new AuthController(
        authService as any,
        {} as any,
        environmentService as any,
        {} as any,
        {} as any,
      );
      const res = { setCookie: jest.fn() };
      return { ctrl, authService, res };
    };

    it('returns the body token and sets the cookie when returnToken is true', async () => {
      const { ctrl, authService, res } = makeController();
      const loginInput = {
        email: 'a@b.com',
        password: 'pw',
        returnToken: true,
      };

      const result = await ctrl.login(
        workspace as any,
        res as any,
        loginInput as any,
      );

      expect(result).toEqual({ authToken: 'jwt-token-123' });
      expect(res.setCookie).toHaveBeenCalledTimes(1);
      expect(res.setCookie).toHaveBeenCalledWith(
        'authToken',
        'jwt-token-123',
        expect.objectContaining({ httpOnly: true }),
      );
      expect(authService.login).toHaveBeenCalled();
    });

    it('returns no body token but still sets the cookie when returnToken is omitted', async () => {
      const { ctrl, res } = makeController();
      const loginInput = { email: 'a@b.com', password: 'pw' };

      const result = await ctrl.login(
        workspace as any,
        res as any,
        loginInput as any,
      );

      expect(result).toBeUndefined();
      expect(res.setCookie).toHaveBeenCalledTimes(1);
    });
  });
});
