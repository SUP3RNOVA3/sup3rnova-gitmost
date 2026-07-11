import api from "@/lib/api-client";
import {
  IApiKey,
  ICreateApiKey,
  ICreateApiKeyResponse,
} from "@/features/api-key/types/api-key.types";

// Mint a new key. The response carries the token ONCE — the caller must move it
// straight into the show-once modal's local state and never cache it (see
// use-api-key-query / create-api-key-modal for the reset()-after-read pattern).
export async function createApiKey(
  data: ICreateApiKey,
): Promise<ICreateApiKeyResponse> {
  const res = await api.post<ICreateApiKeyResponse>("/api-keys/create", data);
  return res.data as ICreateApiKeyResponse;
}

// List the caller's keys (or, for an admin, every key in the workspace with
// creator attribution). Never returns token material.
export async function getApiKeys(): Promise<IApiKey[]> {
  const res = await api.post<IApiKey[]>("/api-keys/list");
  return res.data as IApiKey[];
}

// Revocation is server-side immediate; the caller drops the row on success.
export async function revokeApiKey(id: string): Promise<void> {
  await api.post("/api-keys/revoke", { id });
}
