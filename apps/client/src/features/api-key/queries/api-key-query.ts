import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  createApiKey,
  getApiKeys,
  revokeApiKey,
} from "@/features/api-key/services/api-key-service";
import {
  IApiKey,
  ICreateApiKey,
  ICreateApiKeyResponse,
} from "@/features/api-key/types/api-key.types";

export const API_KEYS_QUERY_KEY = ["api-keys"];

export function useApiKeysQuery(): UseQueryResult<IApiKey[], Error> {
  return useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: () => getApiKeys(),
  });
}

/**
 * Create mutation.
 *
 * SECURITY: the response contains the token exactly once. This hook deliberately
 * does NOT stash it anywhere — the caller reads it from `mutateAsync`'s resolved
 * value, moves it into the show-once modal's local state, then calls
 * `mutation.reset()` to purge react-query's own copy immediately. `gcTime: 0`
 * is a second belt so nothing lingers in the mutation cache after the observer
 * unmounts. The list is invalidated here (the list carries no token).
 */
export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation<ICreateApiKeyResponse, Error, ICreateApiKey>({
    mutationFn: (data) => createApiKey(data),
    gcTime: 0,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => revokeApiKey(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      notifications.show({ message: t("API key revoked") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to revoke API key"),
        color: "red",
      });
    },
  });
}
