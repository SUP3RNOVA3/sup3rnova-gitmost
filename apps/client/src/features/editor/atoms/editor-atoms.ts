import { atom } from "jotai";
// Type-only: these atoms only hold an Editor reference for typing. A value
// import would drag the whole @tiptap/core engine into the eager graph of every
// shell component that reads one of these atoms.
import type { Editor } from "@tiptap/core";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import type { DictationUnavailableReason } from "@/features/dictation/dictation-status";

export const pageEditorAtom = atom<Editor | null>(null);

// #370 — the active page's collab provider, published by the page editor so the
// header menu can emit the "save-version" stateless signal (Cmd+S / button).
// Null when the page is read-only / collab isn't connected. A typed initial
// value (rather than an explicit generic) keeps jotai's overload resolution on
// the writable PrimitiveAtom branch.
const initialCollabProvider: HocuspocusProvider | null = null;
export const collabProviderAtom = atom(initialCollabProvider);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

export const showLinkMenuAtom = atom(false);

// Current page's edit mode — initialized from the user's saved preference on
// first load, can be toggled locally without persisting to the server.
export const currentPageEditModeAtom = atom<PageEditMode>(PageEditMode.Edit);

// Whether the dictation mic can start, and (when it can't) the cause-specific
// reason the mic button surfaces as a tooltip. Published by the page editor,
// consumed by DictationGroup -> MicButton.
export type DictationAvailability = {
  isEditable: boolean;
  reason: DictationUnavailableReason | null;
};
export const dictationAvailabilityAtom = atom<DictationAvailability>({
  isEditable: false,
  reason: null,
});
