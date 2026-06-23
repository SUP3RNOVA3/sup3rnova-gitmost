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
 * natively).
 */
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "./markdown-document";
export type { DocmostMdMeta } from "./markdown-document";

export { convertProseMirrorToMarkdown } from "./markdown-converter";

export { markdownToProseMirror } from "./markdown-to-prosemirror";

export {
  canonicalizeContent,
  docsCanonicallyEqual,
} from "./canonicalize";
