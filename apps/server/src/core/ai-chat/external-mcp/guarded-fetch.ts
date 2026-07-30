import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, type Dispatcher } from 'undici';
import {
  streamingDispatcherOptions,
  mcpStreamTimeoutMs,
} from '../../../integrations/ai/ai-streaming-fetch';
import { isUrlAllowed, isIpAllowed } from './ssrf-guard';

/**
 * SSRF-pinned outbound fetch for external-MCP traffic (#686/#687). This is the
 * SINGLE source of the pinned-dispatcher + per-request guard: both the
 * external-MCP client (`mcp-clients.service.ts`) and the OAuth flow
 * (`mcp-oauth.service.ts`) import from here, so the DNS-rebinding defense is
 * never duplicated (AGENTS #7). The OAuth start-flow calls `auth()` OUTSIDE the
 * transport, so it MUST pass a fetch built here explicitly or discovery/DCR/
 * token requests would bypass the pinning.
 */

/**
 * Apply the SSRF connect-time rule to a set of DNS-resolved addresses: block if
 * ANY resolved address is disallowed by `isIpAllowed`, and block an EMPTY set
 * (nothing safe to connect to). Only an all-public, non-empty set is allowed.
 * Pure — no I/O.
 */
export function validateResolvedAddresses(addrs: readonly LookupAddress[]): {
  ok: boolean;
  blockedHost?: string;
} {
  if (addrs.length === 0) {
    return { ok: false };
  }
  const blocked = addrs.find((a) => !isIpAllowed(a.address).ok);
  if (blocked) {
    return { ok: false, blockedHost: blocked.address };
  }
  return { ok: true };
}

/**
 * Build the SSRF-pinned undici dispatcher. Its custom connect.lookup resolves
 * the host, validates EVERY resolved address with the same ssrf-guard, and
 * returns ONLY a validated address to net/tls.connect — so there is no second,
 * unchecked DNS resolution. The hostname (SNI / Host header) is left untouched
 * so TLS certificate validation still uses the real hostname.
 */
export function buildPinnedDispatcher(bodyTimeoutMs: number): Agent {
  const headersMs = mcpStreamTimeoutMs();
  return new Agent({
    ...streamingDispatcherOptions(),
    headersTimeout: headersMs,
    bodyTimeout: bodyTimeoutMs,
    connect: {
      lookup: (hostname, _options, callback) => {
        // Always resolve ALL addresses ourselves; do not trust the caller's
        // `all` flag. Validate each, then hand back the validated set.
        dnsLookup(hostname, { all: true }, (err, addresses) => {
          if (err) {
            callback(err, '', 0);
            return;
          }
          const addrs = addresses as LookupAddress[];
          const verdict = validateResolvedAddresses(addrs);
          if (!verdict.ok) {
            const reason =
              addrs.length === 0
                ? `No address resolved for ${hostname}`
                : `Blocked address for ${hostname}`;
            callback(new Error(reason), '', 0);
            return;
          }
          const validated: LookupAddress[] = addrs.map((a) => ({
            address: a.address,
            family: a.family,
          }));
          (
            callback as unknown as (
              err: NodeJS.ErrnoException | null,
              addresses: LookupAddress[],
            ) => void
          )(null, validated);
        });
      },
    },
  });
}

/**
 * A fetch wrapper that re-validates the request URL's host against the SSRF
 * policy before each request AND routes it through the SSRF-pinned dispatcher,
 * so the socket can only connect to an address that passed the guard. Closes the
 * DNS-rebinding TOCTOU between the pre-flight check and the actual HTTP call, and
 * covers every follow-up request (transport streams, OAuth token calls).
 */
export const guardedFetch = async (
  dispatcher: Dispatcher,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('blocked request: invalid URL');
  }
  const check = isIP(host) ? isIpAllowed(host) : await isUrlAllowed(rawUrl);
  if (!check.ok) {
    throw new Error(`blocked request: ${check.reason ?? 'SSRF policy'}`);
  }
  return fetch(input, { ...init, dispatcher } as RequestInit);
};
