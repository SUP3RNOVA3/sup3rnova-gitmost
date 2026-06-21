import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { vaultGitEnv } from '@docmost/git-sync';
import { EnvironmentService } from '../../environment/environment.service';

/** The parsed first part of a CGI response: the HTTP status + header pairs. */
export interface ParsedCgiResponse {
  statusCode: number;
  /** Lower-cased? No — keep header names verbatim as git http-backend emits. */
  headers: Array<[string, string]>;
}

/**
 * Parse the CGI header block emitted by `git http-backend` into an HTTP status
 * and a list of header pairs. The input is ONLY the header text (everything up
 * to, but not including, the blank-line separator) — the binary body is split
 * off by the caller on the raw Buffer (never stringified).
 *
 * CGI semantics (RFC 3875 §6): a `Status: <code> <reason>` header sets the HTTP
 * status (default 200 when absent). Every other header is forwarded verbatim.
 * Header lines are `Name: value`; a line without a ':' is ignored defensively.
 *
 * Pure + framework-free so it is unit-testable in isolation.
 */
export function parseCgiResponse(headerBlock: string): ParsedCgiResponse {
  let statusCode = 200;
  const headers: Array<[string, string]> = [];

  // Header lines may be separated by CRLF or LF; split on either.
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue; // not a header line — ignore defensively
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (name.toLowerCase() === 'status') {
      // `Status: 404 Not Found` — the leading integer is the HTTP status code.
      const code = parseInt(value, 10);
      if (Number.isFinite(code) && code >= 100 && code <= 599) {
        statusCode = code;
      }
      continue; // never forward the CGI Status header itself
    }
    headers.push([name, value]);
  }

  return { statusCode, headers };
}

/**
 * Split a raw CGI response buffer at the first blank-line boundary
 * (`\r\n\r\n` or `\n\n`). Returns the header text and the remaining body bytes.
 * Returns null when no blank-line separator is present (a malformed response).
 *
 * Pure (operates on Buffers, never stringifies the body) so it is testable.
 */
export function splitCgiBuffer(
  buf: Buffer,
): { headerText: string; body: Buffer } | null {
  // Prefer the CRLF separator; fall back to bare LF.
  let idx = buf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx === -1) {
    idx = buf.indexOf('\n\n');
    sepLen = 2;
  }
  if (idx === -1) return null;
  const headerText = buf.subarray(0, idx).toString('utf8');
  const body = buf.subarray(idx + sepLen);
  return { headerText, body };
}

/** A parsed git smart-HTTP request, resolved by the controller/handler. */
export interface GitHttpBackendRequest {
  /** The space id (the on-disk vault dir name == GIT_PROJECT_ROOT child). */
  spaceId: string;
  /** The subpath after `<spaceId>.git/`, e.g. `info/refs` or `git-receive-pack`. */
  subpath: string;
  /** REQUEST_METHOD — `GET` or `POST`. */
  method: string;
  /** Raw query string WITHOUT the leading '?', e.g. `service=git-receive-pack`. */
  queryString: string;
  /** Content-Type header value (may be empty for GET). */
  contentType: string;
  /** The Git-Protocol request header value, or undefined when absent. */
  gitProtocol?: string;
  /** Authenticated user email — used as REMOTE_USER (reflog identity). */
  remoteUser: string;
}

/**
 * Bridges an HTTP git smart-protocol request to `git http-backend` (the CGI that
 * implements the entire smart-HTTP protocol: info/refs, upload-pack,
 * receive-pack, protocol v2, dumb fallback). We do NOT reimplement pkt-line.
 *
 * The Fastify reply is hijacked by the caller; this service streams the request
 * body to the child's stdin and writes the child's CGI response (status +
 * headers parsed from the leading header block, then the raw binary body) to the
 * Node response. Errors before any output produce a 500. Credentials are never
 * logged.
 */
@Injectable()
export class GitHttpBackendService {
  private readonly logger = new Logger(GitHttpBackendService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  /**
   * Spawn `git http-backend` for one request and bridge it to the raw Node
   * request/response. Resolves when the response has been fully written (the
   * child exited and its output was flushed), or after a 500 was sent on an
   * early failure. Never rejects — push ingestion relies on this resolving so
   * the lock-held cycle body can run afterwards.
   */
  async run(
    parsed: GitHttpBackendRequest,
    rawReq: IncomingMessage,
    rawRes: ServerResponse,
  ): Promise<void> {
    const projectRoot = this.environmentService.getGitSyncDataDir();
    // PATH_INFO is the repo-relative CGI path: /<spaceId>.git/<subpath>.
    const pathInfo = `/${parsed.spaceId}.git/${parsed.subpath}`;

    // Build the CGI env from the engine's cwd-isolated base (strips GIT_DIR /
    // GIT_WORK_TREE), then layer the http-backend CGI variables. GIT_PROTOCOL is
    // only set when the client sent the Git-Protocol header. PATH is preserved
    // (vaultGitEnv already copies process.env, so PATH carries through).
    const cgiEnv: Record<string, string> = {
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1', // authz is done by us; no git-daemon-export-ok file
      PATH_INFO: pathInfo,
      REQUEST_METHOD: parsed.method,
      QUERY_STRING: parsed.queryString,
      CONTENT_TYPE: parsed.contentType,
      REMOTE_USER: parsed.remoteUser,
    };
    if (parsed.gitProtocol) {
      cgiEnv.GIT_PROTOCOL = parsed.gitProtocol;
    }
    const env = vaultGitEnv(cgiEnv);

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', ['http-backend'], { env });
      } catch (err) {
        this.send500(rawRes, 'spawn-failed', err);
        return done();
      }

      // Accumulate stdout until we have the full CGI header block, then write the
      // parsed status/headers and start streaming the remaining body bytes.
      let headerParsed = false;
      let pending: Buffer = Buffer.alloc(0);

      const flushHeadersAndBody = (chunk: Buffer): void => {
        pending = Buffer.concat([pending, chunk]);
        const split = splitCgiBuffer(pending);
        if (!split) return; // header block not complete yet
        headerParsed = true;
        const { statusCode, headers } = parseCgiResponse(split.headerText);
        rawRes.statusCode = statusCode;
        for (const [name, value] of headers) {
          rawRes.setHeader(name, value);
        }
        if (split.body.length > 0) rawRes.write(split.body);
        pending = Buffer.alloc(0);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (headerParsed) {
          rawRes.write(chunk);
        } else {
          flushHeadersAndBody(chunk);
        }
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        // Capture for diagnostics; never echo to the client. http-backend writes
        // CGI errors here. We do NOT log the request body or any credentials.
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (!headerParsed && !rawRes.headersSent) {
          this.send500(rawRes, 'child-error', err);
        } else {
          // Output already started — we can only terminate the stream.
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      child.on('close', (code) => {
        if (!headerParsed && !rawRes.headersSent) {
          // The child exited before emitting a complete CGI header block.
          this.logger.error(
            `git http-backend produced no valid response (exit ${code}) for ` +
              `space; stderr: ${stderr.trim().slice(0, 500)}`,
          );
          this.send500(rawRes, 'no-output');
        } else {
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      // Pipe the request body to the child's stdin. For GET there is no body, so
      // end stdin immediately. We pipe `rawReq` (the raw Node stream) directly so
      // large pushes are streamed, not buffered.
      if (parsed.method === 'POST') {
        rawReq.pipe(child.stdin!);
        rawReq.on('error', () => {
          try {
            child.stdin?.end();
          } catch {
            /* ignore */
          }
        });
      } else {
        child.stdin?.end();
      }
      // Swallow EPIPE etc. on the child's stdin so a client disconnect does not
      // crash the process.
      child.stdin?.on('error', () => {
        /* ignore broken-pipe on stdin */
      });
    });
  }

  /** Send a clean 500 without leaking credentials or the request body. */
  private send500(rawRes: ServerResponse, reason: string, err?: unknown): void {
    const message = err instanceof Error ? err.message : undefined;
    this.logger.error(
      `git http-backend failed (${reason})${message ? `: ${message}` : ''}`,
    );
    try {
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('Content-Type', 'text/plain');
      }
      rawRes.end('Internal server error');
    } catch {
      /* ignore */
    }
  }
}
