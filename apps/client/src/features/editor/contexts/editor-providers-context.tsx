import { createContext, useContext } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

// Shared collaboration providers lifted above the title/body editors so that
// both siblings bind to the SAME Y.Doc and HocuspocusProvider. The title lives
// in a dedicated 'title' fragment of the same doc as the body.
export interface EditorProvidersContextValue {
  ydoc: Y.Doc;
  remote: HocuspocusProvider;
  providersReady: boolean;
}

export const EditorProvidersContext =
  createContext<EditorProvidersContextValue | null>(null);

// Returns the shared providers, or null when rendered outside of a provider.
// Consumers must be null-safe (the body editor falls back to a non-collab mode).
export function useEditorProviders(): EditorProvidersContextValue | null {
  return useContext(EditorProvidersContext);
}
