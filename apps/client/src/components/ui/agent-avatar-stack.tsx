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

// Normalize the name before hashing so "PM ", "pm", "Pm" all map to the same
// avatar (unicode-normalized, trimmed, lower-cased, whitespace collapsed).
function normalizeName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

// cyrb53: deterministic 53-bit string hash with good avalanche, pure JS. A
// language's BUILT-IN hash (Java hashCode, etc.) must NOT be used — those differ
// across platforms/engines, which would make one name render as different avatars
// on server vs client. This is stable everywhere.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Perceptually-even avatar palette built in OKLCH and clamped to the sRGB gamut:
// 12 LIGHT colors (L≈0.70, black text) then 8 DARK colors (L≈0.50, white text).
// The minimum pairwise ΔEOK ≈ 0.066 (~5 JNDs), so any two entries are either the
// SAME color or clearly distinguishable — "almost identical" colors are
// impossible by construction (that was the old raw-hue failure mode). Text
// contrast is WCAG-checked: dark ring ≥ 5.6:1 white, light ring ≥ 7.3:1 black.
export const AVATAR_PALETTE = [
  // light ring (black text)
  "#e87782", "#e57f4f", "#d0901e", "#aca220", "#77b154", "#22b988",
  "#00b5b5", "#00afdc", "#5fa1f3", "#9690f1", "#bf82da", "#db78b2",
  // dark ring (white text)
  "#a03e43", "#8e5300", "#686800", "#007742",
  "#007176", "#0068a5", "#6453a7", "#8f4280",
];

// Second gradient stop per palette entry (index-aligned): two hue-shifted (±25°)
// partners. A separate hash channel picks which one, so two agents that collide
// on the base color almost always still differ by their gradient.
export const GRADIENT_PARTNERS = [
  ["#de77ab", "#e67d58"], ["#e8777a", "#d58d25"], ["#e28247", "#b39f18"],
  ["#cb9317", "#81af4b"], ["#a4a528", "#37b880"], ["#6cb35d", "#00b6af"],
  ["#3cb693", "#26afd1"], ["#00b4bb", "#58a3ed"], ["#00ade4", "#8e93f3"],
  ["#699ef5", "#b984df"], ["#9e8eef", "#d779ba"], ["#c480d4", "#e7768a"],
  ["#9a3e67", "#9d4616"], ["#974a2e", "#7a6000"], ["#7e5e00", "#47712c"],
  ["#4b7015", "#007465"], ["#1c7360", "#1c6d88"], ["#006f87", "#485daa"],
  ["#3e5fad", "#7f4995"], ["#7a4b9a", "#9c3e60"],
];

export interface AvatarStyle {
  bg: string; // base color / first gradient stop
  bg2: string; // second gradient stop
  angleDeg: number; // gradient direction
  text: "white" | "black"; // readable foreground for the ring
}

/**
 * Deterministic, cross-platform avatar style for an agent glyph. Disjoint bit
 * ranges of ONE cyrb53 hash drive INDEPENDENT visual channels — palette color
 * (20) × gradient partner (2) × gradient angle (8) = 320 combinations — so even
 * when the base color repeats (unavoidable: humans reliably tell apart only
 * ~20-25 colors), the gradient — and the emoji drawn on top — still tell two
 * agents apart. Pure function of the normalized name: same name → same avatar on
 * every device, nothing persisted.
 */
export function avatarStyle(agentName: string): AvatarStyle {
  const h = cyrb53(normalizeName(agentName));
  const idx = h % AVATAR_PALETTE.length; // which palette color
  const rest = Math.floor(h / AVATAR_PALETTE.length);
  const dir = rest % 2; // gradient partner: hue -25 or +25
  const angleDeg = (Math.floor(rest / 2) % 8) * 45; // one of 8 gradient angles
  return {
    bg: AVATAR_PALETTE[idx],
    bg2: GRADIENT_PARTNERS[idx][dir],
    angleDeg,
    text: idx < 12 ? "black" : "white",
  };
}

/**
 * The front avatar. Image-source priority (#300):
 *   1. agent.avatarUrl -> a real avatar image (external MCP agent account).
 *   2. agent.emoji     -> the role emoji on a per-agent gradient circle.
 *   3. otherwise       -> the IconSparkles glyph on a per-agent gradient circle.
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

  // Emoji/sparkles glyph on a per-agent gradient circle (color + gradient hashed
  // from the agent name via avatarStyle). Rendered as a plain Box, NOT a Mantine
  // `Avatar variant="filled"` — Mantine's `--avatar-bg` overrode the background
  // (every agent fell back to the theme's violet). The foreground (the sparkles
  // icon) uses the ring's WCAG-checked readable text color.
  const style = avatarStyle(agent.name);
  return (
    <Box
      data-testid="agent-glyph"
      style={{
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
        borderRadius: "50%",
        // Solid base color is the fallback (and the testable value); the gradient
        // paints over it in browsers that support it.
        backgroundColor: style.bg,
        backgroundImage: `linear-gradient(${style.angleDeg}deg, ${style.bg}, ${style.bg2})`,
        color:
          style.text === "white"
            ? "var(--mantine-color-white)"
            : "var(--mantine-color-black)",
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
