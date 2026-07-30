import { BadRequestException } from '@nestjs/common';
import { AiMcpServer } from '@docmost/db/types/entity.types';
import { SecretBoxService } from '../../../integrations/crypto/secret-box';
import { isUrlAllowed } from './ssrf-guard';

/**
 * Public view of an external MCP server row (§8.10). SECURITY: `headersEnc` is
 * NEVER part of this shape — only `hasHeaders` signals whether auth headers are
 * configured. Shared (#686) by the admin (`McpServersService`) and the personal
 * (`AccountMcpServersService`) paths so the write-only-headers projection has a
 * SINGLE definition — a drift here would leak the encrypted blob on one path,
 * so per AGENTS invariant #7 both paths consume this one function, never a copy.
 */
export interface McpServerView {
  id: string;
  name: string;
  transport: string;
  url: string;
  enabled: boolean;
  toolAllowlist: string[] | null;
  hasHeaders: boolean;
  // Author-supplied prompt guidance (#180). NON-secret, so returned in the
  // view. Null when no guidance is configured.
  instructions: string | null;
  // #687: 'static' | 'oauth2'. Static servers use auth headers; oauth2 servers
  // use the OAuth grant + Authorize/Disconnect controls.
  authType: string;
  // #687: OAuth grant status for an oauth2 server ('none' | 'pending' |
  // 'connected' | 'expired' | 'error'). null for a static server. NEVER a token.
  grantStatus: string | null;
}

/**
 * Project a row to the public view (NEVER includes headersEnc). `grantStatus`
 * (#687) is supplied by the caller for an oauth2 server (looked up from
 * `ai_mcp_oauth_grants`); null for a static server.
 */
export function toMcpServerView(
  row: AiMcpServer,
  grantStatus: string | null = null,
): McpServerView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    enabled: row.enabled,
    toolAllowlist: row.toolAllowlist ?? null,
    hasHeaders: Boolean(row.headersEnc),
    instructions: row.instructions ?? null,
    authType: row.authType,
    grantStatus: row.authType === 'oauth2' ? (grantStatus ?? 'none') : null,
  };
}

/** Encrypt a non-empty header map to a blob; undefined for empty/absent. */
export function encryptMcpHeaders(
  secretBox: SecretBoxService,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  // Keep only non-empty string values; drop anything else defensively.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v.length > 0) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return undefined;
  return secretBox.encryptSecret(JSON.stringify(clean));
}

/** Throw a clear BadRequest when the URL is disallowed by the SSRF policy. */
export async function assertMcpUrlAllowed(url: string): Promise<void> {
  const check = await isUrlAllowed(url);
  if (!check.ok) {
    throw new BadRequestException(
      `URL not allowed: ${check.reason ?? 'blocked by SSRF policy'}`,
    );
  }
}
