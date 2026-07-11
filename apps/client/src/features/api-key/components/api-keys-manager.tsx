import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconKey, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale";
import { timeAgo } from "@/lib/time";
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
} from "@/features/api-key/queries/api-key-query";
import {
  IApiKey,
  ICreateApiKeyResponse,
} from "@/features/api-key/types/api-key.types";
import {
  isExpired,
  isExpiringSoon,
  lastUsedBucket,
} from "@/features/api-key/utils";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { ShowTokenModal } from "./show-token-modal";

export default function ApiKeysManager() {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  // Manage-on-API === Owner/Admin server-side, so the admin (workspace-wide)
  // list + "author" column mirror exactly the roles the server serves the
  // whole-workspace response to.
  const { isAdmin } = useUserRole();

  const { data: keys, isLoading, isError } = useApiKeysQuery();
  const createMutation = useCreateApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();

  const [createOpened, setCreateOpened] = useState(false);
  // SECURITY: the show-once token lives ONLY here, in this component's local
  // state. It is never written to localStorage, the query cache or a log. Closing
  // the modal sets it back to null (handleCloseToken) — discarded forever.
  const [createdKey, setCreatedKey] = useState<ICreateApiKeyResponse | null>(
    null,
  );

  const handleCreate = async (values: {
    name: string;
    expiresAt: string | null;
  }): Promise<boolean> => {
    try {
      const res = await createMutation.mutateAsync(values);
      setCreateOpened(false);
      // Move the token into local state, then immediately purge react-query's
      // own copy of the mutation result so the secret does not linger in the
      // mutation cache.
      setCreatedKey(res);
      createMutation.reset();
      return true;
    } catch {
      notifications.show({
        message: t("Failed to create API key"),
        color: "red",
      });
      return false;
    }
  };

  const handleCloseToken = () => {
    // Token discarded — the only copy the UI ever held is dropped here.
    setCreatedKey(null);
  };

  const openRevokeModal = (key: IApiKey) =>
    modals.openConfirmModal({
      title: t("Revoke API key"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            'Are you sure you want to revoke "{{name}}"? Any client using this key will immediately lose access. This cannot be undone.',
            { name: key.name },
          )}
        </Text>
      ),
      labels: { confirm: t("Revoke"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revokeMutation.mutate(key.id),
    });

  const formatDate = (iso: string) =>
    formatLocalized(new Date(iso), "MMM dd, yyyy", "PP", locale);

  const renderLastUsed = (lastUsedAt: string | null) => {
    switch (lastUsedBucket(lastUsedAt)) {
      case "never":
        return t("Never used");
      case "recent":
        return t("Within the last hour");
      case "stale":
        // Coarse relative time — last_used_at is throttled to ~1h server-side,
        // so we don't promise finer precision.
        return timeAgo(new Date(lastUsedAt as string));
    }
  };

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  const rows = (keys ?? []).map((key) => {
    // Mutually exclusive: an already-expired key is labelled "Expired" (a past
    // expiry) rather than the forward-looking "Expiring soon". isExpiringSoon
    // also matches past expiries, so gate "soon" on !expired.
    const expired = isExpired(key.expiresAt);
    const soon = !expired && isExpiringSoon(key.expiresAt);
    return (
      <Table.Tr key={key.id}>
        <Table.Td>
          <Text fw={500}>{key.name}</Text>
        </Table.Td>
        <Table.Td>{formatDate(key.createdAt)}</Table.Td>
        <Table.Td>
          {key.expiresAt ? (
            <Group gap={6} wrap="nowrap">
              <Text size="sm">{formatDate(key.expiresAt)}</Text>
              {expired && (
                <Tooltip label={t("This key has expired")} withArrow>
                  <Badge
                    color="red"
                    variant="light"
                    size="sm"
                    leftSection={<IconAlertTriangle size={12} />}
                  >
                    {t("Expired")}
                  </Badge>
                </Tooltip>
              )}
              {soon && (
                <Tooltip
                  label={t("This key expires within 30 days")}
                  withArrow
                >
                  <Badge
                    color="orange"
                    variant="light"
                    size="sm"
                    leftSection={<IconAlertTriangle size={12} />}
                  >
                    {t("Expiring soon")}
                  </Badge>
                </Tooltip>
              )}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              {t("Never")}
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <Text size="sm" c="dimmed">
            {renderLastUsed(key.lastUsedAt)}
          </Text>
        </Table.Td>
        {isAdmin && (
          <Table.Td>
            <Text size="sm">
              {key.creator?.name ?? key.creator?.email ?? t("Unknown")}
            </Text>
          </Table.Td>
        )}
        <Table.Td style={{ textAlign: "right" }}>
          <Tooltip label={t("Revoke")} withArrow>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t("Revoke {{name}}", { name: key.name })}
              onClick={() => openRevokeModal(key)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Table.Td>
      </Table.Tr>
    );
  });

  return (
    <>
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed">
          {isAdmin
            ? t("API keys across the workspace.")
            : t("Your personal API keys.")}
        </Text>
        <Button
          leftSection={<IconKey size={16} />}
          onClick={() => setCreateOpened(true)}
        >
          {t("Create API key")}
        </Button>
      </Group>

      {isError ? (
        <Text c="red" size="sm">
          {t("Failed to load API keys.")}
        </Text>
      ) : rows.length === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <IconKey size={32} opacity={0.4} />
          <Text c="dimmed">{t("No API keys yet")}</Text>
          <Button
            variant="light"
            leftSection={<IconKey size={16} />}
            onClick={() => setCreateOpened(true)}
          >
            {t("Create API key")}
          </Button>
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Name")}</Table.Th>
                <Table.Th>{t("Created")}</Table.Th>
                <Table.Th>{t("Expires")}</Table.Th>
                <Table.Th>{t("Last used")}</Table.Th>
                {isAdmin && <Table.Th>{t("Author")}</Table.Th>}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <CreateApiKeyModal
        opened={createOpened}
        onClose={() => setCreateOpened(false)}
        onSubmit={handleCreate}
        loading={createMutation.isPending}
      />

      <ShowTokenModal created={createdKey} onClose={handleCloseToken} />
    </>
  );
}
