import { Code as TiptapCode } from "@tiptap/extension-code";

// Canonical inline `code` mark for Docmost (issue #515). Tiptap's upstream Code
// mark ships `excludes: "_"`, which makes ProseMirror strip every co-occurring
// inline mark on the HTML -> PM parse (`generateJSON`) and on editor
// transactions. That is why bold/italic/etc. around inline code were lost or
// "slid" onto separators on Markdown import (CommonMark keeps `**` around a
// `` `code` `` span as `<strong><code>…</code></strong>`). Override `excludes`
// to `""` so `code` combines with ALL other inline marks, matching CommonMark.
//
// This is the single source of the excludes policy for the three app schemas
// (client `mainExtensions`, server `tiptapExtensions`, comment editor). The
// vendored markdown-converter mirror (`docmost-schema.ts`) deliberately does NOT
// import this at runtime (it must stay framework-free), so it sets the same
// `excludes: ""` locally; a parity test guards the two against drift.
export const Code = TiptapCode.extend({ excludes: "" });
