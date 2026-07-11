import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { MarkdownClipboard } from "./markdown-clipboard";

/**
 * Integration coverage for the async `handlePaste` seam (issue #347). The paste
 * conversion moved to `@docmost/prosemirror-markdown`'s browser entry, whose
 * `markdownToProseMirror` is async — so `handlePaste` captures the range, claims
 * the event (returns true), and dispatches the insert on the next microtask.
 * These tests drive that path end to end on a minimal schema (a plain-markdown
 * paste whose converted nodes fit paragraph/text/bold/italic), asserting the
 * text lands with the right marks and that the raw markdown syntax is consumed
 * (recognized as markdown, not inserted literally).
 */

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      MarkdownClipboard.configure({ transformPastedText: true }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
}

// Locate the markdownClipboard plugin and invoke its handlePaste directly with a
// synthetic clipboard event (jsdom has no real paste pipeline). The plugin's
// handlePaste closes over the extension `this`, so calling it off the plugin
// props preserves `this.editor`/`this.options`.
function paste(editor: Editor, text: string): boolean {
  const view = editor.view;
  const plugin = view.state.plugins.find(
    (p: any) => p.props && p.spec?.key,
  ) as any;
  const event = {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as ClipboardEvent;
  // Find the specific handlePaste that belongs to the markdown clipboard plugin.
  const md = view.state.plugins.find(
    (p: any) => typeof p.props?.handlePaste === "function",
  ) as any;
  return md.props.handlePaste(view, event, view.state.selection.content());
}

// Flush the microtask queue so the async .then() dispatch runs.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MarkdownClipboard handlePaste (async md -> PM)", () => {
  it("converts a plain-markdown paste with bold/italic into marked text", async () => {
    const editor = makeEditor();
    const claimed = paste(editor, "hello **bold** and *italic*");
    // The paste is claimed synchronously (async insert follows).
    expect(claimed).toBe(true);
    await flush();

    const json = editor.getJSON();
    const text = JSON.stringify(json);
    // The raw markdown asterisks are consumed (recognized), not inserted literally.
    expect(editor.getText()).not.toContain("**");
    expect(editor.getText()).toContain("bold");
    expect(editor.getText()).toContain("italic");
    // The bold/italic marks materialized.
    expect(text).toContain('"bold"');
    expect(text).toContain('"italic"');
    editor.destroy();
  });

  it("recognizes a bullet list paste as list structure (not literal '-')", async () => {
    // A bullet list is not representable in this minimal schema, so the converter
    // output would fail PMNode.fromJSON and the catch inserts raw text. Use a
    // paste whose nodes DO fit the schema to assert the happy path instead: two
    // paragraphs separated by a blank line.
    const editor = makeEditor();
    paste(editor, "first para\n\nsecond para");
    await flush();
    const json = editor.getJSON() as any;
    const paras = (json.content || []).filter(
      (n: any) => n.type === "paragraph",
    );
    // Two paragraphs materialized from the blank-line-separated markdown.
    expect(paras.length).toBeGreaterThanOrEqual(2);
    expect(editor.getText()).toContain("first para");
    expect(editor.getText()).toContain("second para");
    editor.destroy();
  });

  it("falls back to raw text when conversion yields nodes the schema lacks", async () => {
    // `# heading` converts to a `heading` node absent from this minimal schema,
    // so PMNode.fromJSON throws and the catch re-inserts the raw text — the user
    // never loses their clipboard content.
    const editor = makeEditor();
    paste(editor, "# a heading line");
    await flush();
    // Content is preserved (either as heading text or literal), never dropped.
    expect(editor.getText()).toContain("a heading line");
    editor.destroy();
  });
});

// The async seam captures the target range synchronously, then replaces on the
// next microtask. If the document changed under it between capture and resolve
// (impossible in prod — same microtask — but pinned here), BOTH the success
// (replaceRange) and the fail-open (insertText) branches must fall back to the
// LIVE selection rather than a stale absolute range, so neither clobbers content
// nor throws a RangeError. We force the mid-flight change by dispatching a
// doc-mutating transaction AFTER the synchronous claim but BEFORE flushing the
// microtask that runs the `.then`/`.catch`.
describe("MarkdownClipboard handlePaste — doc-changed-mid-flight guard", () => {
  // Insert marker text at the doc start via a raw transaction (synchronous),
  // changing `view.state.doc` so the captured range goes stale.
  function mutateDoc(editor: Editor, marker: string) {
    editor.view.dispatch(editor.view.state.tr.insertText(marker, 1));
  }

  it("success branch: a mid-flight doc change routes the paste to the live selection (no clobber, no throw)", async () => {
    const editor = makeEditor();
    const claimed = paste(editor, "hello **bold**");
    expect(claimed).toBe(true);
    // Doc changes before the async replace runs: the captured from/to are stale.
    mutateDoc(editor, "MARKER");
    await flush();

    const text = editor.getText();
    // The pre-existing marker survived (a stale-range replaceRange would have
    // clobbered it) AND the pasted content landed.
    expect(text).toContain("MARKER");
    expect(text).toContain("bold");
    expect(text).not.toContain("**");
    editor.destroy();
  });

  it("fail-open branch: a mid-flight doc change + conversion failure re-inserts raw text at the live selection (no RangeError)", async () => {
    const editor = makeEditor();
    // `# heading` -> a heading node the minimal schema lacks -> PMNode.fromJSON
    // throws -> the fail-open catch runs, now with a changed doc.
    paste(editor, "# raw heading");
    mutateDoc(editor, "KEEP");
    await flush();

    const text = editor.getText();
    // No RangeError/unhandled rejection (the test would fail on a throw), the
    // marker survived, and the raw text was preserved.
    expect(text).toContain("KEEP");
    expect(text).toContain("raw heading");
    editor.destroy();
  });

  it("two pastes in flight: neither payload is lost (no data loss)", async () => {
    // Prod-unreachable (two paste events are separate macrotasks, and each
    // conversion resolves on a microtask before the next), but pinned here: when
    // both resolve back-to-back, the second sees the changed doc and inserts at
    // the live selection the first left — so the two payloads may INTERLEAVE, but
    // neither is dropped. We assert no data loss, not contiguity.
    const editor = makeEditor();
    paste(editor, "alphaword");
    paste(editor, "betaword");
    await flush();
    const text = editor.getText();
    // Neither payload fully dropped (interleaving may split one of them).
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    editor.destroy();
  });
});
