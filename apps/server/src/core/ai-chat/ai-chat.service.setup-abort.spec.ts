import { Logger } from '@nestjs/common';

// Mock the AI SDK: the turn we drive is STOPPED during the pre-streamText setup
// phase, so no provider call must ever be made. convertToModelMessages is reached
// (before toolsFor) so it is stubbed to an empty transcript.
jest.mock('ai', () => ({
  streamText: jest.fn(),
  generateText: jest.fn(),
  convertToModelMessages: jest.fn(async () => []),
  stepCountIs: jest.fn(() => () => false),
}));

import { streamText } from 'ai';
import { AiChatService } from './ai-chat.service';

/**
 * D2 — an explicit Stop DURING the external-MCP toolset build (the pre-streamText
 * setup phase) must:
 *   (a) unwedge the turn (stream() rejects instead of hanging at step 0), and
 *   (b) finalize the run as 'aborted' via the outer catch's onSettled — never leak
 *       the run row as 'running' (which would 409 every later turn in this chat).
 *
 * The setup phase does NOT yet observe streamText's terminal callbacks, so before
 * the fix a hung `toolsFor` ignored the run's abort signal and never finalized.
 * `raceAgainstAbortAndTimeout(toolsFor, effectiveSignal, ...)` now rejects the
 * moment the run's signal aborts; the catch re-throws (signal aborted), and the
 * outer catch settles the run 'aborted'.
 */
describe('AiChatService.stream — abort during external-MCP setup finalizes the run (D2)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  function makeService(mcpClients: { toolsFor: jest.Mock }) {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo (openPage undefined -> never touched)
      {} as never, // pageAccess
      { isAiChatDeferredToolsEnabled: () => false } as never, // environment
    );
    return { svc, tools };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  beforeEach(() => {
    streamTextMock.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stops the hung toolset build, rejects, and settles the run "aborted" — never reaching streamText', async () => {
    const runController = new AbortController();
    // The build hangs (never resolves); the run is STOPPED mid-build. Aborting on a
    // macrotask exercises the abort-listener path (a real user Stop during setup).
    const toolsFor = jest.fn(() => {
      setTimeout(() => runController.abort(new Error('user stop')), 0);
      return new Promise(() => {}); // never settles — models a hung MCP build
    });
    const { svc } = makeService({ toolsFor });

    const onSettled = jest.fn();
    const begin = jest.fn(async () => ({
      runId: 'run-1',
      signal: runController.signal,
    }));

    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: { raw: {} } as never,
      signal: new AbortController().signal, // socket signal (distinct from the run)
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled,
      } as never,
    });

    // (a) The turn is UNWEDGED: it rejects (with the stop reason) instead of hanging.
    await expect(promise).rejects.toThrow('user stop');

    // (b) The run is finalized as 'aborted' with NO error message (a Stop, not a
    // failure) — so the run row never leaks 'running'.
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('run-1', 'aborted', undefined);

    // The build was reached, but the provider call was NEVER made (stopped at setup).
    expect(toolsFor).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
