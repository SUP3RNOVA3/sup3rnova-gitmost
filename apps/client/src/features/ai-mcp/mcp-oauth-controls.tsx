import { Badge, Button, Group } from "@mantine/core";
import { IconKey, IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IAiMcpServer, McpGrantStatus } from "./mcp-server-types.ts";
import {
  UseAuthorizeMcpOauthMutation,
  UseDisconnectMcpOauthMutation,
} from "./mcp-mutation-hooks.ts";

interface McpOauthControlsProps {
  server: IAiMcpServer;
  // Each control owns its own mutation instance (per-row loading), mirroring the
  // shared row's Test hook. Always rendered when present, so hooks are called
  // unconditionally (rules-of-hooks safe).
  useAuthorizeMutation: UseAuthorizeMcpOauthMutation;
  useDisconnectMutation: UseDisconnectMcpOauthMutation;
}

/** Status badge presentation for an OAuth grant. */
function grantBadge(status: McpGrantStatus | null): {
  color: string;
  label: string;
} {
  switch (status) {
    case "connected":
      return { color: "green", label: "Connected" };
    case "expired":
      return { color: "orange", label: "Needs re-authorization" };
    case "error":
      return { color: "red", label: "Error" };
    case "pending":
      return { color: "gray", label: "Authorizing…" };
    default:
      return { color: "gray", label: "Not connected" };
  }
}

/**
 * OAuth controls for a personal oauth2 MCP server (#687): the grant status badge
 * plus Authorize / Reauthorize and Disconnect. Shown INSTEAD of the static-header
 * Test button. `Authorize` navigates the whole tab to the AS (handled by the
 * mutation hook); the callback returns to this page with `?oauth=connected|error`.
 */
export default function McpOauthControls({
  server,
  useAuthorizeMutation,
  useDisconnectMutation,
}: McpOauthControlsProps) {
  const { t } = useTranslation();
  const authorizeMutation = useAuthorizeMutation();
  const disconnectMutation = useDisconnectMutation();

  const status = server.grantStatus;
  const badge = grantBadge(status);
  // Connected/expired already have a grant → the action re-authorizes it.
  const isReauth = status === "connected" || status === "expired";
  const canDisconnect = status !== null && status !== "none";

  return (
    <Group gap="xs" wrap="nowrap">
      <Badge size="sm" variant="light" color={badge.color}>
        {t(badge.label)}
      </Badge>
      <Button
        size="xs"
        variant="default"
        leftSection={
          isReauth ? <IconRefresh size={16} /> : <IconKey size={16} />
        }
        loading={authorizeMutation.isPending}
        onClick={() => authorizeMutation.mutate(server.id)}
      >
        {isReauth ? t("Reauthorize") : t("Authorize")}
      </Button>
      {canDisconnect && (
        <Button
          size="xs"
          variant="subtle"
          color="red"
          leftSection={<IconPlugConnectedX size={16} />}
          loading={disconnectMutation.isPending}
          onClick={() => disconnectMutation.mutate(server.id)}
        >
          {t("Disconnect")}
        </Button>
      )}
    </Group>
  );
}
