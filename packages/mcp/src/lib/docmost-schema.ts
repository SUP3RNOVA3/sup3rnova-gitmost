/**
 * Docmost TipTap schema mirror.
 *
 * #293 STEP 5: the extension set (and its parseHTML/renderHTML behaviour) is now
 * owned by the shared `@docmost/prosemirror-markdown` package — the single
 * canonical schema every converter path targets. MCP re-exports it here instead
 * of maintaining its own drifted ~1200-line copy, so the schema can never drift
 * between mcp and the package/git-sync again.
 *
 * `docmostExtensions` comes from the package; `docmostSchema` is derived from it
 * exactly as before (`getSchema(docmostExtensions)`), built ONCE and reused by
 * every consumer (diff, collaboration write-back) so the schema is identical at
 * every call site.
 *
 * The package does NOT re-export the two small mcp-only sanitizer helpers
 * (`clampCalloutType`, `sanitizeCssColor`) through its public barrel, so they
 * are preserved verbatim here (they are pure and used by mcp code/tests). The
 * package's schema uses its own internally-identical copies for parsing.
 */
import { getSchema } from "@tiptap/core";
import { docmostExtensions } from "@docmost/prosemirror-markdown";

export { docmostExtensions };

/**
 * The ProseMirror schema for the docmost editor, built ONCE from
 * `docmostExtensions`. Pure and reused by every consumer (diff, collaboration
 * write-back) so the schema can never drift between call sites.
 */
export const docmostSchema = getSchema(docmostExtensions);

/** Allowed Docmost callout types; anything else falls back to "info". */
const CALLOUT_TYPES = ["info", "warning", "danger", "success"];
export const clampCalloutType = (value: string | null | undefined): string =>
  value && CALLOUT_TYPES.includes(value.toLowerCase())
    ? value.toLowerCase()
    : "info";

/**
 * Allowlist guard for CSS color values imported from HTML.
 *
 * Docmost interpolates stored mark colors straight into an inline style
 * attribute (e.g. style="background-color: ${color}" / "color: ${color}").
 * An unsanitized value such as `red; --x: url(...)` or `red"><script>` would
 * let a crafted document break out of the style attribute. We therefore only
 * accept a narrow, well-formed subset of CSS <color> syntax and reject (-> null)
 * anything else.
 *
 * Accepted forms:
 *   - named colors:           letters only, e.g. "red", "rebeccapurple"
 *   - hex:                    #rgb, #rgba, #rrggbb, #rrggbbaa
 *   - functional notation:    rgb()/rgba()/hsl()/hsla() containing only
 *                             digits, %, ., commas, spaces and slashes
 */
const SAFE_COLOR_RE =
  /^(?:[a-zA-Z]+|#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\))$/;
export const sanitizeCssColor = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return color && SAFE_COLOR_RE.test(color) ? color : null;
};
