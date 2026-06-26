import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useAiMcpServersQuery,
  useDeleteAiMcpServerMutation,
  useUpdateAiMcpServerMutation,
} from "@/features/workspace/queries/ai-mcp-server-query.ts";
import { IAiMcpServer } from "@/features/workspace/services/ai-mcp-server-service.ts";
import AiMcpServerForm from "./ai-mcp-server-form.tsx";
import AiMcpServerRow from "./ai-mcp-server-row.tsx";

/**
 * Admin section: list / add / edit / delete external MCP servers the agent may
 * use (web search, etc.). The add/edit form (incl. the per-server Test) lives in
 * `AiMcpServerForm`, opened in a modal. Auth headers are write-only and never
 * shown (only `hasHeaders` is known client-side).
 */
export default function AiMcpServers() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  // Only admins may read/manage external servers; the server enforces this too.
  const { data: servers, isLoading } = useAiMcpServersQuery(isAdmin);
  const updateMutation = useUpdateAiMcpServerMutation();
  const deleteMutation = useDeleteAiMcpServerMutation();

  const [opened, { open, close }] = useDisclosure(false);
  // The server being edited; undefined means the modal is in "create" mode.
  const [editing, setEditing] = useState<IAiMcpServer | undefined>(undefined);

  if (!isAdmin) {
    return (
      <Text size="sm" c="dimmed">
        {t("Only workspace admins can manage AI provider settings.")}
      </Text>
    );
  }

  function openCreate() {
    setEditing(undefined);
    open();
  }

  function openEdit(server: IAiMcpServer) {
    setEditing(server);
    open();
  }

  function confirmDelete(server: IAiMcpServer) {
    modals.openConfirmModal({
      title: t("Delete server"),
      children: (
        <Text size="sm">
          {t("Are you sure you want to delete this MCP server?")}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(server.id),
    });
  }

  return (
    <Paper withBorder radius="md" p="lg">
      {/* Header: status dot + title + "MCP client" badge + Add server */}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="xs" align="center" wrap="nowrap">
          <Box
            w={9}
            h={9}
            bg="green.6"
            style={{ borderRadius: "50%", flex: "none" }}
          />
          <Text fw={600}>{t("External tools")}</Text>
          <Badge size="sm" variant="light" color="gray">
            {t("Gitmost as MCP client")}
          </Badge>
        </Group>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="default"
          size="xs"
          onClick={openCreate}
        >
          {t("Add server")}
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {t("Servers the agent calls out to.")}
      </Text>

      {!isLoading && (!servers || servers.length === 0) && (
        <Text size="sm" c="dimmed" mt="sm">
          {t("No external servers configured")}
        </Text>
      )}

      <Stack gap="xs" mt="sm">
        {servers?.map((server) => (
          // Keyed by id (never remounts) so each row keeps its own test state.
          <AiMcpServerRow
            key={server.id}
            server={server}
            onEdit={openEdit}
            onDelete={confirmDelete}
            onToggleEnabled={(s, enabled) =>
              updateMutation.mutate({ id: s.id, enabled })
            }
          />
        ))}
      </Stack>

      <Modal
        opened={opened}
        onClose={close}
        title={editing ? t("Edit server") : t("Add server")}
        size="lg"
      >
        {/* Remount the form per target so its internal state re-hydrates. */}
        <AiMcpServerForm
          key={editing?.id ?? "new"}
          server={editing}
          onClose={close}
        />
      </Modal>
    </Paper>
  );
}
