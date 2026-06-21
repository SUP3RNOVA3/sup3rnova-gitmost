/**
 * Public surface of the vendored pure converter (the `lib/` half of the
 * docmost-sync `docmost-client` package). This barrel re-exports only the
 * PURE, IO-free pieces the sync engine needs: the self-contained markdown
 * (de)serializers, the lossless ProseMirror <-> Markdown converter, the
 * markdown -> ProseMirror import path, and semantic canonicalization for the
 * round-trip idempotency check (SPEC §11).
 *
 * The REST client, websocket/collab write-path, auth-utils and page-lock from
 * the upstream package are deliberately NOT vendored (the gitmost server writes
 * natively — plan §2.2/§2.3).
 */
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "./markdown-document.js";
export type { DocmostMdMeta } from "./markdown-document.js";

export { convertProseMirrorToMarkdown } from "./markdown-converter.js";

export { markdownToProseMirror } from "./markdown-to-prosemirror.js";

export {
  canonicalizeContent,
  docsCanonicallyEqual,
} from "./canonicalize.js";
