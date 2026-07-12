import { Code as TiptapCode } from "@tiptap/extension-code";

// #515: canonical inline `code` mark for Docmost.
//
// Tiptap's stock Code mark (via StarterKit) declares `excludes: "_"`, which
// makes it exclude EVERY other inline mark: applying `code` drops any co-
// occurring bold/italic/… on both the HTML->PM import and editor transactions.
// That silently stripped emphasis adjacent to inline code (`` **`--flag`** ``
// lost its bold on markdown import). CommonMark nests them (`<strong><code>`),
// so Docmost lets `code` combine with all marks by overriding `excludes` to the
// empty string (excludes nothing).
//
// This is the SINGLE shared source imported by the live editor, the collab
// server and the comment editor schemas. The markdown-import mirror in
// @docmost/prosemirror-markdown re-declares the same override locally (it must
// not pull this React-aware package into its node runtime) and a parity test
// keeps the two in lockstep.
export const Code = TiptapCode.extend({
  excludes: "",
});
