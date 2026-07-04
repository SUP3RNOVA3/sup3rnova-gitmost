import { AiChatController } from './ai-chat.controller';
import type { User, Workspace } from '@docmost/db/types/entity.types';

/**
 * Wiring spec for the #191 `POST /ai-chat/bound-chat` endpoint, hardened for
 * #312. `dto.pageId` carries either a page slugId (10-char nanoid, off a slug
 * URL) or a page uuid, so the controller must FIRST resolve it to a real page
 * uuid via PageRepo.findById (which accepts both) — passing the raw slugId into
 * the uuid ai_chats.page_id column caused a Postgres 22P02 500. Only then is the
 * caller's most-recent OWN chat for that page looked up (by the resolved uuid),
 * and a page in a different workspace (or an unknown id) yields { chatId: null }
 * without ever touching the chat lookup. Exercised with hand-rolled mocks, no
 * Nest graph and no DB.
 */
describe('AiChatController.boundChat', () => {
  const user = { id: 'u1' } as User;
  const workspace = { id: 'ws1' } as Workspace;

  function makeController(opts: { page: unknown; chat?: unknown }) {
    const aiChatRepo = {
      findLatestByPage: jest.fn().mockResolvedValue(opts.chat),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue(opts.page),
    };
    const controller = new AiChatController(
      {} as never,
      {} as never, // aiChatRunService
      aiChatRepo as never,
      {} as never,
      {} as never,
      pageRepo as never,
    );
    return { controller, aiChatRepo, pageRepo };
  }

  it('resolves a slugId to the page uuid and returns the owned chat id', async () => {
    const { controller, aiChatRepo, pageRepo } = makeController({
      // findById accepts a slugId and returns the page with its real uuid.
      page: { id: 'page-uuid-1', workspaceId: 'ws1' },
      chat: { id: 'c1', creatorId: 'u1' },
    });
    // The client sends a 10-char nanoid slugId, NOT a uuid.
    const res = await controller.boundChat(
      { pageId: 'i82qXsivsx' },
      user,
      workspace,
    );
    expect(pageRepo.findById).toHaveBeenCalledWith('i82qXsivsx');
    // findLatestByPage must receive the RESOLVED uuid, never the raw slugId.
    expect(aiChatRepo.findLatestByPage).toHaveBeenCalledWith(
      'u1',
      'ws1',
      'page-uuid-1',
    );
    expect(res).toEqual({ chatId: 'c1' });
  });

  it('returns { chatId: null } for a page in a DIFFERENT workspace without a chat lookup', async () => {
    const { controller, aiChatRepo, pageRepo } = makeController({
      page: { id: 'page-uuid-2', workspaceId: 'other-ws' },
    });
    const res = await controller.boundChat(
      { pageId: 'foreignSlug' },
      user,
      workspace,
    );
    expect(pageRepo.findById).toHaveBeenCalledWith('foreignSlug');
    // No cross-workspace leak: the chat lookup must never run.
    expect(aiChatRepo.findLatestByPage).not.toHaveBeenCalled();
    expect(res).toEqual({ chatId: null });
  });

  it('returns { chatId: null } for an unknown id without throwing or looking up a chat', async () => {
    const { controller, aiChatRepo } = makeController({ page: undefined });
    const res = await controller.boundChat(
      { pageId: 'does-not-exist' },
      user,
      workspace,
    );
    expect(aiChatRepo.findLatestByPage).not.toHaveBeenCalled();
    expect(res).toEqual({ chatId: null });
  });

  it('returns { chatId: null } when the resolved page has no owned chat', async () => {
    const { controller } = makeController({
      page: { id: 'page-uuid-3', workspaceId: 'ws1' },
      chat: undefined,
    });
    const res = await controller.boundChat({ pageId: 'p3' }, user, workspace);
    expect(res).toEqual({ chatId: null });
  });
});
