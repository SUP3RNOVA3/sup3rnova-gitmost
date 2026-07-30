import { Timestamp, Generated } from '@docmost/db/types/db';

// ai_mcp_oauth_grants type (#687)
// Hand-written (not generated) because codegen requires a live DB.
// Mirrors the migration 20260730T120000-ai-mcp-oauth-grants.ts.
//
// One row per OAuth 2.1 personal MCP server (1:1 with `ai_mcp_servers`, keyed by
// `server_id`, ON DELETE CASCADE). It carries the DCR-registered client
// credentials, the discovered authorization-server pins and the encrypted OAuth
// tokens minted through the flow.
//
// SECURITY (§8.10/#687): `access_token_enc`, `refresh_token_enc` and
// `client_secret_enc` are AES-256-GCM blobs (SecretBoxService). They are
// WRITE-ONLY — they must NEVER be returned by any endpoint nor written to logs.
// Only `status` is ever projected outward.
export interface AiMcpOauthGrants {
  // PK and FK to ai_mcp_servers.id (ON DELETE CASCADE): a grant is destroyed
  // with its server (and, transitively, with the server's owner).
  serverId: string;
  // DCR-registered OAuth client id at the authorization server.
  clientId: string;
  // Encrypted DCR client secret (null for a public client).
  clientSecretEnc: string | null;
  // The discovered authorization server URL (the credential pin). MANDATORY —
  // the SDK refuses to exchange an authorization code without stored AS
  // metadata ("Stored OAuth authorization server metadata is required ...").
  authorizationServer: string;
  // The authorize endpoint (informational; parsed from the authorize URL).
  authorizationEndpoint: string | null;
  // The token endpoint used for code exchange and our own refresh.
  tokenEndpoint: string;
  // Encrypted access token (null before the first successful callback).
  accessTokenEnc: string | null;
  // Encrypted refresh token (null before the first successful callback). NEVER
  // handed to the SDK via tokens() — refresh is done by our own code.
  refreshTokenEnc: string | null;
  // Absolute access-token expiry. Null when unknown.
  expiresAt: Timestamp | null;
  // Grant lifecycle status: 'pending' | 'connected' | 'expired' | 'error'.
  // (A missing row means 'none' — never authorized.)
  status: string;
  // Human-readable failure detail for the UI (callback error, revoked grant).
  errorDetail: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
