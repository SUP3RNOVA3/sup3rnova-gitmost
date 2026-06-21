import { atom } from "jotai";
import { Editor } from "@tiptap/core";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import type { DictationUnavailableReason } from "@/features/dictation/dictation-status";

export const pageEditorAtom = atom<Editor | null>(null);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

// Local (IndexedDB) persistence sync state for the current page's Y.Doc.
export const isLocalSyncedAtom = atom<boolean>(false);

// Remote (Hocuspocus) sync state for the current page's Y.Doc.
export const isRemoteSyncedAtom = atom<boolean>(false);

export const showAiMenuAtom = atom(false);

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
