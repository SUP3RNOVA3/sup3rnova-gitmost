import { EnvironmentService } from './environment.service';

// Direct instantiation with a stub ConfigService, mirroring the rest of these
// unit specs.
describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(() => {
    service = new EnvironmentService(
      {} as any, // configService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getGitSyncPollIntervalMs', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('defaults to 15000 when unset', () => {
      expect(withEnv().getGitSyncPollIntervalMs()).toBe(15000);
    });

    it('parses a valid positive int', () => {
      expect(withEnv('30000').getGitSyncPollIntervalMs()).toBe(30000);
    });

    it('falls back to 15000 for non-positive or unparseable values', () => {
      expect(withEnv('0').getGitSyncPollIntervalMs()).toBe(15000);
      expect(withEnv('-100').getGitSyncPollIntervalMs()).toBe(15000);
      expect(withEnv('not-a-number').getGitSyncPollIntervalMs()).toBe(15000);
    });
  });

  describe('getGitSyncDebounceMs', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('defaults to 2000 when unset', () => {
      expect(withEnv().getGitSyncDebounceMs()).toBe(2000);
    });

    it('parses a valid positive int', () => {
      expect(withEnv('500').getGitSyncDebounceMs()).toBe(500);
    });

    it('falls back to 2000 for non-positive or unparseable values', () => {
      expect(withEnv('0').getGitSyncDebounceMs()).toBe(2000);
      expect(withEnv('-5').getGitSyncDebounceMs()).toBe(2000);
      expect(withEnv('not-a-number').getGitSyncDebounceMs()).toBe(2000);
    });
  });

  // getGitSyncDataDir reads two distinct keys (GIT_SYNC_DATA_DIR and DATA_DIR),
  // so this builder maps each key to a supplied value (and honours the fallback
  // the getter passes for DATA_DIR's `|| './data'`).
  describe('getGitSyncDataDir', () => {
    const withEnv = (values: Record<string, string | undefined>) =>
      new EnvironmentService({
        get: (key: string, fallback?: string) => values[key] ?? fallback,
      } as any);

    it("defaults to './data/git-sync' when neither key is set", () => {
      expect(withEnv({}).getGitSyncDataDir()).toBe('./data/git-sync');
    });

    it('derives from DATA_DIR with the /git-sync suffix', () => {
      expect(
        withEnv({ DATA_DIR: '/var/lib/docmost' }).getGitSyncDataDir(),
      ).toBe('/var/lib/docmost/git-sync');
    });

    it('strips trailing slashes from DATA_DIR before appending', () => {
      expect(
        withEnv({ DATA_DIR: '/var/lib/docmost///' }).getGitSyncDataDir(),
      ).toBe('/var/lib/docmost/git-sync');
    });

    it('lets an explicit GIT_SYNC_DATA_DIR override the DATA_DIR derivation', () => {
      expect(
        withEnv({
          GIT_SYNC_DATA_DIR: '/custom/vault',
          DATA_DIR: '/var/lib/docmost',
        }).getGitSyncDataDir(),
      ).toBe('/custom/vault');
    });

    it('returns the explicit override verbatim (no /git-sync suffix, no slash strip)', () => {
      expect(
        withEnv({ GIT_SYNC_DATA_DIR: '/custom/vault/' }).getGitSyncDataDir(),
      ).toBe('/custom/vault/');
    });
  });

  // isGitSyncEnabled is the `.toLowerCase() === 'true'` contract: only a
  // case-insensitive "true" enables it; everything else (unset, "false",
  // garbage) is false.
  describe('isGitSyncEnabled', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('is true for "true" and "TRUE" (case-insensitive)', () => {
      expect(withEnv('true').isGitSyncEnabled()).toBe(true);
      expect(withEnv('TRUE').isGitSyncEnabled()).toBe(true);
    });

    it('is false when unset (defaults to "false")', () => {
      expect(withEnv().isGitSyncEnabled()).toBe(false);
    });

    it('is false for "false" and garbage values', () => {
      expect(withEnv('false').isGitSyncEnabled()).toBe(false);
      expect(withEnv('maybe').isGitSyncEnabled()).toBe(false);
      expect(withEnv('1').isGitSyncEnabled()).toBe(false);
    });
  });
});
