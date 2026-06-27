import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Drive the fallback-vs-collaborative switch (titleReady = providersReady &&
// !!ydoc) by controlling what the editor-providers context returns.
const editorProvidersValue: { ydoc: unknown; providersReady: boolean } = {
  ydoc: null,
  providersReady: false,
};
vi.mock("@/features/editor/contexts/editor-providers-context", () => ({
  useEditorProviders: () => editorProvidersValue,
}));

// Mock the tiptap React bindings so the test does not mount a real editor:
// useEditor returns a minimal stub and EditorContent renders a marker.
vi.mock("@tiptap/react", () => ({
  useEditor: () => ({
    isInitialized: true,
    commands: { focus: vi.fn() },
    setEditable: vi.fn(),
    getText: () => "",
  }),
  EditorContent: () => <div data-testid="collab-editor" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/features/websocket/use-query-emit.ts", () => ({
  useQueryEmit: () => vi.fn(),
}));

// page-query transitively imports @/main.tsx; mock it to a pure stub.
vi.mock("@/features/page/queries/page-query", () => ({
  updatePageData: vi.fn(),
}));
vi.mock("@/main.tsx", () => ({
  queryClient: { getQueryData: vi.fn(), setQueryData: vi.fn() },
}));

import { TitleEditor } from "./title-editor";

const baseProps = {
  pageId: "p1",
  slugId: "slug-1",
  title: "My Page Title",
  spaceSlug: "space",
  editable: true,
};

beforeEach(() => {
  navigateMock.mockReset();
  editorProvidersValue.ydoc = null;
  editorProvidersValue.providersReady = false;
});

describe("TitleEditor fallback vs collaborative switch", () => {
  it("renders a static <h1> with the title before the shared doc is ready", () => {
    editorProvidersValue.ydoc = null;
    editorProvidersValue.providersReady = false;

    render(<TitleEditor {...baseProps} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("My Page Title");
    // The collaborative editor must NOT mount until the doc is ready.
    expect(screen.queryByTestId("collab-editor")).toBeNull();
  });

  it("renders the collaborative editor once the shared doc is ready", () => {
    editorProvidersValue.ydoc = {}; // truthy shared doc
    editorProvidersValue.providersReady = true;

    render(<TitleEditor {...baseProps} />);

    expect(screen.getByTestId("collab-editor")).toBeDefined();
    // The static fallback <h1> is gone — Yjs is the single source of truth and
    // the prop is never seeded into the collaborative editor.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
