import { Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";

/**
 * Shown when the authenticated app shell cannot hydrate because the current
 * user is unavailable AND there is no cached user to fall back on (e.g. an
 * offline cold boot of a page that was never warmed for offline).
 *
 * Previously UserProvider returned a bare `<></>` in this situation, which
 * white-screened the whole app on any offline reload (#237/#238). Rendering an
 * explicit "you're offline" state with a retry instead gives the user a clear,
 * non-blank fallback and a way to recover once the network returns.
 */
export function OfflineFallback() {
  const { t } = useTranslation();

  return (
    <>
      <Helmet>
        <title>
          {t("You're offline")} - {getAppName()}
        </title>
      </Helmet>
      <Container size="sm" py={80}>
        <Stack align="center" gap="md">
          <Title order={2} ta="center">
            {t("You're offline")}
          </Title>
          <Text c="dimmed" size="lg" ta="center">
            {t(
              "This page hasn't been saved for offline use, so it can't be loaded right now. Reconnect to the internet and try again.",
            )}
          </Text>
          <Group justify="center">
            <Button onClick={() => window.location.reload()} variant="subtle">
              {t("Retry")}
            </Button>
          </Group>
        </Stack>
      </Container>
    </>
  );
}
