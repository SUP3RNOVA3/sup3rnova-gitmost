import { Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import classes from "@/features/ai-chat/components/ai-chat-window.module.css";

/** Compact token formatter: 1.2M / 3.4k / 950. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface ContextBadgeProps {
  // Current context size for the active chat (tokens occupied in the model's
  // window). 0 = unknown → nothing is rendered.
  contextTokens: number;
  // The model's context-window size (tokens), from AI settings. 0/undefined =
  // no limit known → only the current size is shown (no denominator).
  maxContextTokens?: number;
}

/**
 * Header badge that ALWAYS shows the current context size, and — when the model's
 * context-window size is configured — appends "/ max" so the badge reads
 * "current / max" (e.g. `572 / 200k`). This is a single, stable meaning: unlike
 * the previous design it never flips to a live per-turn generation counter while
 * streaming (that live feedback lives in the chat body's "Thinking · N tokens").
 *
 * No limit configured (or older history rows without it) → the denominator is
 * hidden and the badge shows the current size only, matching the prior at-rest
 * behaviour. `context > max` (estimate drift, or a role on a smaller model) is
 * shown as-is, without clamping.
 */
export function ContextBadge({
  contextTokens,
  maxContextTokens,
}: ContextBadgeProps) {
  const { t } = useTranslation();

  // Nothing to show until the first persisted context figure exists.
  if (!(contextTokens > 0)) return null;

  const hasMax = typeof maxContextTokens === "number" && maxContextTokens > 0;
  const label = hasMax
    ? `${formatTokens(contextTokens)} / ${formatTokens(maxContextTokens)}`
    : formatTokens(contextTokens);

  return (
    <Tooltip
      label={
        hasMax
          ? t("Context size / model limit")
          : t("Current context size")
      }
      withArrow
    >
      <span className={classes.badge}>{label}</span>
    </Tooltip>
  );
}

export default ContextBadge;
