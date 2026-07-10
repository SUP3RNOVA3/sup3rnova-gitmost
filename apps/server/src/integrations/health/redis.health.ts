import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { Redis } from 'ioredis';

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  /**
   * ONE long-lived probe connection, reused across every /health tick. The old
   * code built `new Redis(...)` per call and only `disconnect()`d on the SUCCESS
   * path, so while Redis was DOWN every probe added a fresh, forever-reconnecting
   * client — a handle leak that grew without bound for as long as the outage (and
   * the health checker keeps polling) lasted. A single shared client keeps at most
   * ONE background reconnect loop regardless of how many probes run.
   */
  private probeClient: Redis | null = null;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private environmentService: EnvironmentService,
  ) {}

  private getProbeClient(): Redis {
    if (!this.probeClient) {
      this.probeClient = new Redis(this.environmentService.getRedisUrl(), {
        // Constructing must never throw or eagerly connect; the first ping opens
        // the socket. This lets us build the client once and reuse it.
        lazyConnect: true,
        // A health probe must fail FAST, not queue behind a stuck reconnect: one
        // retry per request, and no offline queue so a ping while disconnected
        // rejects immediately instead of buffering commands that pile up in RAM.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      // ioredis emits 'error' on every failed (re)connect; with no listener that
      // surfaces as an unhandled 'error' event and can crash the process. Swallow
      // it here — pingCheck already reports health — and log at debug so a Redis
      // outage does not flood the logs.
      this.probeClient.on('error', (err) => {
        this.logger.debug(
          `Redis probe connection error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return this.probeClient;
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const redis = this.getProbeClient();
      await redis.ping();
      return indicator.up();
    } catch (e) {
      this.logger.error(e);
      return indicator.down(`${key} is not available`);
    }
  }

  onModuleDestroy(): void {
    if (this.probeClient) {
      // disconnect() (not quit()) tears the socket + reconnect loop down
      // immediately without waiting on a round-trip to a possibly-down server.
      // Do NOT removeAllListeners() with no event name — that would also strip
      // ioredis' OWN internal listeners and break its teardown; our 'error'
      // listener is harmless and dies with the dropped client reference.
      this.probeClient.disconnect();
      this.probeClient = null;
    }
  }
}
