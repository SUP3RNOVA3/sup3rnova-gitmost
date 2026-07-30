import { McpOauthCallbackController } from './mcp-oauth-callback.controller';

/**
 * #687 criterion 8 — callback security (anti-grant-fixation), as the OBSERVABLE
 * property (AGENTS #8/#9): replay -> 400 with the grant untouched; another user's
 * state -> 403 with NO exchange; kill-switch off -> no processing; Redis down ->
 * error redirect with no state transition; success -> ?oauth=connected.
 */

const user = { id: 'user-1' } as any;
const workspace = { id: 'ws-1' } as any;

function build(enabled = true) {
  const oauth = {
    consumeState: jest.fn(),
    completeCallback: jest.fn(),
    markCallbackError: jest.fn(),
  };
  const repo = { findByIdForUser: jest.fn() };
  const env = {
    getAppUrl: () => 'https://app.example.com',
    isMcpPersonalServersEnabled: () => enabled,
  };
  const res = {
    redirect: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  const controller = new McpOauthCallbackController(
    oauth as any,
    repo as any,
    env as any,
  );
  return { controller, oauth, repo, res };
}

const ownServer = {
  id: 'srv-1',
  workspaceId: 'ws-1',
  url: 'https://mcp.example.com',
  authType: 'oauth2',
};

describe('McpOauthCallbackController.callback', () => {
  it('success -> exchanges and redirects ?oauth=connected', async () => {
    const { controller, oauth, repo, res } = build();
    oauth.consumeState.mockResolvedValue({
      userId: 'user-1',
      serverId: 'srv-1',
      codeVerifier: 'v',
    });
    repo.findByIdForUser.mockResolvedValue(ownServer);
    oauth.completeCallback.mockResolvedValue('connected');

    await controller.callback('code-1', 'state-1', undefined, user, workspace, res as any);

    expect(oauth.completeCallback).toHaveBeenCalledWith(
      { id: 'srv-1', workspaceId: 'ws-1', url: 'https://mcp.example.com' },
      'code-1',
      'state-1',
      'v',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example.com/settings/account/mcp-servers?oauth=connected',
      302,
    );
  });

  it('replay (state already gashed) -> 400, NO exchange', async () => {
    const { controller, oauth, res } = build();
    oauth.consumeState.mockResolvedValue(null);

    await controller.callback('code-1', 'old-state', undefined, user, workspace, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(oauth.completeCallback).not.toHaveBeenCalled();
    expect(oauth.markCallbackError).not.toHaveBeenCalled();
  });

  it("another user's state -> 403, NO exchange, grant untouched", async () => {
    const { controller, oauth, repo, res } = build();
    oauth.consumeState.mockResolvedValue({
      userId: 'someone-else',
      serverId: 'srv-1',
      codeVerifier: 'v',
    });

    await controller.callback('code-1', 'state-1', undefined, user, workspace, res as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(repo.findByIdForUser).not.toHaveBeenCalled();
    expect(oauth.completeCallback).not.toHaveBeenCalled();
    expect(oauth.markCallbackError).not.toHaveBeenCalled();
  });

  it('state ok but row not owned -> 403, NO exchange', async () => {
    const { controller, oauth, repo, res } = build();
    oauth.consumeState.mockResolvedValue({
      userId: 'user-1',
      serverId: 'srv-1',
      codeVerifier: 'v',
    });
    repo.findByIdForUser.mockResolvedValue(undefined); // not owned by this user

    await controller.callback('code-1', 'state-1', undefined, user, workspace, res as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(oauth.completeCallback).not.toHaveBeenCalled();
  });

  it('consent error (access_denied) -> grant error + ?oauth=error', async () => {
    const { controller, oauth, repo, res } = build();
    oauth.consumeState.mockResolvedValue({
      userId: 'user-1',
      serverId: 'srv-1',
      codeVerifier: 'v',
    });
    repo.findByIdForUser.mockResolvedValue(ownServer);

    await controller.callback(undefined, 'state-1', 'access_denied', user, workspace, res as any);

    expect(oauth.markCallbackError).toHaveBeenCalledWith('srv-1', 'access_denied');
    expect(oauth.completeCallback).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example.com/settings/account/mcp-servers?oauth=error',
      302,
    );
  });

  it('kill-switch off -> redirect error, no processing', async () => {
    const { controller, oauth, res } = build(false);
    await controller.callback('code-1', 'state-1', undefined, user, workspace, res as any);
    expect(oauth.consumeState).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example.com/settings/account/mcp-servers?oauth=error',
      302,
    );
  });

  it('Redis down (consumeState throws) -> error redirect, no state transition', async () => {
    const { controller, oauth, res } = build();
    oauth.consumeState.mockRejectedValue(new Error('Redis down'));

    await controller.callback('code-1', 'state-1', undefined, user, workspace, res as any);

    expect(oauth.completeCallback).not.toHaveBeenCalled();
    expect(oauth.markCallbackError).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example.com/settings/account/mcp-servers?oauth=error',
      302,
    );
  });
});
