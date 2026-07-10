import type { HealthIndicatorService } from '@nestjs/terminus';
import type { EnvironmentService } from '../environment/environment.service';

/**
 * Integration guard for the /health Redis-probe handle leak (#486, commit 2).
 *
 * The bug: `pingCheck` built `new Redis(...)` per call and only disconnected on
 * the SUCCESS path, so when Redis is DOWN every probe tick added ANOTHER
 * forever-reconnecting client — an unbounded handle/client leak for the duration
 * of the outage. The fix reuses ONE long-lived probe client.
 *
 * This is an OBSERVABLE-property test, not an assertion on a mocked return value:
 * we point the indicator at a REAL, refused TCP endpoint (a dead port) so ioredis
 * genuinely fails to connect, run many probes, and assert the number of live
 * Redis CLIENTS created stays at exactly ONE. `ioredis` is delegated to its real
 * implementation (requireActual) — only the constructor is wrapped to COUNT the
 * real clients it creates, which is precisely the leaking resource.
 */
const mockLiveClients: Array<{ status: string; disconnect: () => void }> = [];

jest.mock('ioredis', () => {
  const actual = jest.requireActual('ioredis');
  const RealRedis = actual.Redis ?? actual.default ?? actual;
  class CountingRedis extends RealRedis {
    constructor(...args: unknown[]) {
      super(...(args as []));
      mockLiveClients.push(this as never);
    }
  }
  return { ...actual, Redis: CountingRedis, default: CountingRedis };
});

// Import AFTER the mock is registered so the class picks up the counting client.
import { RedisHealthIndicator } from './redis.health';

describe('RedisHealthIndicator handle leak (#486)', () => {
  const indicatorService = {
    check: (key: string) => ({
      up: () => ({ [key]: { status: 'up' } }),
      down: (message: string) => ({ [key]: { status: 'down', message } }),
    }),
  } as unknown as HealthIndicatorService;

  // A port with (almost certainly) nothing listening -> connection refused fast.
  const environmentService = {
    getRedisUrl: () => 'redis://127.0.0.1:6399/0',
  } as unknown as EnvironmentService;

  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    mockLiveClients.length = 0;
    indicator = new RedisHealthIndicator(indicatorService, environmentService);
  });

  afterEach(() => {
    indicator.onModuleDestroy();
    // Belt-and-braces: tear down anything the test created so ioredis reconnect
    // timers do not keep the jest worker alive.
    for (const c of mockLiveClients) {
      try {
        c.disconnect();
      } catch {
        /* already gone */
      }
    }
  });

  it('creates exactly ONE Redis client across many probes while Redis is DOWN', async () => {
    const N = 8;
    for (let i = 0; i < N; i++) {
      const result = await indicator.pingCheck('redis');
      // Down endpoint -> every probe reports "down" (not an unhandled crash).
      expect(result.redis.status).toBe('down');
    }

    // THE OBSERVABLE LEAK: on the buggy code this is N (a fresh, never-cleaned
    // reconnecting client per probe). The fix reuses one shared client.
    expect(mockLiveClients).toHaveLength(1);
  });

  it('onModuleDestroy releases the probe client (a later probe builds a fresh one)', async () => {
    await indicator.pingCheck('redis');
    expect(mockLiveClients).toHaveLength(1);

    indicator.onModuleDestroy();
    // A second destroy is a safe no-op (probeClient was nulled).
    indicator.onModuleDestroy();

    // After shutdown the indicator lazily builds a NEW client on the next probe,
    // proving the old one was truly released rather than reused.
    await indicator.pingCheck('redis');
    expect(mockLiveClients).toHaveLength(2);
  });
});
