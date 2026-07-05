import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Node as PMNode } from "@tiptap/pm/model";
import { MultiCursor, multiCursorPluginKey, MAX_CURSORS } from "./multi-cursor";
import { findOccurrences } from "../search-and-replace/find-occurrences";

const extensions = [Document, Paragraph, Text, Bold, MultiCursor];

function makeEditor(content?: any) {
  return new Editor({
    extensions,
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
}

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  };
}

function paraTexts(d: PMNode): string[] {
  const out: string[] = [];
  d.forEach((node) => {
    if (node.type.name === "paragraph") out.push(node.textContent);
  });
  return out;
}

function cursors(editor: Editor) {
  return multiCursorPluginKey.getState(editor.state)!.cursors;
}

// Simulate typing a character through the real handleTextInput routing (the
// browser path). someMethod-equivalent: dispatch a DOM-ish text input by calling
// the view's input handler directly.
function typeText(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  // props.handleTextInput is what ProseMirror calls on beforeinput/keypress.
  const handled = editor.view.someProp(
    "handleTextInput",
    (fn) => fn(editor.view, from, to, text) || false,
  );
  if (!handled) {
    // Fall back to a normal insertion (no active multi-cursor set).
    editor.view.dispatch(editor.state.tr.insertText(text, from, to));
  }
}

function pressKey(editor: Editor, key: string) {
  editor.view.someProp("handleKeyDown", (fn) =>
    fn(editor.view, new KeyboardEvent("keydown", { key })),
  );
}

describe("multi-cursor: selectAllOccurrences", () => {
  it("finds EVERY occurrence of a repeated word under the cursor", () => {
    const editor = makeEditor(doc("foo bar foo baz foo"));
    // Cursor inside the first "foo".
    editor.commands.setTextSelection(2);
    expect(editor.commands.selectAllOccurrences()).toBe(true);

    const cs = cursors(editor);
    expect(cs.length).toBe(3);
    // Every cursor spans a "foo".
    for (const c of cs) {
      expect(editor.state.doc.textBetween(c.from, c.to)).toBe("foo");
    }
    editor.destroy();
  });

  it("uses the current non-empty selection as the term", () => {
    const editor = makeEditor(doc("ab abc ab abcd ab"));
    // Select the first "ab".
    editor.commands.setTextSelection({ from: 1, to: 3 });
    expect(editor.state.doc.textBetween(1, 3)).toBe("ab");
    editor.commands.selectAllOccurrences();
    // Literal substring match (selection is not whole-word), so every "ab"
    // including those inside "abc"/"abcd" is matched: 5 total.
    const cs = cursors(editor);
    expect(cs.length).toBe(5);
    editor.destroy();
  });

  it("whole-word matching from a word cursor does not match substrings", () => {
    const editor = makeEditor(doc("cat category cat scatter cat"));
    editor.commands.setTextSelection(2); // inside first "cat"
    editor.commands.selectAllOccurrences();
    // Only the three standalone "cat" words, not "category"/"scatter".
    expect(cursors(editor).length).toBe(3);
    editor.destroy();
  });
});

describe("multi-cursor: mass typing (single transaction)", () => {
  it("types text into N carets at once", () => {
    const editor = makeEditor(doc("foo foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(3);

    // Typing replaces each selected "foo" with "X".
    typeText(editor, "X");
    expect(paraTexts(editor.state.doc)).toEqual(["X X X"]);

    // The cursors are now carets right after each inserted "X".
    const cs = cursors(editor);
    expect(cs.length).toBe(3);
    for (const c of cs) expect(c.from).toBe(c.to);
    editor.destroy();
  });

  it("continues typing at the resulting carets (append semantics)", () => {
    const editor = makeEditor(doc("a a a"));
    editor.commands.setTextSelection(1);
    editor.commands.selectAllOccurrences();
    typeText(editor, "b"); // each "a" -> "b"
    typeText(editor, "c"); // append at each caret -> "bc"
    expect(paraTexts(editor.state.doc)).toEqual(["bc bc bc"]);
    editor.destroy();
  });

  it("applies the whole multi-edit in a SINGLE transaction (one undo step)", () => {
    // "One Cmd/Ctrl+Z undoes the whole multi-edit" holds iff the N edits land in
    // ONE transaction (history groups by transaction). @tiptap/extension-history
    // is not a dependency here, so rather than exercise undo we assert the
    // property that guarantees it: typing into N cursors is exactly ONE dispatch.
    const editor = makeEditor(doc("foo foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(3);

    const orig = editor.view.dispatch.bind(editor.view);
    let dispatches = 0;
    editor.view.dispatch = (tr) => {
      dispatches += 1;
      return orig(tr);
    };
    typeText(editor, "Z");
    editor.view.dispatch = orig;

    expect(dispatches).toBe(1); // all three edits share one transaction
    expect(paraTexts(editor.state.doc)).toEqual(["Z Z Z"]);
    editor.destroy();
  });

  it("off-by-one guard: reverse-order iteration keeps every position valid", () => {
    // If the mass edit iterated FORWARD, inserting at an earlier cursor would
    // shift every later cursor and corrupt the result. Different-length
    // replacement makes such a bug visible.
    const editor = makeEditor(doc("x x x x"));
    editor.commands.setTextSelection(1);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(4);
    typeText(editor, "LONG");
    expect(paraTexts(editor.state.doc)).toEqual(["LONG LONG LONG LONG"]);
    editor.destroy();
  });
});

describe("multi-cursor: mass Backspace / Delete", () => {
  it("Backspace removes one char before each caret", () => {
    const editor = makeEditor(doc("foo foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    // Collapse selections to carets at the END of each "foo" by typing then
    // removing is complex; instead type to convert ranges into carets first.
    typeText(editor, "ab"); // each "foo" -> "ab", carets after "ab"
    expect(paraTexts(editor.state.doc)).toEqual(["ab ab ab"]);
    pressKey(editor, "Backspace"); // remove the trailing "b" at each caret
    expect(paraTexts(editor.state.doc)).toEqual(["a a a"]);
    editor.destroy();
  });

  it("Delete removes one char after each caret", () => {
    const editor = makeEditor(doc("fooX fooX"));
    // Literal (selection) match of "foo" -> both occurrences inside "fooX".
    editor.commands.setTextSelection({ from: 1, to: 4 }); // first "foo"
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    typeText(editor, "foo"); // rewrite "foo", carets now sit before each "X"
    expect(paraTexts(editor.state.doc)).toEqual(["fooX fooX"]);
    pressKey(editor, "Delete"); // remove the "X" after each caret
    expect(paraTexts(editor.state.doc)).toEqual(["foo foo"]);
    editor.destroy();
  });

  it("Backspace at a block-start caret is a no-op for that cursor", () => {
    const editor = makeEditor(doc("ab", "ab"));
    // Select both "ab" then convert to carets at start by replacing with "".
    editor.commands.setTextSelection({ from: 1, to: 3 }); // first "ab"
    editor.commands.selectAllOccurrences();
    // Move carets to block start: type "" is not possible; instead delete range.
    pressKey(editor, "Backspace"); // deletes each selected "ab"
    expect(paraTexts(editor.state.doc)).toEqual(["", ""]);
    // Carets are now at each block start; another Backspace must not throw and
    // must not merge blocks (still two empty paragraphs).
    pressKey(editor, "Backspace");
    expect(paraTexts(editor.state.doc)).toEqual(["", ""]);
    editor.destroy();
  });
});

describe("multi-cursor: addNextOccurrence (Cmd/Ctrl+D)", () => {
  it("first press selects the current word, next press adds the next", () => {
    const editor = makeEditor(doc("go go go"));
    editor.commands.setTextSelection(2); // inside first "go"
    editor.commands.addNextOccurrence();
    expect(cursors(editor).length).toBe(1);
    editor.commands.addNextOccurrence();
    expect(cursors(editor).length).toBe(2);
    editor.commands.addNextOccurrence();
    expect(cursors(editor).length).toBe(3);
    // Nothing left to add — stays at 3.
    editor.commands.addNextOccurrence();
    expect(cursors(editor).length).toBe(3);
    for (const c of cursors(editor)) {
      expect(editor.state.doc.textBetween(c.from, c.to)).toBe("go");
    }
    editor.destroy();
  });
});

describe("multi-cursor: position remapping", () => {
  it("remaps cursors after a LOCAL edit before them", () => {
    const editor = makeEditor(doc("foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    const before = cursors(editor).map((c) => ({ ...c }));

    // Insert unrelated text at the very start (pos 1), shifting everything +5.
    editor.view.dispatch(editor.state.tr.insertText("HELLO", 1));

    const after = cursors(editor);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < after.length; i += 1) {
      expect(after[i].from).toBe(before[i].from + 5);
      expect(after[i].to).toBe(before[i].to + 5);
      // And they still point at "foo".
      expect(editor.state.doc.textBetween(after[i].from, after[i].to)).toBe(
        "foo",
      );
    }
    editor.destroy();
  });

  it("remaps cursors after a simulated REMOTE edit (ordinary transaction)", () => {
    const editor = makeEditor(doc("foo bar foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    const before = cursors(editor).map((c) => ({ ...c }));
    expect(before.length).toBe(2);

    // y-prosemirror applies remote changes as ordinary transactions. Emulate a
    // remote insertion between the two "foo"s (inside "bar", pos 6) with a tr
    // that carries NO multi-cursor meta — exactly like a collaborator's edit.
    const tr = editor.state.tr.insertText("ZZ", 6);
    editor.view.dispatch(tr);

    const after = cursors(editor);
    // The first "foo" (before the insertion) is unchanged; the second shifts +2.
    expect(after[0].from).toBe(before[0].from);
    expect(after[1].from).toBe(before[1].from + 2);
    for (const c of after) {
      expect(editor.state.doc.textBetween(c.from, c.to)).toBe("foo");
    }
    editor.destroy();
  });
});

describe("multi-cursor: collapse / exit", () => {
  it("exitMultiCursor clears the set", () => {
    const editor = makeEditor(doc("foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    editor.commands.exitMultiCursor();
    expect(cursors(editor).length).toBe(0);
    editor.destroy();
  });

  it("an arrow key collapses the set", () => {
    const editor = makeEditor(doc("foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    pressKey(editor, "ArrowRight");
    expect(cursors(editor).length).toBe(0);
    editor.destroy();
  });
});

describe("multi-cursor: collapse on composition / mousedown", () => {
  // Invoke a plugin handleDOMEvents handler through the real prop plumbing.
  function fireDOM(editor: Editor, name: string): void {
    editor.view.someProp("handleDOMEvents", (handlers: any) => {
      const h = handlers && handlers[name];
      if (h) h(editor.view, new Event(name));
      return false;
    });
  }

  it("collapses the set on compositionstart (IME) — MVP does not multi-IME", () => {
    const editor = makeEditor(doc("foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    fireDOM(editor, "compositionstart");
    expect(cursors(editor).length).toBe(0);
    editor.destroy();
  });

  it("collapses the set on a plain mousedown (VS Code behaviour)", () => {
    const editor = makeEditor(doc("foo foo"));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    fireDOM(editor, "mousedown");
    expect(cursors(editor).length).toBe(0);
    editor.destroy();
  });
});

describe("multi-cursor: hard cap", () => {
  it("never activates more than MAX_CURSORS cursors", () => {
    const many = new Array(MAX_CURSORS + 20).fill("w").join(" ");
    const editor = makeEditor(doc(many));
    editor.commands.setTextSelection(2);
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(MAX_CURSORS);
    editor.destroy();
  });
});

describe("multi-cursor: marks are carried across a mass edit", () => {
  it("preserves marks spanning each replaced range", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a " },
            { type: "text", marks: [{ type: "bold" }], text: "key" },
            { type: "text", text: " b " },
            { type: "text", marks: [{ type: "bold" }], text: "key" },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(3); // inside first bold "key"
    editor.commands.selectAllOccurrences();
    expect(cursors(editor).length).toBe(2);
    typeText(editor, "NEW");

    // Both replacements keep the bold mark.
    let boldRuns = 0;
    editor.state.doc.descendants((node) => {
      if (
        node.isText &&
        node.text === "NEW" &&
        node.marks.some((m) => m.type.name === "bold")
      ) {
        boldRuns += 1;
      }
    });
    expect(boldRuns).toBe(2);
    editor.destroy();
  });
});

// The extracted find-occurrences util must return the SAME occurrences that the
// old inline walk produced (and that search-and-replace still relies on).
describe("find-occurrences util", () => {
  it("finds all matches of a literal regex across text nodes", () => {
    const editor = makeEditor(doc("foo foofoo foo"));
    const results = findOccurrences(editor.state.doc, /foo/gu);
    // 4 occurrences: two standalone + two inside "foofoo".
    expect(results.length).toBe(4);
    for (const r of results) {
      expect(editor.state.doc.textBetween(r.from, r.to)).toBe("foo");
    }
    editor.destroy();
  });

  it("ignores whitespace-only matches and empty regex", () => {
    const editor = makeEditor(doc("a b c"));
    expect(findOccurrences(editor.state.doc, null as any).length).toBe(0);
    // A whitespace regex yields no results (matches are trimmed away).
    expect(findOccurrences(editor.state.doc, /\s/gu).length).toBe(0);
    editor.destroy();
  });

  it("finds a match spanning two differently-marked contiguous text nodes", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "wo" },
            { type: "text", marks: [{ type: "bold" }], text: "rd" },
          ],
        },
      ],
    });
    const results = findOccurrences(editor.state.doc, /word/gu);
    expect(results.length).toBe(1);
    expect(editor.state.doc.textBetween(results[0].from, results[0].to)).toBe(
      "word",
    );
    editor.destroy();
  });
});
