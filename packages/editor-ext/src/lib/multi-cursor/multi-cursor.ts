import { Extension, Range } from "@tiptap/core";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Mark } from "@tiptap/pm/model";
import { findOccurrences } from "../search-and-replace/find-occurrences";

/**
 * Multi-cursor editing — MVP (issue #196, "Variant A").
 *
 * VS Code-style multi-cursor limited to "select all occurrences of a word (or
 * the current selection) and type into all of them at once", built ON TOP OF
 * the search-and-replace mass-transaction machinery:
 *
 *   - Cmd/Ctrl+Shift+L (selectAllOccurrences): the word under the cursor (or the
 *     current non-empty selection) -> ALL its occurrences become active cursors.
 *   - Cmd/Ctrl+D (addNextOccurrence): add the NEXT occurrence of the term.
 *   - Typing / Backspace / Delete apply to EVERY active cursor in ONE
 *     transaction (so a single Cmd/Ctrl+Z undoes the whole multi-edit).
 *   - Esc (exitMultiCursor): collapse back to a single cursor.
 *
 * The single-transaction, reverse-order edit mechanic mirrors `replaceAll` in
 * search-and-replace.ts: we iterate cursors from the END of the document to the
 * START so an earlier edit never invalidates a later position, carrying the
 * marks that span each range.
 *
 * CONSCIOUS v1 OUT-OF-SCOPE BOUNDARIES (these are "Variant B", deliberately NOT
 * built here):
 *   - Alt+Click arbitrary carets and Alt+drag column selection.
 *   - Cmd/Ctrl+Alt+Up/Down "add cursor on the adjacent line".
 *   - Cursors inside tables / code-blocks / callouts — like replaceAll this
 *     operates on plain text occurrences only (schema violations are skipped
 *     per-cursor as a backstop, never applied half-way).
 *   - Simultaneous IME / composition input into multiple positions — on
 *     `compositionstart` we collapse back to a single cursor.
 *   - Cursors spanning different schema nodes.
 */

interface MultiCursorState {
  // Each active cursor: a caret when from === to, a range when from < to.
  cursors: Range[];
}

export const multiCursorPluginKey = new PluginKey<MultiCursorState>(
  "multiCursor",
);

// Hard safety cap on simultaneously-active cursors — stop adding past it.
export const MAX_CURSORS = 100;

export interface MultiCursorStorage {
  // Whether the active term matches whole words only. Set to true when the set
  // was seeded from a bare cursor (word under caret), false when seeded from an
  // explicit selection (literal substring match, like VS Code). Remembered so
  // addNextOccurrence keeps matching the same way as selectAllOccurrences.
  wholeWord: boolean;
}

declare module "@tiptap/core" {
  interface Storage {
    multiCursor: MultiCursorStorage;
  }
  interface Commands<ReturnType> {
    multiCursor: {
      /** Select all occurrences of the word/selection as active cursors. */
      selectAllOccurrences: () => ReturnType;
      /** Add the next occurrence of the current term to the cursor set. */
      addNextOccurrence: () => ReturnType;
      /** Collapse the multi-cursor set back to a single cursor. */
      exitMultiCursor: () => ReturnType;
    };
  }
}

// ---------------------------------------------------------------------------
// Term helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A "word" is a run of letters/numbers/underscore; those get whole-word
// matching (\b…\b) so a term never matches inside a larger word. Anything else
// (punctuation, phrases) is matched literally. Case-sensitive, like VS Code.
function isWordTerm(s: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(s);
}

// wholeWord uses \b…\b so the term never matches inside a larger word; it only
// applies to word-like terms (a term containing punctuation cannot be
// whole-word-bounded meaningfully). Otherwise the term is matched literally.
function buildTermRegex(term: string, wholeWord: boolean): RegExp {
  const esc = escapeRegExp(term);
  return wholeWord && isWordTerm(term)
    ? new RegExp(`\\b${esc}\\b`, "gu")
    : new RegExp(esc, "gu");
}

// Word under a position: returns the exact { from, to } range and its text, or
// null if the position is not inside a word in a textblock.
function getWordAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; text: string } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;

  const text = parent.textContent;
  const offset = $pos.parentOffset;
  const start = $pos.start();
  const wordRe = /[\p{L}\p{N}_]+/gu;

  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    const s = m.index;
    const e = m.index + m[0].length;
    if (offset >= s && offset <= e) {
      return { from: start + s, to: start + e, text: m[0] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin-state access
// ---------------------------------------------------------------------------

function getCursors(state: EditorState): Range[] {
  const st = multiCursorPluginKey.getState(state);
  return st ? st.cursors : [];
}

function setCursors(view: EditorView, cursors: Range[]): void {
  view.dispatch(view.state.tr.setMeta(multiCursorPluginKey, cursors));
}

function collapse(view: EditorView): void {
  setCursors(view, []);
}

// ---------------------------------------------------------------------------
// The single-transaction, reverse-order mass edit (mirrors replaceAll)
// ---------------------------------------------------------------------------

interface EditOp {
  from: number;
  to: number;
  // Text to insert at `from` after deleting [from, to); "" for a pure delete.
  text: string;
}

/**
 * Apply one edit per cursor in ONE transaction. Ops are processed from the END
 * of the document to the START so an earlier edit never shifts a later position
 * (mirrors `replaceAll`). Each cursor is wrapped independently: a schema
 * violation SKIPS that one cursor instead of throwing away the whole
 * transaction, so the document is never left half-applied.
 *
 * After building the transaction the new cursor positions are recomputed by
 * mapping each op's original anchor through `tr.mapping` (which also remaps any
 * concurrent changes), so carets land right after their inserted text.
 */
function dispatchMassEdit(view: EditorView, ops: EditOp[]): boolean {
  if (!ops.length) return false;

  const { state } = view;
  const tr = state.tr;
  const schema = state.schema;

  // Ascending by `from`; iterate reverse so earlier positions stay valid.
  const sorted = [...ops].sort((a, b) => a.from - b.from);
  const appliedLen: number[] = new Array(sorted.length).fill(0);

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const { from, to, text } = sorted[i];
    try {
      let marks: readonly Mark[] = [];
      if (text) {
        if (to > from) {
          // Carry all marks spanning the replaced range.
          const set = new Set<Mark>();
          tr.doc.nodesBetween(from, to, (node) => {
            if (node.isText && node.marks) {
              node.marks.forEach((mk) => set.add(mk));
            }
          });
          marks = Array.from(set);
        } else {
          // Caret: continue the marks active at the insertion point.
          marks = state.storedMarks || state.doc.resolve(from).marks();
        }
      }

      // ONE atomic step per cursor: replaceWith covers both insert (from === to)
      // and replace (to > from); a pure delete (empty text) uses delete. This
      // can never leave a cursor half-applied (deleted but not re-inserted) the
      // way a separate delete-then-insert pair could if the insert step threw.
      if (text) {
        tr.replaceWith(from, to, schema.text(text, marks as Mark[]));
      } else if (to > from) {
        tr.delete(from, to);
      }

      appliedLen[i] = text.length;
    } catch {
      // Per-cursor backstop (text-only MVP): drop this cursor's edit, keep the
      // rest of the transaction intact.
      appliedLen[i] = 0;
    }
  }

  if (!tr.docChanged) return false;

  // Recompute cursor carets from the ORIGINAL op anchors through the full map.
  const newCursors: Range[] = sorted.map((op, i) => {
    const start = tr.mapping.map(op.from, -1);
    const caret = start + appliedLen[i];
    return { from: caret, to: caret };
  });

  tr.setMeta(multiCursorPluginKey, newCursors);

  // Park the native selection on the last caret so the browser draws exactly
  // one real caret; the rest are our decoration widgets.
  const last = newCursors[newCursors.length - 1];
  tr.setSelection(TextSelection.create(tr.doc, last.from));

  view.dispatch(tr);
  return true;
}

function buildDeleteOps(
  state: EditorState,
  cursors: Range[],
  forward: boolean,
): EditOp[] {
  return cursors.map((c) => {
    // A selected range: Backspace/Delete removes the whole range.
    if (c.to > c.from) return { from: c.from, to: c.to, text: "" };

    const $pos = state.doc.resolve(c.from);
    if (forward) {
      // Delete: at the end of a textblock there is nothing to remove (a no-op;
      // MVP does not merge blocks across a multi-cursor set).
      if ($pos.parentOffset >= $pos.parent.content.size) {
        return { from: c.from, to: c.from, text: "" };
      }
      return { from: c.from, to: c.from + 1, text: "" };
    }
    // Backspace: at the start of a textblock there is nothing to remove.
    if ($pos.parentOffset <= 0) {
      return { from: c.from, to: c.from, text: "" };
    }
    return { from: c.from - 1, to: c.from, text: "" };
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const MultiCursor = Extension.create<unknown, MultiCursorStorage>({
  name: "multiCursor",

  addStorage() {
    return { wholeWord: true };
  },

  addCommands() {
    return {
      selectAllOccurrences:
        () =>
        ({ editor, state, tr, dispatch }) => {
          let term: string;
          // A bare cursor expands to the whole word; an explicit selection is
          // matched literally (VS Code semantics).
          const wholeWord = state.selection.empty;
          if (wholeWord) {
            const word = getWordAt(state, state.selection.from);
            if (!word) return false;
            term = word.text;
          } else {
            term = state.doc.textBetween(
              state.selection.from,
              state.selection.to,
            );
          }
          if (!term.trim()) return false;
          editor.storage.multiCursor.wholeWord = wholeWord;

          const results = findOccurrences(
            state.doc,
            buildTermRegex(term, wholeWord),
          ).slice(0, MAX_CURSORS);
          if (!results.length) return false;

          if (dispatch) {
            tr.setMeta(multiCursorPluginKey, results);
            const last = results[results.length - 1];
            tr.setSelection(TextSelection.create(tr.doc, last.from, last.to));
            dispatch(tr);
          }
          return true;
        },

      addNextOccurrence:
        () =>
        ({ editor, state, tr, dispatch }) => {
          const existing = getCursors(state);
          let cursors: Range[];

          if (!existing.length) {
            // First press: turn the current word/selection into the one cursor.
            let range: Range;
            const wholeWord = state.selection.empty;
            if (wholeWord) {
              const word = getWordAt(state, state.selection.from);
              if (!word) return false;
              range = { from: word.from, to: word.to };
            } else {
              range = { from: state.selection.from, to: state.selection.to };
            }
            editor.storage.multiCursor.wholeWord = wholeWord;
            cursors = [range];
          } else {
            // Subsequent press: add the next unselected occurrence of the term,
            // matched the SAME way (whole-word vs literal) the set was seeded.
            if (existing.length >= MAX_CURSORS) return true;

            const first = existing[0];
            const term = state.doc.textBetween(first.from, first.to);
            if (!term.trim()) return false;

            const results = findOccurrences(
              state.doc,
              buildTermRegex(term, editor.storage.multiCursor.wholeWord),
            );
            const keys = new Set(existing.map((c) => `${c.from}:${c.to}`));
            const notSelected = results.filter(
              (r) => !keys.has(`${r.from}:${r.to}`),
            );
            if (!notSelected.length) return true; // all occurrences selected

            const maxTo = Math.max(...existing.map((c) => c.to));
            const next =
              notSelected.find((r) => r.from >= maxTo) || notSelected[0];
            cursors = [...existing, next];
          }

          if (dispatch) {
            tr.setMeta(multiCursorPluginKey, cursors);
            const last = cursors[cursors.length - 1];
            tr.setSelection(TextSelection.create(tr.doc, last.from, last.to));
            dispatch(tr);
          }
          return true;
        },

      exitMultiCursor:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(multiCursorPluginKey, []);
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-l": () => {
        this.editor.commands.selectAllOccurrences();
        // Always consume so the browser's default is prevented.
        return true;
      },
      "Mod-d": () => {
        this.editor.commands.addNextOccurrence();
        // Consume unconditionally to prevent the browser's Cmd/Ctrl+D bookmark.
        return true;
      },
      Escape: () => {
        // Only swallow Escape while a multi-cursor set is active; otherwise let
        // Escape keep its other behaviours (e.g. closing dialogs).
        if (!getCursors(this.editor.state).length) return false;
        return this.editor.commands.exitMultiCursor();
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<MultiCursorState>({
        key: multiCursorPluginKey,

        state: {
          init: () => ({ cursors: [] }),
          apply(tr, value): MultiCursorState {
            // A command (or a mass edit) can set/clear the cursor set directly.
            // Its cursors are already in the post-transaction coordinate space,
            // so they take priority over remapping.
            const meta = tr.getMeta(multiCursorPluginKey) as
              | Range[]
              | undefined;
            if (meta !== undefined) {
              return { cursors: meta.slice(0, MAX_CURSORS) };
            }

            if (!value.cursors.length) return value;

            // Remap surviving cursors across ANY doc change — this covers both
            // local edits and REMOTE Yjs edits (y-prosemirror applies remote
            // changes as ordinary transactions, so mapping them here keeps every
            // multi-cursor correctly positioned without special-casing collab).
            if (tr.docChanged) {
              // Map both edges with the SAME association (+1) so content
              // inserted at a boundary shifts the whole cursor right and a caret
              // (from === to) can never invert into a range.
              const cursors = value.cursors.map((c) => ({
                from: tr.mapping.map(c.from, 1),
                to: tr.mapping.map(c.to, 1),
              }));
              return { cursors };
            }

            return value;
          },
        },

        props: {
          decorations(state) {
            const st = multiCursorPluginKey.getState(state);
            if (!st || !st.cursors.length) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            st.cursors.forEach((c, i) => {
              if (c.from === c.to) {
                decorations.push(
                  Decoration.widget(
                    c.from,
                    () => {
                      const el = document.createElement("span");
                      el.className = "multi-cursor__caret";
                      return el;
                    },
                    { side: 0, key: `mc-caret-${i}` },
                  ),
                );
              } else {
                decorations.push(
                  Decoration.inline(c.from, c.to, {
                    class: "multi-cursor__selection",
                  }),
                );
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },

          handleTextInput(view, _from, _to, text) {
            const cursors = getCursors(view.state);
            if (!cursors.length) return false;

            // Insert `text` at EVERY cursor in one transaction. Returning true
            // prevents ProseMirror's own single-position insert at the native
            // selection, so there is no double-insert there.
            const ops = cursors.map((c) => ({
              from: c.from,
              to: c.to,
              text,
            }));
            return dispatchMassEdit(view, ops);
          },

          handleKeyDown(view, event) {
            const cursors = getCursors(view.state);
            if (!cursors.length) return false;

            if (event.key === "Backspace") {
              dispatchMassEdit(view, buildDeleteOps(view.state, cursors, false));
              return true;
            }
            if (event.key === "Delete") {
              dispatchMassEdit(view, buildDeleteOps(view.state, cursors, true));
              return true;
            }

            // Let modifier combinations (our own shortcuts, copy, etc.) through
            // WITHOUT collapsing the set.
            if (event.metaKey || event.ctrlKey || event.altKey) return false;

            // Navigation / block keys collapse back to a single cursor, then let
            // ProseMirror handle the movement on the native selection.
            const COLLAPSE_KEYS = [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
              "Enter",
              "Tab",
            ];
            if (COLLAPSE_KEYS.includes(event.key)) {
              collapse(view);
              return false;
            }

            return false;
          },

          handleDOMEvents: {
            // A plain click exits multi-cursor (VS Code behaviour).
            mousedown: (view) => {
              if (getCursors(view.state).length) collapse(view);
              return false;
            },
            // MVP does not drive multi-position IME — collapse on composition.
            compositionstart: (view) => {
              if (getCursors(view.state).length) collapse(view);
              return false;
            },
          },
        },
      }),
    ];
  },
});

export default MultiCursor;
