import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/components/common/copy-button";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale";
import { ICreateApiKeyResponse } from "@/features/api-key/types/api-key.types";

interface Props {
  // The freshly-created key incl. its token. Owned by the parent; this modal
  // only renders it and never copies it into its own persistent state.
  created: ICreateApiKeyResponse | null;
  // Closing MUST discard the token in the parent (set the `created` prop back to
  // null) — the token is shown exactly once.
  onClose: () => void;
}

export function ShowTokenModal({ created, onClose }: Props) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();

  const expiresAt = created?.apiKey.expiresAt ?? null;

  return (
    <Modal
      opened={created !== null}
      onClose={onClose}
      title={t("API key created")}
      centered
      // No dismiss-on-outside-click: the token is irretrievable, so closing is a
      // deliberate act (the user confirms they have saved it).
      closeOnClickOutside={false}
    >
      {created && (
        <Stack gap="sm">
          <Alert
            color="orange"
            icon={<IconAlertTriangle size={18} />}
            variant="light"
          >
            {t(
              "Copy your API key now and store it somewhere safe. For security reasons it will not be shown again.",
            )}
          </Alert>

          <div>
            <Text size="sm" c="dimmed" mb={4}>
              {t("Token")}
            </Text>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Code
                block
                data-testid="api-key-token"
                style={{ flex: 1, wordBreak: "break-all" }}
              >
                {created.token}
              </Code>
              <CopyButton value={created.token}>
                {({ copied, copy }) => (
                  <Button
                    variant="light"
                    size="xs"
                    color={copied ? "teal" : "blue"}
                    leftSection={
                      copied ? (
                        <IconCheck size={16} />
                      ) : (
                        <IconCopy size={16} />
                      )
                    }
                    onClick={copy}
                  >
                    {copied ? t("Copied") : t("Copy")}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </div>

          <Text size="sm" c="dimmed">
            {expiresAt
              ? t("Expires {{date}}", {
                  date: formatLocalized(
                    new Date(expiresAt),
                    "MMM dd, yyyy",
                    "PP",
                    locale,
                  ),
                })
              : t("This key never expires")}
          </Text>

          <Group justify="flex-end" mt="xs">
            <Button onClick={onClose}>{t("Done")}</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
