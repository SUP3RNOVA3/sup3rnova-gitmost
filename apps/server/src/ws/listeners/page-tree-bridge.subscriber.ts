import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { COLLAB_TREE_UPDATE_CHANNEL } from '../../collaboration/constants';
import { TreeUpdateSnapshot } from '../../database/listeners/page.listener';
import { WsTreeService } from '../ws-tree.service';

/**
 * API-process half of the cross-process tree-update bridge.
 *
 * It subscribes to the Redis pub/sub channel that the collab process's
 * `PageTreeBridgePublisher` publishes to and re-broadcasts each collab-originated
 * `treeUpdate` snapshot through `WsTreeService`. This is what makes a
 * collaborative rename reach other users' sidebars in 2-process (COLLAB_URL set)
 * deployments. The API process is the single broadcast authority:
 * `broadcastPageUpdated` routes through the restriction-aware `emitTreeEvent`, so
 * this path stays authorization-safe.
 *
 * In single-process mode this subscriber still subscribes, but nobody publishes
 * (the publisher lives only in `CollabAppModule`), so it stays idle and harmless.
 *
 * NOTE: this assumes a SINGLE API broadcaster. With multiple horizontally-scaled
 * API replicas, every replica would receive the pub/sub message and re-broadcast,
 * duplicating the client update (the Socket.IO Redis adapter already fans a single
 * emit out to all replicas' clients). Scaling the API horizontally would require a
 * consumer-group / leader-election scheme instead of fan-out pub/sub. That is out
 * of scope for the current single-API deployment.
 */
@Injectable()
export class PageTreeBridgeSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PageTreeBridgeSubscriber.name);
  private sub?: Redis;

  constructor(
    private readonly redisService: RedisService,
    private readonly wsTree: WsTreeService,
  ) {}

  async onModuleInit(): Promise<void> {
    // A connection in subscribe mode cannot run other commands, so use a
    // dedicated duplicated client (mirrors RedisSyncExtension's `sub`).
    this.sub = this.redisService.getOrThrow().duplicate();
    // ioredis connections emit 'error' on disconnect/reconnect; an EventEmitter
    // 'error' with no listener THROWS and can crash the process. The bridge is
    // optional, so just log and stay alive (mirrors RedisSyncExtension).
    this.sub.on('error', (err) =>
      this.logger.warn(`tree-update subscriber redis error: ${err?.message}`),
    );
    this.sub.on('message', (channel, message) =>
      this.onMessage(channel, message),
    );
    // The bridge is optional for core API operation: if Redis is down at boot,
    // subscribe() rejects — log and continue rather than crash API bootstrap.
    try {
      await this.sub.subscribe(COLLAB_TREE_UPDATE_CHANNEL);
    } catch (err) {
      this.logger.error(
        `Failed to subscribe to ${COLLAB_TREE_UPDATE_CHANNEL}; cross-process tree updates disabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async onMessage(channel: string, message: string): Promise<void> {
    if (channel !== COLLAB_TREE_UPDATE_CHANNEL) return;

    let snapshot: TreeUpdateSnapshot;
    try {
      snapshot = JSON.parse(message) as TreeUpdateSnapshot;
    } catch (err) {
      // Malformed payload must never throw out of the message handler.
      this.logger.warn(
        `Dropping malformed tree update on ${COLLAB_TREE_UPDATE_CHANNEL}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // broadcastPageUpdated -> emitTreeEvent does a DB permission read that can
    // reject. ioredis does not await this handler, so a rejection would become
    // an unhandled promise rejection — swallow it (warn, never rethrow).
    try {
      await this.wsTree.broadcastPageUpdated(snapshot);
    } catch (err) {
      this.logger.warn(
        `Failed to broadcast tree update for page ${snapshot.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.sub) return;
    try {
      await this.sub.unsubscribe(COLLAB_TREE_UPDATE_CHANNEL);
      await this.sub.quit();
    } catch (err) {
      this.logger.warn(
        `Failed to tear down tree-update subscriber: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
