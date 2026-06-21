import { Badge, Tooltip } from "@mantine/core";
import { IconGitMerge } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface GitSyncBadgeProps {
  authorName?: string;
}

/**
 * Badge marking a version written by the git-sync data plane — a VaultGit pull
 * applied through the native datasource (provenance §8.1). Like {@link AiAgentBadge}
 * it is ADDITIVE — shown next to the human author, never replacing them. A
 * git-sync edit is NOT an agent edit and has no chat to deep-link into, so it is
 * a small, neutral, non-clickable label.
 */
export function GitSyncBadge({ authorName }: GitSyncBadgeProps) {
  const { t } = useTranslation();

  const tooltip = t("Synced from Git on behalf of {{name}}", {
    name: authorName ?? "",
  });

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        size="sm"
        variant="light"
        color="gray"
        radius="sm"
        leftSection={<IconGitMerge size={12} stroke={2} />}
      >
        {t("Git sync")}
      </Badge>
    </Tooltip>
  );
}
