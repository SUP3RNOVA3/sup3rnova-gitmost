/**
 * Server-authoritative "agent avatar stack" provenance (#300).
 *
 * Agent-authored content (comments / page-history snapshots) is displayed as a
 * two-avatar stack: the AGENT in front, and the HUMAN who launched it behind.
 * This module normalizes the two provenance shapes the client can encounter into
 * the SAME pair of sub-objects so the client never has to branch:
 *
 *   agent    — FRONT  (the acting agent identity)
 *   launcher — BEHIND (the human on whose behalf it acted; null when there is none)
 *
 * The discriminator is purely SERVER-SIDE data (createdSource / lastUpdatedSource
 * plus aiChatId) that only the server can set — none of it is read from request
 * input, so an external caller cannot spoof an `agent` badge.
 */

/** Front avatar identity. `avatarUrl`/`emoji` feed the glyph source priority. */
export interface AgentInfo {
  name: string;
  emoji?: string | null;
  avatarUrl?: string | null;
}

/** Behind avatar identity — the human who launched the agent (internal chat). */
export interface LauncherInfo {
  name: string;
  avatarUrl?: string | null;
}

/**
 * Inputs to the resolver, drawn entirely from server-side columns:
 * - `isAgent`  — createdSource/lastUpdatedSource === 'agent'.
 * - `aiChatId` — internal-AI-chat discriminator: non-null => internal chat (the
 *   provenance token was minted for the human, so `creator` is the human and the
 *   agent identity comes from the chat's role); null => external MCP (the login
 *   IS a dedicated agent account, so `creator` is the agent, no separate human).
 * - `creator`  — the row's human author (internal) OR agent account (MCP).
 * - `agentRole`— the chat's bound role (name + optional emoji), resolved WITHOUT
 *   any enabled/deleted filter so historical content keeps its signature even
 *   after the role is disabled or soft-deleted; null when the chat has no role.
 */
export interface AgentProvenanceInput {
  isAgent: boolean;
  aiChatId: string | null | undefined;
  creator: { name: string; avatarUrl?: string | null } | null | undefined;
  agentRole: { name: string; emoji?: string | null } | null | undefined;
}

export interface AgentProvenance {
  agent: AgentInfo;
  launcher: LauncherInfo | null;
}

/** Fallback display name for an internal agent edit whose chat has no role. */
export const AGENT_FALLBACK_NAME = 'AI agent';

/**
 * Resolve the front/behind identities from server-side provenance. Returns
 * `null` for non-agent content so the caller can OMIT both fields (the client
 * then keeps its plain single-human avatar).
 */
export function resolveAgentProvenance(
  input: AgentProvenanceInput,
): AgentProvenance | null {
  if (!input.isAgent) return null;

  // External MCP: no internal chat row; the login itself is the agent account.
  if (input.aiChatId == null) {
    return {
      agent: {
        name: input.creator?.name ?? AGENT_FALLBACK_NAME,
        avatarUrl: input.creator?.avatarUrl ?? null,
      },
      launcher: null,
    };
  }

  // Internal AI chat: the agent identity is the chat's role (or the fallback
  // when the chat has no role), and the launcher is the human chat owner.
  const agent: AgentInfo = input.agentRole
    ? {
        name: input.agentRole.name,
        emoji: input.agentRole.emoji ?? null,
        avatarUrl: null,
      }
    : { name: AGENT_FALLBACK_NAME, avatarUrl: null };

  const launcher: LauncherInfo | null = input.creator
    ? { name: input.creator.name, avatarUrl: input.creator.avatarUrl ?? null }
    : null;

  return { agent, launcher };
}
