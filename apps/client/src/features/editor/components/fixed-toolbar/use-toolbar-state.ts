import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { undoDepth, redoDepth } from "@tiptap/pm/history";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

export interface ToolbarState {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  isCode: boolean;
  isSubscript: boolean;
  isSuperscript: boolean;
  isBulletList: boolean;
  isOrderedList: boolean;
  isTaskList: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

// Undo/redo availability, computed WITHOUT `editor.can().undo()/.redo()`.
//
// `editor.can()` runs the command as a dry-run (building a throwaway state +
// transaction) — the most expensive work in this selector, and it ran on every
// keystroke (and every REMOTE keystroke under collaboration). Instead we read
// the history stack depth directly, which is a cheap plugin-state lookup and
// mirrors exactly what the undo/redo commands themselves check:
//
//  - Collaboration (Yjs): the yjs UndoManager's undo/redo stack lengths — the
//    same `undoStack.length === 0` / `redoStack.length === 0` guard the
//    Collaboration extension's undo/redo commands use.
//  - Plain history (templates / non-collab): prosemirror-history's undoDepth /
//    redoDepth, which back the UndoRedo extension.
//
// When neither history backend is installed (the pre-sync static editor —
// mainExtensions only, undoRedo disabled), both fall through to 0 -> false,
// matching the previous `safeCan` behavior.
function historyAvailability(editor: Editor): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const state = editor.state;

  // Collaboration history (Yjs) takes precedence when present.
  const yState = yUndoPluginKey.getState(state) as
    | { undoManager?: { undoStack: unknown[]; redoStack: unknown[] } }
    | undefined;
  if (yState?.undoManager) {
    return {
      canUndo: yState.undoManager.undoStack.length > 0,
      canRedo: yState.undoManager.redoStack.length > 0,
    };
  }

  // Plain prosemirror-history (returns 0 when the history plugin is absent).
  return {
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

export function useToolbarState(editor: Editor | null): ToolbarState | null {
  return useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) return null;
      const { canUndo, canRedo } = historyAvailability(ctx.editor);
      return {
        isBold: ctx.editor.isActive("bold"),
        isItalic: ctx.editor.isActive("italic"),
        isUnderline: ctx.editor.isActive("underline"),
        isStrike: ctx.editor.isActive("strike"),
        isCode: ctx.editor.isActive("code"),
        isSubscript: ctx.editor.isActive("subscript"),
        isSuperscript: ctx.editor.isActive("superscript"),
        isBulletList: ctx.editor.isActive("bulletList"),
        isOrderedList: ctx.editor.isActive("orderedList"),
        isTaskList: ctx.editor.isActive("taskList"),
        canUndo,
        canRedo,
      };
    },
  });
}
