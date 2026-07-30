// Neutralize the SSRF/DNS check so url-change reset is testable offline.
jest.mock('./ssrf-guard', () => ({
  isUrlAllowed: async () => ({ ok: true }),
  isIpAllowed: () => ({ ok: true }),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountMcpServersService } from './account-mcp-servers.service';

/**
 * #687 — the personal-server service's OAuth wiring: create-time validation
 * (oauth2 + static headers => 400), the R1 grant reset on a url/transport change
 * (criterion 9), and the start/disconnect delegation. Observable via the mocked
 * collaborators.
 */

function build() {
  const repo = {
    findByIdForUser: jest.fn(),
    updateForUser: jest.fn(async () => undefined),
  };
  const secretBox = {
    encryptSecret: (p: string) => `enc:${p}`,
    decryptSecret: (b: string) => b,
  };
  const clients = { invalidateUser: jest.fn() };
  const env = { getMcpPersonalServersMax: () => 10 };
  const oauth = {
    resetGrant: jest.fn(async () => undefined),
    getGrantStatus: jest.fn(async () => 'connected'),
    startAuthorization: jest.fn(async () => ({
      authorizeUrl: 'https://as.example.com/authorize?x=1',
    })),
    disconnect: jest.fn(async () => undefined),
  };
  const svc = new AccountMcpServersService(
    {} as any, // db (unused on these paths)
    repo as any,
    secretBox as any,
    clients as any,
    env as any,
    oauth as any,
  );
  return { svc, repo, clients, oauth };
}

const oauthRow = {
  id: 'srv-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  authType: 'oauth2',
  transport: 'http',
  url: 'https://mcp.example.com',
  headersEnc: null,
  toolAllowlist: null,
  instructions: null,
  enabled: true,
};

describe('createPersonal — oauth2 validation', () => {
  it('rejects oauth2 combined with static headers (400)', async () => {
    const { svc } = build();
    await expect(
      svc.createPersonal('ws-1', 'user-1', {
        name: 'g',
        authType: 'oauth2',
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer x' },
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('update — R1 grant reset on connection-field change (criterion 9)', () => {
  it('url change on an oauth2 server resets the grant', async () => {
    const { svc, repo, oauth } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await svc.update('ws-1', 'user-1', 'srv-1', {
      url: 'https://new.example.com',
    } as any);

    expect(oauth.resetGrant).toHaveBeenCalledWith('srv-1');
  });

  it('MINOR 1: resets the grant BEFORE writing the new url (no interleave window)', async () => {
    const { svc, repo, oauth } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await svc.update('ws-1', 'user-1', 'srv-1', {
      url: 'https://new.example.com',
    } as any);

    // R1: the grant delete must land BEFORE the row rewrite, so a concurrent tour
    // can never read the NEW url with a still-`connected` grant.
    expect(oauth.resetGrant.mock.invocationCallOrder[0]).toBeLessThan(
      repo.updateForUser.mock.invocationCallOrder[0],
    );
  });

  it('transport change on an oauth2 server resets the grant', async () => {
    const { svc, repo, oauth } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await svc.update('ws-1', 'user-1', 'srv-1', { transport: 'sse' } as any);

    expect(oauth.resetGrant).toHaveBeenCalledWith('srv-1');
  });

  it('a name-only edit does NOT reset the grant', async () => {
    const { svc, repo, oauth } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await svc.update('ws-1', 'user-1', 'srv-1', { name: 'renamed' } as any);

    expect(oauth.resetGrant).not.toHaveBeenCalled();
  });

  it('MINOR 2: rejects static headers on an oauth2 server (400), no write', async () => {
    const { svc, repo } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await expect(
      svc.update('ws-1', 'user-1', 'srv-1', {
        headers: { Authorization: 'Bearer x' },
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.updateForUser).not.toHaveBeenCalled();
  });
});

describe('startOauth / disconnectOauth', () => {
  it('startOauth delegates and returns the authorize URL', async () => {
    const { svc, repo, oauth, clients } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    const res = await svc.startOauth('ws-1', 'user-1', 'srv-1');

    expect(res).toEqual({ authorizeUrl: 'https://as.example.com/authorize?x=1' });
    expect(oauth.startAuthorization).toHaveBeenCalledWith('user-1', {
      id: 'srv-1',
      workspaceId: 'ws-1',
      url: 'https://mcp.example.com',
    });
    expect(clients.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-1');
  });

  it('startOauth on a static server -> 400', async () => {
    const { svc, repo } = build();
    repo.findByIdForUser.mockResolvedValue({ ...oauthRow, authType: 'static' });
    await expect(svc.startOauth('ws-1', 'user-1', 'srv-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('startOauth on a missing server -> 404', async () => {
    const { svc, repo } = build();
    repo.findByIdForUser.mockResolvedValue(undefined);
    await expect(svc.startOauth('ws-1', 'user-1', 'srv-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('disconnectOauth deletes the grant and evicts the cache', async () => {
    const { svc, repo, oauth, clients } = build();
    repo.findByIdForUser.mockResolvedValue(oauthRow);

    await expect(svc.disconnectOauth('ws-1', 'user-1', 'srv-1')).resolves.toEqual({
      success: true,
    });
    expect(oauth.disconnect).toHaveBeenCalledWith('srv-1');
    expect(clients.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-1');
  });
});
