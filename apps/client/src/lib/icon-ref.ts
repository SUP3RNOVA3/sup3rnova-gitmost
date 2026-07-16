/**
 * Single source of truth for the Lucide-icon reference stored in `pages.icon`
 * and `aiAgentRoles.emoji` (#610).
 *
 * Both columns keep their existing name and `varchar` type — the value is now a
 * JSON string of an {@link IconRef} instead of a native emoji character:
 *   - `pages.icon`         : `{"name":"rocket","color":"blue"}` (color = palette token)
 *   - `aiAgentRoles.emoji` : `{"name":"rocket"}` (no color — the avatar bg is a gradient)
 *
 * A legacy native-emoji value is NOT valid JSON, so `parseIconRef` returns
 * `null` for it and every render site falls back to its default glyph. This
 * module never throws.
 */

export interface IconRef {
  /** Lucide icon name in kebab-case (a key of `dynamicIconImports`). */
  name: string;
  /** Optional Mantine palette token (articles only). */
  color?: string;
}

/**
 * The article-icon color palette — Mantine hue tokens whose `-light` /
 * `-light-color` pair reads well in both light and dark themes (same pattern as
 * the AI role cards). Default is `blue`.
 */
export const PAGE_ICON_PALETTE = [
  "gray",
  "red",
  "pink",
  "grape",
  "violet",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "orange",
] as const;

export type PageIconColor = (typeof PAGE_ICON_PALETTE)[number];

export const DEFAULT_PAGE_ICON_COLOR: PageIconColor = "blue";

const PALETTE_SET = new Set<string>(PAGE_ICON_PALETTE);

/** An unknown / missing palette token resolves to the default (`blue`). */
export function resolvePageIconColor(color?: string | null): PageIconColor {
  return color && PALETTE_SET.has(color)
    ? (color as PageIconColor)
    : DEFAULT_PAGE_ICON_COLOR;
}

/** Theme-aware background for a palette token (readable in light + dark). */
export function pageIconBg(color: PageIconColor): string {
  return `var(--mantine-color-${color}-light)`;
}

/** Theme-aware foreground (icon stroke) for a palette token. */
export function pageIconFg(color: PageIconColor): string {
  return `var(--mantine-color-${color}-light-color)`;
}

/**
 * Parse a stored icon value into an {@link IconRef}, DEFENSIVELY. Returns `null`
 * for anything that is not a valid IconRef JSON object with a non-empty `name`:
 * null/undefined, empty string, non-JSON (e.g. a legacy emoji character), a JSON
 * value that is not an object, or an object without a usable `name`.
 *
 * When a `color` is present but is not a known palette token it is normalized to
 * the default (`blue`); a missing `color` stays absent (role refs carry none).
 */
export function parseIconRef(
  raw: string | null | undefined,
): IconRef | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A native emoji or any other non-JSON string lands here → treated as "no
    // icon" so the caller renders its default glyph.
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") return null;

  const ref: IconRef = { name: name.trim() };

  const color = (parsed as Record<string, unknown>).color;
  if (typeof color === "string" && color.trim() !== "") {
    ref.color = resolvePageIconColor(color.trim());
  }

  return ref;
}

/** Serialize an {@link IconRef} to the stored JSON string. */
export function serializeIconRef(ref: IconRef): string {
  const out: IconRef = { name: ref.name };
  if (ref.color) out.color = ref.color;
  return JSON.stringify(out);
}
