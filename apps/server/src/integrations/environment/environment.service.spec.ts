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
});
