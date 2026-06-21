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

  describe('getGitSyncMaxDeletesPerCycle', () => {
    const withEnv = (value?: string) =>
      new EnvironmentService({
        get: (_key: string, fallback?: string) => value ?? fallback,
      } as any);

    it('defaults to 5 when unset', () => {
      expect(withEnv().getGitSyncMaxDeletesPerCycle()).toBe(5);
    });

    it('parses a valid positive int', () => {
      expect(withEnv('12').getGitSyncMaxDeletesPerCycle()).toBe(12);
    });

    it('falls back to 5 for non-positive or unparseable values', () => {
      expect(withEnv('0').getGitSyncMaxDeletesPerCycle()).toBe(5);
      expect(withEnv('-3').getGitSyncMaxDeletesPerCycle()).toBe(5);
      expect(withEnv('not-a-number').getGitSyncMaxDeletesPerCycle()).toBe(5);
    });
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
});
