import { useEffect } from "react";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useRegisterSW } from "virtual:pwa-register/react";

// Stable notification id so we can show/hide a single update prompt.
const UPDATE_NOTIFICATION_ID = "pwa-update-available";

/**
 * Listens for a waiting service worker and surfaces a Mantine notification
 * prompting the user to reload into the new version.
 *
 * Must be mounted inside the Mantine provider subtree (Notifications must be
 * available). Renders nothing itself.
 */
export function PwaUpdatePrompt() {
  const { t } = useTranslation();

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Best-effort: a failed registration must not break the app.
      console.error("Service worker registration error:", error);
    },
  });

  useEffect(() => {
    if (!needRefresh) return;

    notifications.show({
      id: UPDATE_NOTIFICATION_ID,
      title: t("Update available"),
      message: (
        <Button
          size="xs"
          variant="light"
          mt="xs"
          onClick={() => updateServiceWorker(true)}
        >
          {t("Reload")}
        </Button>
      ),
      autoClose: false,
      withCloseButton: true,
    });

    // Hide the notification when the prompt is no longer needed / on cleanup.
    return () => {
      notifications.hide(UPDATE_NOTIFICATION_ID);
    };
  }, [needRefresh, t, updateServiceWorker]);

  return null;
}

export default PwaUpdatePrompt;
