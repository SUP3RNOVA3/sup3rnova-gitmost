import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { gitmostInsertTranscriptIntoEditor } from "./gitmost-recording.ts";

/**
 * #377 — the web-side bridge must append the native host's transcript below the
 * recording. These exercise the pure insert helper through a REAL Tiptap editor
 * (Document/Paragraph/Text/Heading), asserting the resulting document rather
 * than mocking the editor: transcript present -> "Transcript" heading + one
 * paragraph per non-empty line (verbatim); absent/empty/non-string -> no-op.
 */
describe("gitmostInsertTranscriptIntoEditor", () => {
  const makeEditor = () =>
    new Editor({
      extensions: [Document, Paragraph, Text, Heading],
      // Start from a single empty paragraph (a fresh page's baseline). The
      // helper appends at the end of the doc, i.e. below existing content.
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });

  it("inserts a Transcript heading + one paragraph per non-empty line, verbatim", () => {
    const editor = makeEditor();

    const inserted = gitmostInsertTranscriptIntoEditor(
      editor,
      "You: hello there\nSpeaker 1: hi\n\nYou: bye",
    );

    expect(inserted).toBe(true);

    const nodes = (editor.getJSON().content ?? []) as any[];
    // A level-2 "Transcript" heading is present.
    const heading = nodes.find((n) => n.type === "heading");
    expect(heading?.attrs?.level).toBe(2);
    expect(heading?.content?.[0]?.text).toBe("Transcript");

    // Every non-empty transcript line becomes a paragraph, in order, verbatim;
    // the blank line between them is dropped.
    const texts = nodes
      .filter((n) => n.type === "paragraph")
      .map((n) => n.content?.[0]?.text)
      .filter((t) => typeof t === "string");
    expect(texts).toEqual(["You: hello there", "Speaker 1: hi", "You: bye"]);

    editor.destroy();
  });

  it("is a no-op for undefined / empty / whitespace-only / non-string transcripts", () => {
    for (const value of [undefined, "", "   \n  \n", 42, {}, null]) {
      const editor = makeEditor();
      const before = JSON.stringify(editor.getJSON());

      const inserted = gitmostInsertTranscriptIntoEditor(editor, value as any);

      expect(inserted).toBe(false);
      // Document is untouched (audio-only behavior preserved).
      expect(JSON.stringify(editor.getJSON())).toBe(before);
      editor.destroy();
    }
  });
});
