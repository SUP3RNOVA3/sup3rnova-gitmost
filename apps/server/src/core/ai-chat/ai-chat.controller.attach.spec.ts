import { ForbiddenException } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type {
  RunStreamAttachment,
  RunStreamCallbacks,
} from './ai-chat-stream-registry.service';
import { SUBSCRIBER_MAX_BUFFERED_BYTES } from './ai-chat-stream-registry.service';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #184 phase 1.5 attach endpoint
 * (`GET /ai-chat/runs/:chatId/stream`). Owner-gated via assertOwnedChat; the
 * registry is mocked so this exercises ONLY the controller's replay/live/204/
 * cleanup wiring against a fake raw socket. Constructor order is (aiChatService,
 * aiChatRunService, aiChatRepo, aiChatMessageRepo, aiTranscription, pageRepo,
 * streamRegistry, environment).
 */
describe('AiChatController attach endpoint (#184 phase 1.5)', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeRawRes() {
    const raw: any = {
      writableEnded: false,
      writableLength: 0,
      destroyed: false,
      written: [] as string[],
      head: null as any,
      write: jest.fn((f: string) => {
        raw.written.push(f);
        return true;
      }),
      writeHead: jest.fn((code: number, headers: any) => {
        raw.head = { code, headers };
        return raw;
      }),
      flushHeaders: jest.fn(),
      end: jest.fn(() => {
        raw.writableEnded = true;
      }),
      destroy: jest.fn(() => {
        raw.destroyed = true;
      }),
      on: jest.fn(),
      once: jest.fn(),
    };
    const res: any = {
      raw,
      status: jest.fn(() => res),
      send: jest.fn(),
      hijack: jest.fn(),
    };
    return { res, raw };
  }

  function makeReq(destroyed = false) {
    const handlers: Record<string, () => void> = {};
    const raw: any = {
      destroyed,
      once: jest.fn((ev: string, fn: () => void) => {
        handlers[ev] = fn;
      }),
    };
    return { req: { raw } as any, raw, fireClose: () => handlers['close']?.() };
  }

  function makeAttachment(
    over: Partial<RunStreamAttachment> = {},
  ): RunStreamAttachment {
    return {
      replay: [],
      finished: false,
      start: jest.fn(),
      unsubscribe: jest.fn(),
      ...over,
    };
  }

  function makeController(opts: {
    chat?: unknown;
    attachment?: RunStreamAttachment | null;
  }) {
    const aiChatRepo = { findById: jest.fn().mockResolvedValue(opts.chat) };
    let capturedCb: RunStreamCallbacks | undefined;
    const streamRegistry = {
      attach: jest.fn(
        (
          _chatId: string,
          _live: boolean,
          _anchor: string | undefined,
          cb: RunStreamCallbacks,
        ) => {
          capturedCb = cb;
          return Promise.resolve(
            opts.attachment === undefined ? makeAttachment() : opts.attachment,
          );
        },
      ),
    };
    const environment = { isAiChatResumableStreamEnabled: () => true };
    const controller = new AiChatController(
      {} as never, // aiChatService
      {} as never, // aiChatRunService
      aiChatRepo as never,
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
      streamRegistry as never,
      environment as never,
    );
    return {
      controller,
      aiChatRepo,
      streamRegistry,
      getCb: () => capturedCb!,
    };
  }

  const owned = { id: 'c1', creatorId: 'u1' };

  it('owner-gates: a foreign chat throws ForbiddenException and never attaches', async () => {
    const { controller, streamRegistry } = makeController({
      chat: { id: 'c1', creatorId: 'someone-else' },
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await expect(
      controller.attachRunStream(
        'c1',
        undefined,
        undefined,
        req,
        res,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(streamRegistry.attach).not.toHaveBeenCalled();
  });

  it('answers 204 when the registry has nothing to resume (no entry / finished / anchor-mismatch)', async () => {
    const { controller } = makeController({ chat: owned, attachment: null });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('threads expect=live and anchor through to the registry', async () => {
    const { controller, streamRegistry } = makeController({
      chat: owned,
      attachment: null,
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      'live',
      'anchor-1',
      req,
      res,
      user,
      workspace,
    );
    expect(streamRegistry.attach).toHaveBeenCalledWith(
      'c1',
      true,
      'anchor-1',
      expect.anything(),
    );
  });

  it('passes expect=false when the query is absent', async () => {
    const { controller, streamRegistry } = makeController({
      chat: owned,
      attachment: null,
    });
    const { res } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(streamRegistry.attach).toHaveBeenCalledWith(
      'c1',
      false,
      undefined,
      expect.anything(),
    );
  });

  it('hijacks, writes headers + replay, registers a close cleanup, then goes live', async () => {
    const start = jest.fn();
    const attachment = makeAttachment({
      replay: ['f1', 'f2'],
      finished: false,
      start,
    });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(res.hijack).toHaveBeenCalled();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'content-type': 'text/event-stream' }),
    );
    expect(raw.written).toEqual(['f1', 'f2']); // replay
    expect(start).toHaveBeenCalled(); // go live after replay
    expect(req.raw.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('finished replay ends the response immediately without going live', async () => {
    const start = jest.fn();
    const attachment = makeAttachment({
      replay: ['f1'],
      finished: true,
      start,
    });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      'live',
      'a1',
      req,
      res,
      user,
      workspace,
    );
    expect(raw.written).toEqual(['f1']);
    expect(raw.end).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled(); // finished -> returns before start()
  });

  it('a close during the awaits (req.raw.destroyed) unsubscribes and writes nothing', async () => {
    const attachment = makeAttachment({ replay: ['f1'] });
    const { controller } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq(true); // destroyed already at registration time
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(attachment.unsubscribe).toHaveBeenCalled();
    expect(raw.writeHead).not.toHaveBeenCalled();
    expect(raw.written).toEqual([]);
  });

  it('the registered close handler unsubscribes the attachment', async () => {
    const attachment = makeAttachment({ replay: [] });
    const { controller } = makeController({ chat: owned, attachment });
    const { res } = makeRawRes();
    const { req, fireClose } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    expect(attachment.unsubscribe).not.toHaveBeenCalled();
    fireClose(); // socket closed
    expect(attachment.unsubscribe).toHaveBeenCalled();
  });

  it('onFrame destroys the socket when the buffered length exceeds the cap', async () => {
    const attachment = makeAttachment({ replay: [] });
    const { controller, getCb } = makeController({ chat: owned, attachment });
    const { res, raw } = makeRawRes();
    const { req } = makeReq();
    await controller.attachRunStream(
      'c1',
      undefined,
      undefined,
      req,
      res,
      user,
      workspace,
    );
    const cb = getCb();
    // Normal live frame writes.
    raw.writableLength = 0;
    cb.onFrame('live-1');
    expect(raw.written).toContain('live-1');
    // A stalled socket over the cap is destroyed instead of buffering.
    raw.writableLength = SUBSCRIBER_MAX_BUFFERED_BYTES + 1;
    raw.write.mockClear();
    cb.onFrame('too-much');
    expect(raw.destroy).toHaveBeenCalled();
    expect(raw.write).not.toHaveBeenCalled();
  });
});
