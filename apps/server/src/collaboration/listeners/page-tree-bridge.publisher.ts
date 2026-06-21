import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { EventName } from '../../common/events/event.contants';
import { PageEvent } from '../../database/listeners/page.listener';
import { COLLAB_TREE_UPDATE_CHANNEL } from '../constants';

/**
 * Collab-process half of the cross-process tree-update bridge.
 *
 * The standalone collab process bootstraps `CollabAppModule`, which does NOT
 * import `WsModule`/`PageWsListener`. So when a collaborative title/icon rename
 * persists and emits `EventName.PAGE_UPDATED` with a `treeUpdate` snapshot, there
 * is no listener in this process to broadcast it — the live tree update would be
 * lost for 2-process (COLLAB_URL set) deployments.
 *
 * This publisher fills that gap: it forwards the `treeUpdate` snapshot over a
 * Redis pub/sub channel to the API process, which re-broadcasts it via
 * `WsTreeService` (the single broadcast authority).
 *
 * It is registered ONLY in `CollabAppModule.providers`, so it never runs in the
 * API process (where `PageWsListener` already broadcasts the same event locally).
 * That module placement is what prevents a double broadcast. In single-process
 * mode `CollabAppModule` is not loaded at all, so this publisher never runs.
 */
@Injectable()
export class PageTreeBridgePublisher {
  private readonly logger = new Logger(PageTreeBridgePublisher.name);
  private readonly redis: Redis;

  constructor(private readonly redisService: RedisService) {
    this.redis = this.redisService.getOrThrow();
  }

  @OnEvent(EventName.PAGE_UPDATED)
  async onPageUpdated(event: PageEvent): Promise<void> {
    // Mirror PageWsListener's gating: only title/icon changes carry a snapshot.
    // Content-only saves leave `treeUpdate` undefined and are ignored.
    if (!event.treeUpdate) return;

    try {
      await this.redis.publish(
        COLLAB_TREE_UPDATE_CHANNEL,
        JSON.stringify(event.treeUpdate),
      );
    } catch (err) {
      // A Redis publish failure must not break the store path.
      this.logger.error(
        `Failed to publish tree update to ${COLLAB_TREE_UPDATE_CHANNEL}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
