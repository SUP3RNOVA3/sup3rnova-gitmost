import { resolveAgentProvenance } from './agent-provenance';
import { commentAgentRoleQuery } from './comment/comment.repo';
import { pageHistoryAgentRoleQuery } from './page/page-history.repo';

/**
 * The server-authoritative "agent avatar stack" resolver (#300) normalizes the
 * two provenance shapes into { agent (front), launcher (behind) } so the client
 * never branches. These tests pin the exact resolved shape for the three agent
 * cases plus the non-agent pass-through.
 */
describe('resolveAgentProvenance', () => {
  const human = { name: 'Alice', avatarUrl: 'a.png' };

  it('internal chat WITH role: agent = role (emoji, no avatar), launcher = human', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: 'chat-1',
      creator: human,
      agentRole: { name: 'Researcher', emoji: '🔬' },
    });
    expect(result).toEqual({
      agent: { name: 'Researcher', emoji: '🔬', avatarUrl: null },
      launcher: { name: 'Alice', avatarUrl: 'a.png' },
    });
  });

  it('internal chat WITHOUT role: agent = "AI agent" fallback, launcher = human', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: 'chat-1',
      creator: human,
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: 'AI agent', avatarUrl: null },
      launcher: { name: 'Alice', avatarUrl: 'a.png' },
    });
    // The fallback agent carries no emoji (only sparkles glyph on the client).
    expect(result?.agent).not.toHaveProperty('emoji');
  });

  it('external MCP (aiChatId null): agent = the account itself, launcher = null', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: null,
      creator: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      launcher: null,
    });
  });

  it('non-agent content: returns null so the caller omits both fields', () => {
    expect(
      resolveAgentProvenance({
        isAgent: false,
        aiChatId: null,
        creator: human,
        agentRole: null,
      }),
    ).toBeNull();
  });
});

/**
 * The role-resolution subquery must NOT filter on enabled/deletedAt: historical
 * agent content keeps its signature even after the role is disabled or
 * soft-deleted (same rule as AiAgentRoleRepo.findById, NOT findLiveEnabled). We
 * record the query-builder calls and assert the join binds only id<->roleId and
 * that `where` is never called with an enabled/deletedAt filter.
 */
describe('agent role subquery — no live/enabled filter', () => {
  function makeRecorder() {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return builder;
          };
        },
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eb = { selectFrom: (...args: unknown[]) => (calls.push({ method: 'selectFrom', args }), builder) } as any;
    return { eb, calls };
  }

  function assertNoLiveFilter(
    query: (eb: any) => unknown, // eslint-disable-line @typescript-eslint/no-explicit-any
    chatIdColumn: string,
  ) {
    const { eb, calls } = makeRecorder();
    query(eb);

    const innerJoin = calls.find((c) => c.method === 'innerJoin');
    expect(innerJoin?.args).toEqual([
      'aiAgentRoles',
      'aiAgentRoles.id',
      'aiChats.roleId',
    ]);

    const whereRef = calls.find((c) => c.method === 'whereRef');
    expect(whereRef?.args).toEqual(['aiChats.id', '=', chatIdColumn]);

    // The security-narrowing filters used by findLiveEnabled must be ABSENT.
    const filtered = calls
      .flatMap((c) => c.args)
      .filter((a) => a === 'enabled' || a === 'deletedAt');
    expect(filtered).toEqual([]);
    // No `where(...)` at all (only the join + whereRef).
    expect(calls.some((c) => c.method === 'where')).toBe(false);
  }

  it('comment subquery joins by id only, keyed on comments.aiChatId', () => {
    assertNoLiveFilter(commentAgentRoleQuery, 'comments.aiChatId');
  });

  it('page-history subquery joins by id only, keyed on lastUpdatedAiChatId', () => {
    assertNoLiveFilter(
      pageHistoryAgentRoleQuery,
      'pageHistory.lastUpdatedAiChatId',
    );
  });
});
