import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import {
  splitPlainChunks,
  StreamingPlainText,
} from "./streaming-plain-text";

describe("splitPlainChunks", () => {
  // THE load-bearing property (see the invariant comment in the module): under
  // append-only growth, every chunk except the LAST must be byte-identical
  // between successive calls, so the memoized chunk components never re-render
  // for the stable prefix and each stream delta touches only the tail chunk.
  it("keeps all non-last chunks byte-identical across append-only growth", () => {
    // A simulated reasoning stream covering: appends inside the last paragraph,
    // appends that ADD new blank lines, growth of a trailing newline run, and a
    // trailing separator later followed by text.
    const steps = [
      "Пер",
      "Первый абзац",
      "Первый абзац\n",
      "Первый абзац\n\n",
      "Первый абзац\n\n\n",
      "Первый абзац\n\n\nВторой",
      "Первый абзац\n\n\nВторой абзац растёт",
      "Первый абзац\n\n\nВторой абзац растёт\n\nТретий",
      "Первый абзац\n\n\nВторой абзац растёт\n\nТретий абзац\n\n",
      "Первый абзац\n\n\nВторой абзац растёт\n\nТретий абзац\n\nЧетвёртый",
    ];
    let prev: string[] = [];
    for (const text of steps) {
      const next = splitPlainChunks(text);
      // Lossless: chunks always reassemble into the exact input.
      expect(next.join("")).toBe(text);
      // Chunk count never shrinks (boundaries never disappear).
      expect(next.length).toBeGreaterThanOrEqual(prev.length);
      // Every previously-FINAL chunk (all but prev's last) is unchanged.
      for (let i = 0; i < prev.length - 1; i++) {
        expect(next[i]).toBe(prev[i]);
      }
      prev = next;
    }
    // Guard against a vacuous pass: the final split must be multi-chunk.
    expect(prev.length).toBeGreaterThanOrEqual(4);
  });

  it("attaches the blank-line separator run to the preceding chunk", () => {
    expect(splitPlainChunks("a\n\nb")).toEqual(["a\n\n", "b"]);
    // A longer run is ONE separator, not several boundaries.
    expect(splitPlainChunks("a\n\n\n\nb")).toEqual(["a\n\n\n\n", "b"]);
    expect(splitPlainChunks("a\n\nb\n\n\nc")).toEqual(["a\n\n", "b\n\n\n", "c"]);
  });

  it("single newlines are not boundaries", () => {
    expect(splitPlainChunks("a\nb\nc")).toEqual(["a\nb\nc"]);
  });

  // INTENTIONAL: CRLF blank lines are NOT boundaries (the regex is `\n{2,}`
  // only). Supporting `(?:\r?\n){2,}` would break the stable-prefix invariant:
  // a lone trailing `\r` is not a boundary, but a later-appended `\n` would
  // merge with it into a new separator unit and retroactively create a boundary
  // INSIDE previously-emitted text, moving old chunk edges. So CRLF input stays
  // in one (still lossless) chunk — only granularity is coarser; LLM output is
  // `\n` in practice. See the doc comment on splitPlainChunks.
  it("keeps CRLF blank lines inside one chunk", () => {
    expect(splitPlainChunks("a\r\n\r\nb")).toEqual(["a\r\n\r\nb"]);
    // Mixed input: only pure-`\n` runs split.
    expect(splitPlainChunks("a\r\n\r\nb\n\nc")).toEqual(["a\r\n\r\nb\n\n", "c"]);
  });

  it("never emits empty phantom chunks (multi-blank-line / trailing newlines)", () => {
    expect(splitPlainChunks("")).toEqual([]);
    // A trailing newline run stays inside the last chunk (it may still grow).
    expect(splitPlainChunks("a\n")).toEqual(["a\n"]);
    expect(splitPlainChunks("a\n\n")).toEqual(["a\n\n"]);
    expect(splitPlainChunks("a\n\nb\n\n")).toEqual(["a\n\n", "b\n\n"]);
    // Degenerate all-newlines input is a single deterministic chunk.
    expect(splitPlainChunks("\n\n\n")).toEqual(["\n\n\n"]);
    for (const text of ["a\n\n\nb\n\n", "x\n\n\n\n\ny\n\nz\n"]) {
      for (const chunk of splitPlainChunks(text)) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("StreamingPlainText", () => {
  it("renders one block per chunk, stripping trailing separator newlines at display time", () => {
    const text = "первый абзац\n\nвторой абзац\n\n\nтретий";
    const { container } = render(<StreamingPlainText text={text} />);
    const blocks = Array.from(container.querySelectorAll("div"));
    // One block element per chunk.
    expect(blocks.length).toBe(splitPlainChunks(text).length);
    // DISPLAY-ONLY strip: each rendered block drops its chunk's trailing
    // separator newlines — rendering them inside a pre-wrap block would add an
    // empty line ON TOP of the block break (a doubled gap). The RAW chunks
    // keep their separators (losslessness is asserted on splitPlainChunks
    // above); multi-blank-line runs collapse to one uniform gap, consistent
    // with collapseBlankLines on the finalized markdown path.
    expect(blocks.map((b) => b.textContent)).toEqual([
      "первый абзац",
      "второй абзац",
      "третий",
    ]);
    // The uniform paragraph gap comes from the block margin instead (matches
    // the `.reasoningText p { margin: 0 0 4px }` rhythm of the markdown path).
    for (const block of blocks) {
      expect((block as HTMLElement).style.marginBottom).toBe("4px");
    }
  });

  it("keeps interior newlines intact — only the trailing run is stripped", () => {
    const text = "строка один\nстрока два\n\nхвост";
    const { container } = render(<StreamingPlainText text={text} />);
    const blocks = Array.from(container.querySelectorAll("div"));
    expect(blocks.map((b) => b.textContent)).toEqual([
      "строка один\nстрока два",
      "хвост",
    ]);
  });
});
