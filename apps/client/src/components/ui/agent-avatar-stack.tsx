import { Avatar, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSetAtom } from "jotai";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// The FRONT identity (the acting agent) and the BEHIND identity (the human who
// launched it). Both are computed server-side (#300) so the client never branches
// on the internal-vs-MCP provenance — it just renders whatever it is handed.
export interface AgentInfo {
  name: string;
  emoji?: string | null;
  avatarUrl?: string | null;
}
export interface LauncherInfo {
  name: string;
  avatarUrl?: string | null;
}

// Same violet token as the former AiAgentBadge (which used color="violet").
const AGENT_COLOR = "violet";
const GLYPH_SIZE = 38;
const LAUNCHER_SIZE = 22;

/**
 * The front avatar. Image-source priority (#300):
 *   1. agent.avatarUrl -> a real avatar image (external MCP agent account).
 *   2. agent.emoji     -> the role emoji on a violet circle.
 *   3. otherwise       -> the IconSparkles glyph on a violet circle (fallback).
 */
function AgentGlyph({ agent }: { agent: AgentInfo }) {
  if (agent.avatarUrl) {
    return (
      <CustomAvatar
        size={GLYPH_SIZE}
        avatarUrl={agent.avatarUrl}
        name={agent.name}
      />
    );
  }

  if (agent.emoji) {
    return (
      <Avatar size={GLYPH_SIZE} radius="xl" color={AGENT_COLOR} variant="filled">
        <span style={{ fontSize: Math.round(GLYPH_SIZE * 0.5) }} aria-hidden>
          {agent.emoji}
        </span>
      </Avatar>
    );
  }

  return (
    <Avatar size={GLYPH_SIZE} radius="xl" color={AGENT_COLOR} variant="filled">
      <IconSparkles size={Math.round(GLYPH_SIZE * 0.55)} stroke={2} />
    </Avatar>
  );
}

export interface AgentAvatarStackProps {
  agent: AgentInfo;
  // null/absent => external MCP (front agent avatar only, no human behind).
  launcher?: LauncherInfo | null;
  // Deep-links into the internal AI chat when present (null for external MCP).
  aiChatId?: string | null;
  // Fired after the stack deep-links into its chat, so the caller can react
  // (e.g. the page-history row closes the history modal). Keeps this ui/ primitive
  // free of cross-feature coupling (inherited from the old AiAgentBadge, #143).
  onActivate?: () => void;
}

/**
 * The "agent avatar stack" (#300): the AGENT glyph in front, and — for an
 * internal AI chat — the HUMAN who launched it as a smaller avatar offset behind.
 * Replaces the old text `AI-agent` badge. When the item carries an `aiChatId` the
 * whole stack is a deep-link into that chat (the click the old badge owned moved
 * here); the click is contained (stopPropagation) so it does not also trigger an
 * enclosing row handler.
 */
export function AgentAvatarStack({
  agent,
  launcher,
  aiChatId,
  onActivate,
}: AgentAvatarStackProps) {
  const { t } = useTranslation();
  const setAiChatWindowOpen = useSetAtom(aiChatWindowOpenAtom);
  const setActiveChatId = useSetAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);

  const clickable = !!aiChatId;

  const openChat = useCallback(
    (event: React.SyntheticEvent) => {
      event.stopPropagation();
      if (!aiChatId) return;
      setActiveChatId(aiChatId);
      // Switching chats must start with a clean composer — clear any unsent draft
      // so it does not leak from the previously open chat.
      setDraft("");
      setAiChatWindowOpen(true);
      onActivate?.();
    },
    [aiChatId, setActiveChatId, setDraft, setAiChatWindowOpen, onActivate],
  );

  // Internal chat => "role on behalf of person"; external MCP => just the agent.
  const tooltip = launcher
    ? t("AI agent «{{role}}» on behalf of {{person}}", {
        role: agent.name,
        person: launcher.name,
      })
    : t("AI agent {{name}}", { name: agent.name });

  const stack = (
    <Box
      pos="relative"
      style={{
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
        flexShrink: 0,
        cursor: clickable ? "pointer" : undefined,
      }}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            onClick: openChat,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openChat(event);
              }
            },
          }
        : {})}
    >
      {launcher && (
        <Box pos="absolute" bottom={0} right={0} style={{ zIndex: 0 }}>
          <CustomAvatar
            size={LAUNCHER_SIZE}
            avatarUrl={launcher.avatarUrl}
            name={launcher.name}
            style={{ border: "2px solid var(--mantine-color-body)" }}
          />
        </Box>
      )}
      <Box pos="relative" style={{ zIndex: 1 }}>
        <AgentGlyph agent={agent} />
      </Box>
    </Box>
  );

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <Tooltip label={tooltip} withArrow>
        {stack}
      </Tooltip>
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
        <Text size="xs" fw={600} lineClamp={1} lh={1.2}>
          {agent.name}
        </Text>
        {launcher && (
          <>
            <Text size="xs" c="dimmed" fw={400} aria-hidden>
              ·
            </Text>
            <Text size="xs" c="dimmed" fw={400} lineClamp={1} lh={1.2}>
              {launcher.name}
            </Text>
          </>
        )}
      </Group>
    </Group>
  );
}

export default AgentAvatarStack;
