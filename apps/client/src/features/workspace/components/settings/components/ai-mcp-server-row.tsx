import { useEffect } from "react";
import { ActionIcon, Badge, Button, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import {
  IconCheck,
  IconPencil,
  IconPlugConnected,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useTestAiMcpServerMutation } from "@/features/workspace/queries/ai-mcp-server-query.ts";
import { IAiMcpServer } from "@/features/workspace/services/ai-mcp-server-service.ts";

interface AiMcpServerRowProps {
  server: IAiMcpServer;
  onEdit: (server: IAiMcpServer) => void;
  onDelete: (server: IAiMcpServer) => void;
  onToggleEnabled: (server: IAiMcpServer, enabled: boolean) => void;
}

/**
 * A single external MCP server row with an inline "Test" button. Each row owns
 * its OWN test mutation instance so the loading/result state is isolated per
 * row — a list-level mutation would make every row's spinner and colour jump on
 * any single test (#170).
 */
export default function AiMcpServerRow({
  server,
  onEdit,
  onDelete,
  onToggleEnabled,
}: AiMcpServerRowProps) {
  const { t } = useTranslation();
  const testMutation = useTestAiMcpServerMutation();

  // The result colour/label reflects the connection params at the time of the
  // test. The row is keyed by id and never remounts, so a stale "OK"/"Failed"
  // would otherwise stick after the connection params change. Reset on those.
  // Note: `hasHeaders` is a presence flag only (header values are write-only and
  // never returned), so this resets on adding/removing auth headers, NOT on
  // rotating a token's value — that value-only change is invisible to the client.
  useEffect(() => {
    testMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.url, server.transport, server.hasHeaders]);

  const result = testMutation.data;

  // Derive the button's appearance from the test outcome. Colour is never the
  // only signal — the label changes too (a11y / colour-blind friendly).
  let label = t("Test");
  let color: string | undefined;
  let variant = "default";
  let icon = <IconPlugConnected size={16} />;
  let tooltip: string | undefined;

  if (result?.ok) {
    label = t("OK · {{count}}", { count: result.tools.length });
    color = "green";
    variant = "light";
    icon = <IconCheck size={16} />;
    tooltip =
      result.tools.length > 0
        ? result.tools.join(", ")
        : t("No tools available");
  } else if (result && "error" in result) {
    // Server-reported failure ({ ok: false, error }, HTTP 200). The error string
    // is already sanitized server-side (no secrets). The `"error" in result`
    // guard is required: `result?.ok` optional-chaining doesn't narrow the union
    // in the else branch, so a bare `else if (result)` fails to type-check.
    label = t("Failed");
    color = "red";
    variant = "light";
    icon = <IconX size={16} />;
    tooltip = result.error;
  } else if (testMutation.isError) {
    // The request itself rejected (401/403/500/network) — there is no result
    // payload, so without this the row would silently revert to "Test".
    label = t("Failed");
    color = "red";
    variant = "light";
    icon = <IconX size={16} />;
    tooltip =
      testMutation.error?.["response"]?.data?.message ??
      t("Failed to update data");
  }

  const testButton = (
    <Button
      size="xs"
      variant={variant}
      color={color}
      // Fixed min-width so the row does not jump as the label changes
      // (Test -> OK · 5 -> Failed).
      miw={88}
      leftSection={icon}
      // Mantine disables the button automatically while loading.
      loading={testMutation.isPending}
      onClick={() => testMutation.mutate(server.id)}
    >
      {label}
    </Button>
  );

  return (
    <Group justify="space-between" wrap="nowrap">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap="xs">
          <Text fw={500} truncate>
            {server.name}
          </Text>
          <Badge size="xs" variant="light">
            {server.transport.toUpperCase()}
          </Badge>
        </Group>
        <Text
          size="xs"
          c="dimmed"
          truncate
          style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
        >
          {server.url}
        </Text>
      </Stack>

      <Group gap="xs" wrap="nowrap">
        {/* Show the tooltip (tools list / error) only once there is a result. */}
        {tooltip ? (
          <Tooltip label={tooltip} multiline maw={320} withArrow>
            {testButton}
          </Tooltip>
        ) : (
          testButton
        )}
        <Switch
          size="sm"
          checked={server.enabled}
          aria-label={t("Enabled")}
          onChange={(event) =>
            onToggleEnabled(server, event.currentTarget.checked)
          }
        />
        <ActionIcon
          variant="subtle"
          aria-label={t("Edit")}
          onClick={() => onEdit(server)}
        >
          <IconPencil size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={t("Delete")}
          onClick={() => onDelete(server)}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
