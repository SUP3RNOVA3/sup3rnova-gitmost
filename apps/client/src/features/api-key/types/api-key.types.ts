// Compact creator attribution embedded in the admin (workspace-wide) list. A
// normal member's list only ever contains their own keys, so the field is
// present but redundant; the author column is only rendered for admins.
export interface IApiKeyCreator {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// A single api-key row as returned by `POST /api/api-keys/list`. Note: the list
// NEVER carries token material — only metadata.
export interface IApiKey {
  id: string;
  name: string;
  // ISO string, or null for an unlimited ("never expires") key.
  expiresAt: string | null;
  // ISO string, or null if the key was never used. Throttled to ~1h server-side
  // (#501), so the UI must not promise sub-hour precision.
  lastUsedAt: string | null;
  createdAt: string;
  creator?: IApiKeyCreator | null;
}

// Payload for `POST /api/api-keys/create`. `expiresAt`: an ISO date string for a
// bounded lifetime, or null for an unlimited key. (undefined would let the
// server apply its 1-year default, but the form always sends an explicit value.)
export interface ICreateApiKey {
  name: string;
  expiresAt: string | null;
}

// The metadata half of the create response. The token itself is carried
// separately (see ICreateApiKeyResponse) and is shown exactly once.
export interface ICreatedApiKey {
  id: string;
  name: string;
  expiresAt: string | null;
  createdAt: string;
}

// Response of `POST /api/api-keys/create`. `token` is the ONLY time the secret
// is ever returned — it must live only in the show-once modal's local state and
// must never be cached, persisted or logged.
export interface ICreateApiKeyResponse {
  token: string;
  apiKey: ICreatedApiKey;
}
