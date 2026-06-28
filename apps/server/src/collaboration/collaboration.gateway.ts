import { Hocuspocus } from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';
import {
  RedisSyncExtension,
  SerializedHTTPRequest,
} from './extensions/redis-sync';
import { WsSocketWrapper } from './extensions/redis-sync/ws-socket-wrapper';
import RedisClient from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { nanoid } from 'nanoid';
import * as os from 'node:os';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import {
  CollaborationHandler,
  CollabEventHandlers,
  writeTitleFragment,
} from './collaboration.handler';
import { User } from '@docmost/db/types/entity.types';
import * as Y from 'yjs';

@Injectable()
export class CollaborationGateway {
  private readonly hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;
  // @ts-ignore
  private readonly redisSync: RedisSyncExtension<CollabEventHandlers> | null =
    null;
  // Source ioredis client that RedisSyncExtension duplicates into its pub/sub
  // pair. The extension's onDestroy only disconnects those duplicates, so we
  // keep a reference here and disconnect the source ourselves on shutdown
  // (otherwise the socket leaks and jest never exits in e2e).
  private redisClient: RedisClient | null = null;
  private readonly withRedis: boolean;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
    private collabEventsService: CollaborationHandler,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    this.withRedis = !this.environmentService.isCollabDisableRedis();

    this.hocuspocus = new Hocuspocus({
      debounce: 10000,
      maxDebounce: 45000,
      unloadImmediately: false,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
      ],
    });

    if (this.withRedis) {
      this.redisClient = new RedisClient({
        host: this.redisConfig.host,
        port: this.redisConfig.port,
        password: this.redisConfig.password,
        db: this.redisConfig.db,
        family: this.redisConfig.family,
        retryStrategy: createRetryStrategy(),
      });
      // @ts-ignore
      this.redisSync = new RedisSyncExtension({
        redis: this.redisClient,
        serverId: `collab-${os?.hostname()}-${nanoid(10)}`,
        prefix: 'collab',
        pack,
        unpack,
        // @ts-ignore
        customEvents: this.collabEventsService.getHandlers(this.hocuspocus),
      });
      this.hocuspocus.configuration.extensions.push(this.redisSync);
      // @ts-ignore
      this.redisSync.onConfigure({ instance: this.hocuspocus });
    }
  }

  private serializeRequest(request: IncomingMessage): SerializedHTTPRequest {
    return {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: {
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-protocol':
          request.headers['sec-websocket-protocol'] ?? '',
      },
      socket: { remoteAddress: request.socket?.remoteAddress ?? '' },
    };
  }

  handleConnection(client: WebSocket, request: IncomingMessage): any {
    if (this.redisSync) {
      const serializedHTTPRequest = this.serializeRequest(request);
      const socketId = serializedHTTPRequest.headers['sec-websocket-key'];

      // Create wrapper socket that only receives events via emit()
      // This prevents double-handling since Hocuspocus won't listen to raw WebSocket events
      const wrappedSocket = new WsSocketWrapper(client);

      // Route through RedisSync extension (this calls handleConnection internally)
      this.redisSync.onSocketOpen(wrappedSocket as any, serializedHTTPRequest);

      // Forward raw WebSocket messages to the extension
      client.on('message', (data: ArrayBuffer) => {
        this.redisSync!.onSocketMessage(
          wrappedSocket as any,
          serializedHTTPRequest,
          data,
        );
      });

      // Forward close events
      client.on('close', (code: number, reason: Buffer) => {
        this.redisSync!.onSocketClose(socketId, code, reason.buffer as ArrayBuffer);
      });

      // Forward pong events for keepalive
      client.on('pong', (data: Buffer) => {
        wrappedSocket.emit('pong', data);
      });
    } else {
      // Fallback to direct Hocuspocus connection
      this.hocuspocus.handleConnection(client, request);
    }
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  handleYjsEvent<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
  ): ReturnType<CollabEventHandlers[TName]> {
    if (this.redisSync) {
      // Normal path: the Redis bridge routes the event to the instance that owns
      // the document (local or another worker) and carries the handler's return
      // value back to us (customEventComplete + replyId).
      return this.redisSync.handleEvent(
        eventName,
        documentName,
        payload,
      ) as ReturnType<CollabEventHandlers[TName]>;
    }

    // COLLAB_DISABLE_REDIS: there is no cross-process bridge, so a single local
    // hocuspocus instance owns every document. Invoke the handler directly
    // against it instead of returning undefined — otherwise doc-mutation events
    // (setCommentMark / resolveCommentMark / applyCommentSuggestion) would
    // silently no-op and, for suggestions, the caller could never learn the
    // verdict. openDirectConnection loads the doc via the persistence extension
    // if it is not already in memory.
    if (this.hocuspocus) {
      const handlers = this.collabEventsService.getHandlers(this.hocuspocus);
      const handler = handlers[eventName] as (
        documentName: string,
        payload: unknown,
      ) => ReturnType<CollabEventHandlers[TName]>;
      return handler(documentName, payload);
    }

    // Collaboration was never initialized (no live instance). Fail loudly rather
    // than silently dropping a mutation; phase 4's caller maps this to a 5xx.
    throw new Error(
      `Cannot handle collaboration event "${String(
        eventName,
      )}": requires a live collaboration instance`,
    );
  }

  openDirectConnection(documentName: string, context?: any) {
    return this.hocuspocus.openDirectConnection(documentName, context);
  }

  /**
   * Write a new page title INTO the page's Yjs 'title' fragment, Redis-INDEPENDENT.
   *
   * Unlike the Redis-routed `handleYjsEvent` path — which routes through
   * `redisSync?.handleEvent` and SILENTLY no-ops when Redis is disabled
   * (COLLAB_DISABLE_REDIS=true → redisSync === null) — this goes straight
   * through the local Hocuspocus `openDirectConnection`. The title sync
   * therefore works in BOTH single-process (no Redis) and Redis-clustered
   * deployments.
   *
   * openDirectConnection loads the doc from persistence when no editor is
   * connected, so this works whether or not an editor is currently open: the
   * clear+reseed lands on the loaded doc and is persisted by onStoreDocument.
   *
   * Provenance: when the caller is the agent, the actor/aiChatId are threaded
   * into the connection `context` so onStoreDocument sees `context.actor ===
   * 'agent'` for the resulting title store (mirrors the body/REST path). The
   * resulting title store is usually a no-op anyway — PageService already wrote
   * the same title to the page.title column, so onStoreDocument's
   * `titleText !== page.title` guard skips the column write — but we wire the
   * context for correctness regardless.
   */
  async writePageTitle(
    pageId: string,
    title: string,
    context?: { user?: User; actor?: string; aiChatId?: string },
  ): Promise<void> {
    const documentName = `page.${pageId}`;
    const connection = await this.hocuspocus.openDirectConnection(
      documentName,
      context ?? {},
    );
    try {
      // Write the new title into the in-memory 'title' fragment AND capture the
      // resulting full doc state so we can persist it directly below.
      let ydocState: Buffer | null = null;
      await connection.transact((doc) => {
        writeTitleFragment(doc, title);
        ydocState = Buffer.from(Y.encodeStateAsUpdate(doc));
      });

      // F1 (variant C): persist the 'title' fragment to `page.ydoc` DIRECTLY,
      // bypassing onStoreDocument. PageService.update already wrote the new title
      // to the page.title COLUMN before calling this, so onStoreDocument's no-op
      // fast-path (titleText === column) would NOT persist the in-memory fragment
      // on disconnect — leaving the stored ydoc with the OLD title, which a later
      // body edit would then revert the column back to. Writing the ydoc here
      // makes BOTH column and persisted fragment consistent (NEW = NEW).
      //
      // Safe with or without a live editor: the write is idempotent and carries
      // no tree snapshot (no double broadcast); when an editor is connected, the
      // normal onStoreDocument flow still persists the (superset) state later and
      // the live clients receive the title change through the transact above.
      if (ydocState) {
        await this.persistenceExtension.persistTitleFragmentYdoc(
          pageId,
          ydocState,
        );
      }
    } finally {
      await connection.disconnect();
    }
  }

  /*
   *Can be used before calling openDirectConnection directly
   */
  async lockDocument(documentName: string) {
    return this.redisSync.lockDocument(documentName);
  }

  /*
   *Releases a document lock and stops the interval that maintains it.
   */
  async releaseLock(documentName: string) {
    return this.redisSync.releaseLock(documentName);
  }

  async destroy(collabWsAdapter: CollabWsAdapter): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve) => {
      try {
        // Wait for all documents to unload
        this.hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve('');
          },
        });

        collabWsAdapter?.close();

        if (this.hocuspocus.getDocumentsCount() === 0) resolve('');
        this.hocuspocus.closeConnections();
      } catch (error) {
        console.error(error);
      }
    });

    await this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus });

    // RedisSyncExtension.onDestroy (run via the hook above) disconnects only the
    // duplicated pub/sub clients; the source client created here is ours to close.
    this.redisClient?.disconnect();
    this.redisClient = null;
  }
}
