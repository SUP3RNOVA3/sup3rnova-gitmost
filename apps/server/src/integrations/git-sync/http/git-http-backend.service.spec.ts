// Unit tests for the pure CGI-response helpers used by GitHttpBackendService.
// The header/body split MUST treat the body as binary (Buffer) and never
// stringify it; the Status: header sets the HTTP status (default 200).
import {
  parseCgiResponse,
  splitCgiBuffer,
  buildGitBackendCgiEnv,
} from './git-http-backend.service';

describe('buildGitBackendCgiEnv', () => {
  const base = {
    spaceId: 'space-1',
    subpath: 'info/refs',
    method: 'GET',
    queryString: 'service=git-upload-pack',
    contentType: '',
    remoteUser: 'alice@example.com',
  };

  it('points PATH_INFO at the NON-bare repo dir (no .git suffix)', () => {
    // Regression guard: the vault lives at <root>/<spaceId> (a working repo), so
    // PATH_INFO must be /<spaceId>/<subpath>. A `.git` suffix made git
    // http-backend resolve <root>/<spaceId>.git and 404 every fetch/push.
    const env = buildGitBackendCgiEnv(base, '/vaults');
    expect(env.PATH_INFO).toBe('/space-1/info/refs');
    expect(env.PATH_INFO).not.toContain('.git');
    expect(env.GIT_PROJECT_ROOT).toBe('/vaults');
  });

  it('forwards method/query/content-type/remote-user and exports all repos', () => {
    const env = buildGitBackendCgiEnv(
      { ...base, method: 'POST', subpath: 'git-receive-pack', contentType: 'application/x-git-receive-pack-request', queryString: '' },
      '/vaults',
    );
    expect(env.REQUEST_METHOD).toBe('POST');
    expect(env.PATH_INFO).toBe('/space-1/git-receive-pack');
    expect(env.CONTENT_TYPE).toBe('application/x-git-receive-pack-request');
    expect(env.REMOTE_USER).toBe('alice@example.com');
    expect(env.GIT_HTTP_EXPORT_ALL).toBe('1');
  });

  it('sets GIT_PROTOCOL only when the client sent the header', () => {
    expect(buildGitBackendCgiEnv(base, '/vaults').GIT_PROTOCOL).toBeUndefined();
    expect(
      buildGitBackendCgiEnv({ ...base, gitProtocol: 'version=2' }, '/vaults')
        .GIT_PROTOCOL,
    ).toBe('version=2');
  });
});

describe('parseCgiResponse', () => {
  it('defaults to status 200 with no Status header', () => {
    const r = parseCgiResponse('Content-Type: application/x-git-upload-pack-result');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'application/x-git-upload-pack-result'],
    ]);
  });

  it('honors a Status header and does not forward it', () => {
    const r = parseCgiResponse('Status: 404 Not Found\nContent-Type: text/plain');
    expect(r.statusCode).toBe(404);
    expect(r.headers).toEqual([['Content-Type', 'text/plain']]);
  });

  it('parses multiple headers and trims whitespace', () => {
    const r = parseCgiResponse(
      'Status: 403 Forbidden\r\nContent-Type:  text/plain \r\nX-Foo:  bar ',
    );
    expect(r.statusCode).toBe(403);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-Foo', 'bar'],
    ]);
  });

  it('ignores malformed (colon-less) lines defensively', () => {
    const r = parseCgiResponse('Content-Type: text/plain\ngarbage-line\nX-A: b');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-A', 'b'],
    ]);
  });

  it('ignores an out-of-range Status code and keeps the default', () => {
    const r = parseCgiResponse('Status: not-a-number\nContent-Type: text/plain');
    expect(r.statusCode).toBe(200);
  });

  it('treats the Status header case-insensitively', () => {
    const r = parseCgiResponse('status: 500 Boom');
    expect(r.statusCode).toBe(500);
    expect(r.headers).toEqual([]);
  });
});

describe('splitCgiBuffer', () => {
  it('splits on a CRLF blank line and keeps the body as bytes', () => {
    const buf = Buffer.concat([
      Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    ]);
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Status: 200 OK\r\nContent-Type: text/plain');
    expect(Array.from(split!.body)).toEqual([0x00, 0x01, 0x02, 0xff]);
  });

  it('splits on a bare LF blank line', () => {
    const buf = Buffer.from('Content-Type: text/plain\n\nhello', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Content-Type: text/plain');
    expect(split!.body.toString('utf8')).toBe('hello');
  });

  it('returns an empty body when nothing follows the separator', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\n\r\n', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.body.length).toBe(0);
  });

  it('returns null when there is no blank-line separator yet', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\nincomplete', 'utf8');
    expect(splitCgiBuffer(buf)).toBeNull();
  });
});
