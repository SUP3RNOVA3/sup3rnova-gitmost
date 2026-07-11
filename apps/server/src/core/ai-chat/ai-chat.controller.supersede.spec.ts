import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * #487 commit 3 — the single concurrency GATE (both modes) + the server supersede
 * CAS, at the controller boundary. The gate + CAS run BEFORE res.hijack(), so a
 * rejected concurrent start / a CAS branch returns clean JSON (an HttpException
 * the controller's post-hijack catch re-serializes). These assert the OBSERVABLE
 * HTTP contract against the real controller + a stubbed run service.
 */
describe('#487 AiChatController.stream — gate + supersede', () => {
  const user = { id: 'u1' } as User;

  function wsWith(autonomousRuns: boolean): Workspace {
    return {
      id: 'ws1',
      settings: { ai: { chat: true, autonomousRuns } },
    } as unknown as Workspace;
  }

  function makeReqRes(body: Record<string, unknown>) {
    const req = {
      raw: { sessionId: 'sess', once: jest.fn(), destroyed: false },
      body,
    };
    const res = {
      raw: {
        writableEnded: false,
        headersSent: false,
        on: jest.fn(),
        once: jest.fn(),
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
        flushHeaders: jest.fn(),
      },
      hijack: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    return { req, res };
  }

  function makeController(runServiceOverrides: Record<string, jest.Mock>) {
    const aiChatService = {
      resolveRoleForRequest: jest.fn().mockResolvedValue(null),
      getChatModel: jest.fn().mockResolvedValue({}),
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const aiChatRunService = {
      getActiveForChat: jest.fn().mockResolvedValue(undefined),
      supersede: jest.fn(),
      beginRun: jest.fn().mockResolvedValue({
        runId: 'run-new',
        signal: new AbortController().signal,
      }),
      linkAssistantMessage: jest.fn(),
      recordStep: jest.fn(),
      finalizeRun: jest.fn(),
      requestStop: jest.fn(),
      ...runServiceOverrides,
    };
    const controller = new AiChatController(
      aiChatService as never,
      aiChatRunService as never,
      {} as never, // aiChatRepo
      {} as never, // aiChatMessageRepo
      {} as never, // aiTranscription
      {} as never, // pageRepo
    );
    return { controller, aiChatService, aiChatRunService };
  }

  const codeOf = (err: unknown) =>
    (((err as HttpException).getResponse() as Record<string, unknown>) ?? {})
      .code;

  describe('single concurrency gate — BOTH modes reject the second tab with 409', () => {
    for (const autonomousRuns of [true, false]) {
      it(`rejects a concurrent start with 409 A_RUN_ALREADY_ACTIVE (autonomousRuns=${autonomousRuns})`, async () => {
        const { controller, aiChatRunService } = makeController({
          getActiveForChat: jest
            .fn()
            .mockResolvedValue({ id: 'run-live', chatId: 'c1' }),
        });
        const { req, res } = makeReqRes({ chatId: 'c1' });
        let thrown: unknown;
        try {
          await controller.stream(
            req as never,
            res as never,
            user,
            wsWith(autonomousRuns),
          );
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConflictException);
        expect((thrown as HttpException).getStatus()).toBe(409);
        expect(codeOf(thrown)).toBe('A_RUN_ALREADY_ACTIVE');
        // Rejected BEFORE committing to the stream (no hijack, no service.stream).
        expect(res.hijack).not.toHaveBeenCalled();
        expect(aiChatRunService.getActiveForChat).toHaveBeenCalledWith(
          'c1',
          'ws1',
        );
      });
    }
  });

  it('supersede MISMATCH -> 409 SUPERSEDE_TARGET_MISMATCH carrying the current runId', async () => {
    const { controller } = makeController({
      supersede: jest
        .fn()
        .mockResolvedValue({ kind: 'mismatch', activeRunId: 'run-other' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_TARGET_MISMATCH');
    expect(
      ((thrown as HttpException).getResponse() as Record<string, unknown>)
        .activeRunId,
    ).toBe('run-other');
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('supersede TIMEOUT -> 409 SUPERSEDE_TIMEOUT, nothing streamed', async () => {
    const { controller } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'timeout' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(false));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_TIMEOUT');
    expect(res.hijack).not.toHaveBeenCalled();
  });

  it('supersede INVALID (target on another chat) -> 400 SUPERSEDE_INVALID', async () => {
    const { controller } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'invalid' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_INVALID');
  });

  it('supersede without chatId -> 400 SUPERSEDE_INVALID', async () => {
    const { controller, aiChatRunService } = makeController({});
    const { req, res } = makeReqRes({ supersede: { runId: 'run-x' } });
    let thrown: unknown;
    try {
      await controller.stream(req as never, res as never, user, wsWith(true));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(codeOf(thrown)).toBe('SUPERSEDE_INVALID');
    expect(aiChatRunService.supersede).not.toHaveBeenCalled();
  });

  it('supersede READY -> proceeds to stream with superseded=true', async () => {
    const { controller, aiChatService } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'ready' }),
      getActiveForChat: jest.fn().mockResolvedValue(undefined), // slot free after CAS
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    await controller.stream(req as never, res as never, user, wsWith(true));
    expect(res.hijack).toHaveBeenCalled();
    expect(aiChatService.stream).toHaveBeenCalledTimes(1);
    expect(aiChatService.stream.mock.calls[0][0].superseded).toBe(true);
    // The run hooks are always present now (both modes).
    expect(aiChatService.stream.mock.calls[0][0].runHooks).toBeDefined();
  });

  it('supersede DEGRADE -> proceeds to a normal send (superseded=false)', async () => {
    const { controller, aiChatService } = makeController({
      supersede: jest.fn().mockResolvedValue({ kind: 'degrade' }),
    });
    const { req, res } = makeReqRes({
      chatId: 'c1',
      supersede: { runId: 'run-x' },
    });
    await controller.stream(req as never, res as never, user, wsWith(false));
    expect(aiChatService.stream).toHaveBeenCalledTimes(1);
    expect(aiChatService.stream.mock.calls[0][0].superseded).toBe(false);
  });
});
