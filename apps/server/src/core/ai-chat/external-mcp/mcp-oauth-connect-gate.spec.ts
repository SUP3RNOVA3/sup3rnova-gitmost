import { McpClientsService } from './mcp-clients.service';

/**
 * #687 connect gate — an OAuth server connects ONLY when its grant is
 * `connected`; every other status is a read-only skip with the precise outcome
 * and NO DB write (criterion 7 + the R1 skip rows). Observable via `toolsFor`'s
 * per-server outcomes.
 */

function oauthServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'srv-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    name: 'GoogleDocs',
    authType: 'oauth2',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headersEnc: null,
    toolAllowlist: null,
    instructions: null,
    enabled: true,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function build(status: string, servers = [oauthServer()], enabled = true) {
  // The mock repo honours the #687 kill-switch arg exactly like the real SQL:
  // includePersonal=false drops personal (userId != null) rows from the union.
  const repo = {
    listEnabledForAgent: jest.fn(async (_ws, _user, includePersonal = true) =>
      includePersonal ? servers : servers.filter((s) => s.userId == null),
    ),
  };
  const oauth = {
    getGrantStatus: jest.fn(async () => status),
    createRuntimeProvider: jest.fn(() => ({ __provider: true })),
  };
  const env = { isMcpPersonalServersEnabled: () => enabled };
  const svc = new McpClientsService(
    repo as any,
    {} as any,
    oauth as any,
    env as any,
  );
  return { svc, repo, oauth };
}

describe('OAuth connect gate (#687)', () => {
  it('grant none -> skip with auth-required, NO connect, NO grant write', async () => {
    const { svc, oauth } = build('none');
    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(res.outcomes).toEqual([
      { name: 'GoogleDocs', ok: false, reason: 'auth-required' },
    ]);
    expect(oauth.getGrantStatus).toHaveBeenCalledWith('srv-1');
    // Gate is read-only: the runtime provider is NEVER built for a non-connected
    // grant (so no connection is opened), and the mock exposes no write method.
    expect(oauth.createRuntimeProvider).not.toHaveBeenCalled();
    expect(res.tools).toEqual({});
  });

  it('grant expired -> skip with auth-expired', async () => {
    const { svc } = build('expired');
    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(res.outcomes).toEqual([
      { name: 'GoogleDocs', ok: false, reason: 'auth-expired' },
    ]);
  });

  it('grant pending -> skip with auth-required', async () => {
    const { svc } = build('pending');
    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(res.outcomes[0].reason).toBe('auth-required');
  });

  it('grant error -> skip with auth-required', async () => {
    const { svc } = build('error');
    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(res.outcomes[0].reason).toBe('auth-required');
  });

  it('grant connected -> builds the runtime provider and connects WITH it', async () => {
    const { svc, oauth } = build('connected');
    const provider = { __provider: true };
    oauth.createRuntimeProvider.mockReturnValue(provider);
    // Stub the private connect so no real network is touched; assert the OAuth
    // provider is threaded into it (the header-less, bearer-injected connect).
    const connectSpy = jest
      .spyOn(svc as any, 'connectWithTimeout')
      .mockResolvedValue({
        tools: async () => ({}),
        close: async () => undefined,
      });

    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(oauth.createRuntimeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv-1' }),
    );
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv-1' }),
      expect.any(Number),
      provider,
    );
    // Connected + zero tools returned by the stub => an ok outcome, no failure.
    expect(res.outcomes).toEqual([{ name: 'GoogleDocs', ok: true }]);
  });

  it('oauth2 server but no OAuth service wired -> auth-unavailable (never anonymous)', async () => {
    const repo = { listEnabledForAgent: jest.fn(async () => [oauthServer()]) };
    const svc = new McpClientsService(repo as any, {} as any); // no oauth arg
    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(res.outcomes[0].reason).toBe('auth-unavailable');
  });

  // MAJOR (#687 kill-switch): MCP_PERSONAL_SERVERS_ENABLED=false must disable the
  // feature at RUNTIME too — a personal oauth2 server with a `connected` grant is
  // dropped from the agent union entirely, so it is NEVER connected and NO grant
  // read / AS / token-endpoint call is made (not just CRUD/callback blocked).
  it('kill-switch OFF: a connected personal oauth2 server is NOT connected, no grant/AS call', async () => {
    const { svc, repo, oauth } = build('connected', [oauthServer()], false);

    const res = await svc.toolsFor('ws-1', 'user-1');

    // The union was queried with includePersonal=false ...
    expect(repo.listEnabledForAgent).toHaveBeenCalledWith('ws-1', 'user-1', false);
    // ... so the personal server never reaches the connect gate: no grant is
    // read and no runtime provider (which is what would call the AS) is built.
    expect(oauth.getGrantStatus).not.toHaveBeenCalled();
    expect(oauth.createRuntimeProvider).not.toHaveBeenCalled();
    // Nothing connected; no outcome for the dropped server.
    expect(res.tools).toEqual({});
    expect(res.outcomes).toEqual([]);
  });

  it('kill-switch ON: an ADMIN server is still connected (feature-off drops only personal)', async () => {
    const adminServer = oauthServer({
      id: 'admin-1',
      name: 'AdminSrv',
      authType: 'static',
      userId: null,
    });
    // Even with the flag OFF, admin (userId=null) rows survive the union filter.
    const { svc, repo } = build('connected', [adminServer], false);
    jest
      .spyOn(svc as any, 'connectWithTimeout')
      .mockResolvedValue({ tools: async () => ({}), close: async () => undefined });

    const res = await svc.toolsFor('ws-1', 'user-1');
    expect(repo.listEnabledForAgent).toHaveBeenCalledWith('ws-1', 'user-1', false);
    expect(res.outcomes).toEqual([{ name: 'AdminSrv', ok: true }]);
  });
});
