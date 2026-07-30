import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getAccountMcpServers,
  createAccountMcpServer,
  updateAccountMcpServer,
  deleteAccountMcpServer,
  testAccountMcpServer,
  startAccountMcpOauth,
  disconnectAccountMcpOauth,
} from "@/features/account-mcp/services/account-mcp-server-service.ts";
import type {
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "@/features/ai-mcp/mcp-server-types.ts";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

// Own cache key, distinct from the admin `["ai-mcp-servers"]` list (#686), so
// the personal and admin lists never share/invalidate each other.
const accountMcpServersKey = ["account-mcp-servers"];

export function useAccountMcpServersQuery(
  enabled: boolean = true,
): UseQueryResult<IAiMcpServer[], Error> {
  return useQuery({
    queryKey: accountMcpServersKey,
    queryFn: () => getAccountMcpServers(),
    enabled,
  });
}

export function useCreateAccountMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiMcpServer, Error, IAiMcpServerCreate>({
    mutationFn: (data) => createAccountMcpServer(data),
    onSuccess: () => {
      notifications.show({ message: t("Created successfully") });
      queryClient.invalidateQueries({ queryKey: accountMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useUpdateAccountMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiMcpServer, Error, IAiMcpServerUpdate>({
    mutationFn: (data) => updateAccountMcpServer(data),
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: accountMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useDeleteAccountMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<{ success: true }, Error, string>({
    mutationFn: (id) => deleteAccountMcpServer(id),
    onSuccess: () => {
      notifications.show({ message: t("Deleted successfully") });
      queryClient.invalidateQueries({ queryKey: accountMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

// Tests a saved personal server by id. The result ({ ok, tools } | { ok, error })
// is rendered inline by the caller, so this mutation has no notifications.
export function useTestAccountMcpServerMutation() {
  return useMutation<IAiMcpServerTestResult, Error, string>({
    mutationFn: (id) => testAccountMcpServer(id),
  });
}

// #687: begin the OAuth flow for an oauth2 server, then navigate the WHOLE tab to
// the returned authorize URL (Google consent). A full-page navigation (not a
// popup) keeps the `authToken` cookie on the top-level callback GET.
export function useStartAccountMcpOauthMutation() {
  const { t } = useTranslation();

  return useMutation<{ authorizeUrl: string }, Error, string>({
    mutationFn: (id) => startAccountMcpOauth(id),
    onSuccess: (data) => {
      window.location.assign(data.authorizeUrl);
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Could not start authorization"),
        color: "red",
      });
    },
  });
}

// #687: disconnect (delete the grant) for an oauth2 server.
export function useDisconnectAccountMcpOauthMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<{ success: true }, Error, string>({
    mutationFn: (id) => disconnectAccountMcpOauth(id),
    onSuccess: () => {
      notifications.show({ message: t("Disconnected successfully") });
      queryClient.invalidateQueries({ queryKey: accountMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}
