import { Box, Group, Text, Tooltip } from "@mantine/core";
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

const GLYPH_SIZE = 38;
const LAUNCHER_SIZE = 22;
// How far the launcher avatar sticks out past the agent's top-right corner — it
// sits as a small badge over that corner (above the glyph) and stays fully visible.
const LAUNCHER_OVERHANG = 8;

// Small deterministic string hash (same algorithm as custom-avatar's initials
// hash) used to pick a stable per-agent glyph color.
function hashName(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// A palette of categorically-DISTINCT dark circle colors for emoji/sparkles agent
// glyphs. Every entry is intentionally dark (low lightness) so a bright emoji or
// the white sparkles icon stays readable on top; the hues are spread across the
// wheel (red → orange → amber → green → teal → cyan → blue → indigo → violet →
// magenta + a neutral slate) so two different agents read as DIFFERENT colors,
// not merely different shades of the same violet.
const GLYPH_COLORS = [
  "hsl(355, 60%, 34%)", // red
  "hsl(18, 62%, 32%)", // vermilion
  "hsl(32, 60%, 30%)", // orange
  "hsl(45, 55%, 28%)", // amber
  "hsl(75, 45%, 26%)", // olive-green
  "hsl(140, 48%, 26%)", // green
  "hsl(165, 52%, 26%)", // teal
  "hsl(188, 58%, 28%)", // cyan
  "hsl(205, 58%, 32%)", // sky blue
  "hsl(225, 52%, 36%)", // blue
  "hsl(250, 48%, 38%)", // indigo
  "hsl(280, 46%, 36%)", // violet
  "hsl(312, 48%, 34%)", // magenta
  "hsl(210, 12%, 36%)", // slate / neutral
];

/**
 * Deterministic dark circle color for an emoji/sparkles agent glyph, picked from
 * GLYPH_COLORS by a hash of the agent name so distinct agents get categorically
 * distinct colors while every color stays dark enough to keep the glyph readable.
 */
export function agentGlyphBackground(name: string): string {
  return GLYPH_COLORS[hashName(name) % GLYPH_COLORS.length];
}

/**
 * The front avatar. Image-source priority (#300):
 *   1. agent.avatarUrl -> a real avatar image (external MCP agent account).
 *   2. agent.emoji     -> the role emoji on a per-agent dark circle.
 *   3. otherwise       -> the IconSparkles glyph on a per-agent dark circle (fallback).
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

  // Emoji/sparkles glyph on a per-agent dark circle (color hashed from the agent
  // name). Rendered as a plain Box, NOT a Mantine `Avatar variant="filled"`, so
  // the background is guaranteed instead of being overridden by Mantine's
  // `--avatar-bg` (which was falling back to the theme's violet for every agent).
  return (
    <Box
      data-testid="agent-glyph"
      style={{
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
        borderRadius: "50%",
        background: agentGlyphBackground(agent.name),
        color: "var(--mantine-color-white)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      {agent.emoji ? (
        <span style={{ fontSize: Math.round(GLYPH_SIZE * 0.5) }} aria-hidden>
          {agent.emoji}
        </span>
      ) : (
        <IconSparkles size={Math.round(GLYPH_SIZE * 0.55)} stroke={2} />
      )}
    </Box>
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
  // Whether to render the inline name label next to the avatars (default true).
  // Set false when the caller renders the name itself (e.g. the comment row).
  showName?: boolean;
}

/**
 * The "agent avatar stack" (#300): the AGENT glyph, and — for an internal AI
 * chat — the HUMAN who launched it as a smaller avatar badge on top, overhanging
 * the glyph's top-right corner in FRONT (zIndex 2 > the glyph's zIndex 1) so the
 * launcher stays fully visible rather than being half-hidden behind the glyph.
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
  showName = true,
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

  // The container is only enlarged when there is a launcher to overhang; with no
  // human behind it stays tight at the agent glyph size.
  const stackSize = launcher ? GLYPH_SIZE + LAUNCHER_OVERHANG : GLYPH_SIZE;

  const stack = (
    <Box
      pos="relative"
      style={{
        width: stackSize,
        height: stackSize,
        flexShrink: 0,
        // Center the (in-flow) agent glyph vertically so it lines up with its
        // name label; the absolutely-positioned launcher is unaffected by flex.
        display: "flex",
        alignItems: "center",
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
        // Launcher badge sits ABOVE the agent glyph (zIndex) at the top-right so
        // it is fully visible, not half-hidden behind the agent circle.
        <Box pos="absolute" top={0} right={0} style={{ zIndex: 2 }}>
          <CustomAvatar
            size={LAUNCHER_SIZE}
            avatarUrl={launcher.avatarUrl}
            name={launcher.name}
            style={{ border: "2px solid var(--mantine-color-body)" }}
          />
        </Box>
      )}
      {/* The agent glyph keeps its own size (flex-centered in the container); the
          launcher overhangs it by LAUNCHER_OVERHANG at the top-right and stays visible. */}
      <Box
        style={{
          position: "relative",
          zIndex: 1,
          width: GLYPH_SIZE,
          height: GLYPH_SIZE,
        }}
      >
        <AgentGlyph agent={agent} />
      </Box>
    </Box>
  );

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <Tooltip label={tooltip} withArrow>
        {stack}
      </Tooltip>
      {showName && (
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
      )}
    </Group>
  );
}

export default AgentAvatarStack;
