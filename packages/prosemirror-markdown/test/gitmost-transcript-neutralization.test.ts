import { describe, expect, it } from "vitest";
// Import DIRECTLY from src (NOT the docmost-client barrel, which pulls in
// collaboration.ts and mutates global DOM at import time).
import { convertProseMirrorToMarkdown } from "../src/lib/markdown-converter.js";
import { markdownToProseMirror } from "../src/lib/markdown-to-prosemirror.js";

/**
 * gitmost #377 (round-1 review, finding #1) — proof, against the REAL
 * converter, that the transcript-insert boundary defense survives git-sync.
 *
 * The web bridge (apps/client .../gitmost/gitmost-recording.ts,
 * `gitmostInsertTranscriptIntoEditor`) appends each transcript line as a
 * PARAGRAPH text node. The paragraph serializer here (`case "paragraph"`) emits
 * that text VERBATIM with no block-escape, so a line whose text begins with a
 * col-0 markdown block trigger would, on the doc -> markdown -> doc git-sync
 * cycle, silently re-parse into a heading / list / quote / callout / code block.
 * That missing block-escape is the pre-existing root cause; the bridge's
 * boundary defense prepends an invisible zero-width space (U+200B) to a line
 * that begins with such a trigger, shifting it off column 0.
 *
 * This test keeps a COPY of the bridge's trigger regex (the bridge is in a
 * different package and can't be imported here) and asserts:
 *   1. bare trigger lines DO corrupt (documents the root cause), and
 *   2. the ZWSP-neutralized form round-trips as a single PARAGRAPH with the
 *      text byte-preserved.
 */

const ZWSP = "​"; // U+200B

// MUST stay in sync with GITMOST_MD_BLOCK_TRIGGER_RE in the client bridge.
const MD_BLOCK_TRIGGER_RE =
  /^(?:#{1,6}(?:\s|$)|[-*+](?:\s|$)|>|\d+[.)](?:\s|$)|```|~~~|\||([-*_])(?:\s*\1){2,}\s*$)/;

const doc = (...nodes: any[]) => ({ type: "doc", content: nodes });
const para = (t: string) => ({
  type: "paragraph",
  content: [{ type: "text", text: t }],
});

const roundtrip = async (text: string) => {
  const md = convertProseMirrorToMarkdown(doc(para(text)));
  const back = await markdownToProseMirror(md);
  return back.content as any[];
};

describe("gitmost transcript neutralization (git-sync round-trip)", () => {
  // Lines that, at column 0, the serializer's missing block-escape would let
  // git-sync re-parse into a non-paragraph block.
  const triggerLines = [
    "- dash",
    "* star",
    "+ plus",
    "> quote",
    "# hash",
    "1. one",
    "1) one",
    "> [!info] note",
    "```js",
    "~~~",
    // Solid + spaced thematic breaks — these re-parse into a `horizontalRule`,
    // which carries NO text, so a bare separator line LOSES its text entirely
    // (round-2 finding). `_` also only forms a block via this construct.
    "---",
    "***",
    "___",
    "- - -", // spaced dash break (solid form is caught by [-*+]\s too, but this is the break)
    "_ _ _",
  ];

  it("BARE trigger lines corrupt into non-paragraph blocks (root cause)", async () => {
    for (const line of triggerLines) {
      const blocks = await roundtrip(line);
      // At least one produced block is NOT a paragraph — i.e. corruption.
      const allParagraphs = blocks.every((b) => b.type === "paragraph");
      expect(
        allParagraphs,
        `expected "${line}" to corrupt when inserted bare`,
      ).toBe(false);
    }
  });

  it("BARE solid thematic breaks corrupt into a text-LOSING horizontalRule", async () => {
    // The severe case: no text node survives. Documents why neutralization
    // matters more here than for list/quote (where the text survived).
    for (const line of ["---", "***", "___"]) {
      const blocks = await roundtrip(line);
      expect(blocks.map((b) => b.type)).toContain("horizontalRule");
      // No block carries the original text anywhere.
      const flat = JSON.stringify(blocks);
      expect(flat).not.toContain(line);
    }
  });

  it("ZWSP-neutralized trigger lines round-trip as a single paragraph, text preserved", async () => {
    for (const line of triggerLines) {
      // The regex must actually classify each as a trigger.
      expect(MD_BLOCK_TRIGGER_RE.test(line), `regex missed "${line}"`).toBe(
        true,
      );
      const neutralized = ZWSP + line;
      const blocks = await roundtrip(neutralized);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("paragraph");
      // Text is byte-preserved (ZWSP + original line), so the display is the
      // original line with only an invisible leading character.
      expect(blocks[0].content[0].text).toBe(neutralized);
    }
  });

  it("normal host-prefixed lines never match the trigger regex and round-trip byte-exact", async () => {
    for (const line of [
      "You: hello there",
      "Speaker 1: - and then a dash mid-line",
      "Speaker 2: 1. not a list",
    ]) {
      expect(MD_BLOCK_TRIGGER_RE.test(line)).toBe(false);
      const blocks = await roundtrip(line);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("paragraph");
      expect(blocks[0].content[0].text).toBe(line);
    }
  });
});
