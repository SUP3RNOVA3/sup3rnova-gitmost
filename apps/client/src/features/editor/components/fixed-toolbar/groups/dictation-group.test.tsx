import { describe, it, expect, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, act } from "@testing-library/react";

// Regression test for #311: on a page the user can edit, the byline mic stayed
// stuck disabled until an unrelated re-render happened, because DictationGroup
// read the non-reactive field `editor.isEditable` directly. The fix reads it via
// `useEditorState`, which subscribes to the editor's own events.
//
// The mock below mirrors the real `useEditorState` contract: it runs the
// selector, and re-runs it (re-rendering the consumer) whenever the editor emits
// an event. This is what makes the test faithful — with the pre-fix code
// (`disabled={!editor.isEditable}`) DictationGroup never subscribes, so emitting
// an event would NOT re-render and the mic would stay disabled.
vi.mock("@tiptap/react", () => ({
  useEditorState: ({ editor, selector }: any) => {
    const [value, setValue] = useState(() => selector({ editor }));
    useEffect(() => {
      const handler = () => setValue(selector({ editor }));
      editor.on("update", handler);
      return () => editor.off("update", handler);
    }, [editor, selector]);
    return value;
  },
}));

// The mic only cares about the workspace's streaming flag; return a stable stub.
vi.mock("jotai", () => ({
  useAtomValue: () => ({ settings: { ai: { dictationStreaming: false } } }),
}));
vi.mock("@/features/user/atoms/current-user-atom.ts", () => ({
  workspaceAtom: {},
}));

// Detectable stand-in that surfaces the `disabled` prop the component computes.
vi.mock("@/features/dictation/components/mic-button", () => ({
  MicButton: ({ disabled }: any) => (
    <button data-testid="mic" disabled={disabled} />
  ),
}));

import { DictationGroup } from "./dictation-group";

// Minimal editor stand-in: a mutable `isEditable` field plus a tiny event
// emitter, matching the surface DictationGroup + the mocked useEditorState use.
function makeFakeEditor(isEditable: boolean) {
  const listeners = new Set<() => void>();
  return {
    isEditable,
    isDestroyed: false,
    state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
    on: (_event: string, cb: () => void) => listeners.add(cb),
    off: (_event: string, cb: () => void) => listeners.delete(cb),
    emit: () => listeners.forEach((cb) => cb()),
  } as any;
}

describe("DictationGroup editable reactivity (#311)", () => {
  it("re-enables the mic when the editor flips isEditable false -> true", () => {
    const editor = makeFakeEditor(false);
    const { getByTestId } = render(<DictationGroup editor={editor} />);

    // Pre-sync: not editable yet, so the mic is disabled (preserves #218 intent).
    expect(getByTestId("mic").hasAttribute("disabled")).toBe(true);

    // Collab sync flips the editor editable via editor.setEditable(true), which
    // mutates the field and emits — the mic must react and enable itself.
    act(() => {
      editor.isEditable = true;
      editor.emit();
    });

    expect(getByTestId("mic").hasAttribute("disabled")).toBe(false);
  });
});
