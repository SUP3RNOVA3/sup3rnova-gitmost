import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import * as Y from "yjs";

/**
 * #564 — local-first phase 2 (body-instant), the REAL PageEditor.
 *
 * Everything load-bearing here is production code: the real Y.Doc, the real
 * tiptap collab extensions (ySync/yCursor via @tiptap/extension-collaboration),
 * the real editor-sync-state gates and the real Yjs write guard. Only the two
 * I/O edges are faked, because they are the states we must be able to HOLD:
 *
 *  - `y-indexeddb` — a fake persistence whose "synced" event we fire by hand, so
 *    "the local ydoc is hydrated (with / without content)" is a state we control.
 *  - `@hocuspocus/provider` — a fake provider whose status/sync callbacks we fire
 *    by hand, so "the remote never answers", "the remote drops" and "the remote
 *    syncs" are states we control. WebSocketStatus keeps the real string values.
 *
 * The editability assertions are made at the YJS level, not the UI level: a
 * simulated USER edit (a real `keydown` Enter dispatched on the ProseMirror DOM,
 * the path prosemirror-view gates on `view.editable`) must produce ZERO Y.Doc
 * updates while read-only, and a real update once editing is allowed. The second
 * half is what makes the first non-vacuous: the same simulated edit demonstrably
 * reaches Yjs when the guard opens.
 *
 * ONE more thing is narrowed, and only for a test-infra reason: `mainExtensions`
 * is swapped for a StarterKit-based list (`collabExtensions` — ySync, the caret,
 * intentional-clear — stays REAL, and so does everything PageEditor does with
 * them). Mounting the full docmost extension list under vitest crashes inside
 * prosemirror-view ("Cannot read properties of undefined (reading
 * 'localsInner')"): `@docmost/editor-ext` resolves to SOURCE and is transformed
 * by vite, while `@tiptap/*` is externalized to node, so the two ends up holding
 * two different `prosemirror-view` module instances; decorations built by one
 * fail `instanceof DecorationSet` in the other and `DecorationGroup.from` builds
 * a group with `undefined` members. That is a module-resolution artifact of the
 * test runner, unrelated to #564, and none of the guards under test live in
 * those node extensions.
 */

const hoisted = vi.hoisted(() => ({
  providers: [] as any[],
  persistences: [] as any[],
  localFirst: true,
  idStampAttempts: 0,
}));

vi.mock("@/lib/config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isLocalFirstEnabled: () => hoisted.localFirst,
    getCollaborationUrl: () => "ws://localhost/collab",
  };
});

vi.mock("y-indexeddb", () => {
  class FakeIndexeddbPersistence {
    name: string;
    doc: Y.Doc;
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    destroyed = false;
    clearData = vi.fn(async () => {
      this.destroyed = true;
    });
    constructor(name: string, doc: Y.Doc) {
      this.name = name;
      this.doc = doc;
      hoisted.persistences.push(this);
    }
    on(event: string, cb: (...a: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    off(event: string, cb: (...a: any[]) => void) {
      const list = (this.handlers.get(event) ?? []).filter((h) => h !== cb);
      this.handlers.set(event, list);
    }
    destroy() {
      this.destroyed = true;
    }
    /** test driver: IndexedDB finished loading (with whatever is in the doc) */
    emitSynced() {
      (this.handlers.get("synced") ?? []).forEach((cb) => cb(this));
    }
  }
  return { IndexeddbPersistence: FakeIndexeddbPersistence };
});

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness.js");
  const WebSocketStatus = {
    Connecting: "connecting",
    Connected: "connected",
    Disconnected: "disconnected",
  } as const;

  class HocuspocusProviderWebsocket {
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    constructor(_opts: unknown) {}
  }

  class HocuspocusProvider {
    document: Y.Doc;
    awareness: any;
    configuration: { token?: string };
    attach = vi.fn();
    detach = vi.fn();
    destroy = vi.fn();
    sendStateless = vi.fn();
    listeners = new Map<string, ((...a: any[]) => void)[]>();
    private opts: any;
    constructor(opts: any) {
      this.opts = opts;
      this.document = opts.document;
      this.awareness = new Awareness(opts.document);
      this.configuration = { token: opts.token };
      hoisted.providers.push(this);
    }
    // Real hocuspocus is an EventEmitter and extensions subscribe through it —
    // @tiptap/extension-unique-id does `provider.on("synced", createIds)`.
    on(event: string, cb: (...a: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    off(event: string, cb: (...a: any[]) => void) {
      const list = (this.listeners.get(event) ?? []).filter((h) => h !== cb);
      this.listeners.set(event, list);
    }
    /** test driver: the socket status changed */
    emitStatus(status: string) {
      this.opts.onStatus?.({ status });
    }
    /**
     * test driver: the remote room synced (or un-synced).
     *
     * The ORDER here is the real one and is load-bearing for #564 F3: hocuspocus
     * registers the `onSynced` CONFIGURATION callback as the first "synced"
     * listener, so the page editor's handler runs BEFORE any listener an
     * extension attached later (UniqueID's `createIds`) — all inside this single
     * synchronous emit. If the write guard only opened on a React state update,
     * `createIds` would run while it was still closed.
     */
    emitSynced(state: boolean) {
      this.opts.onSynced?.({ state });
      if (state) {
        [...(this.listeners.get("synced") ?? [])].forEach((cb) => cb());
      }
    }
  }

  return {
    HocuspocusProvider,
    HocuspocusProviderWebsocket,
    WebSocketStatus,
  };
});

// See the header note: only the extension LIST is trimmed; `collabExtensions`
// (and everything page-editor does with it) is the real thing.
//
// One extension is ADDED: `SyncedIdStamper`, a faithful stand-in for
// @tiptap/extension-unique-id — the real one, with a collab provider, does
// `provider.on("synced", createIds)`, and `createIds` synchronously
// `view.dispatch`es the id-assigning transaction and then IMMEDIATELY
// unsubscribes. It gets exactly ONE shot, inside the provider's synced emit
// (#564 F3). The real UniqueID cannot be used here because it is not in the
// trimmed extension list; this reproduces its timing exactly.
vi.mock("@/features/editor/extensions/extensions", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { StarterKit } = await import("@tiptap/starter-kit");
  const { Extension } = await import("@tiptap/core");

  const SyncedIdStamper = (provider: any) =>
    Extension.create({
      name: "testSyncedIdStamper",
      onCreate() {
        const { editor } = this;
        const createIds = () => {
          hoisted.idStampAttempts += 1;
          // The one and only dispatch — a doc change, exactly like assigning
          // `data-id`s to every node that lacks one.
          editor.view.dispatch(editor.state.tr.insertText("[ids]", 1));
          // ...and it unsubscribes right away, precisely like UniqueID.
          provider.off("synced", createIds);
        };
        provider.on("synced", createIds);
      },
    });

  return {
    ...actual,
    mainExtensions: [StarterKit.configure({ undoRedo: false } as never)],
    collabExtensions: (provider: any, user: any) => [
      ...(actual.collabExtensions as any)(provider, user),
      SyncedIdStamper(provider),
    ],
  };
});

// Needs the (untrimmed) SearchAndReplace extension's commands; nothing to do
// with #564.
vi.mock(
  "@/features/editor/components/search-and-replace/search-and-replace-dialog.tsx",
  () => ({ default: () => null }),
);

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useParams: () => ({ pageSlug: "page-slug-1" }) };
});

vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({
    data: { token: "test-token" },
    refetch: vi.fn(async () => ({ data: { token: "test-token" } })),
  }),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import PageEditor from "./page-editor";
import { queryClient } from "@/main.tsx";
import { bodyLocalOnlyAtom } from "@/features/editor/atoms/editor-atoms";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { resetPageYdocRegistryForTests } from "./page-ydoc-eviction";
import type { Editor } from "@tiptap/react";

const PAGE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const STATIC_CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Server seeded copy" }],
    },
  ],
};

/** Write a paragraph of text into the ydoc the way y-prosemirror stores it. */
function seedYdoc(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");
  const paragraph = new Y.XmlElement("paragraph");
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  paragraph.insert(0, [xmlText]);
  fragment.insert(0, [paragraph]);
}

function lastPersistence() {
  return hoisted.persistences[hoisted.persistences.length - 1];
}
function lastProvider() {
  return hoisted.providers[hoisted.providers.length - 1];
}

function wrap(store: ReturnType<typeof createStore>, pageId: string) {
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Provider store={store}>
          <MemoryRouter>
            <PageEditor pageId={pageId} editable content={STATIC_CONTENT} />
          </MemoryRouter>
        </Provider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

function renderEditor(store: ReturnType<typeof createStore>, pageId: string) {
  return render(wrap(store, pageId));
}

/**
 * Simulate a USER edit: a real `keydown` Enter on the ProseMirror DOM. This is
 * the exact path prosemirror-view gates on `view.editable` (edit handlers are not
 * invoked on a non-editable view), and when it IS invoked the base keymap splits
 * the block — a doc change that y-prosemirror writes straight into the Y.Doc.
 */
function simulateUserEdit(editor: Editor): void {
  editor.commands.focus("end");
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function getEditor(store: ReturnType<typeof createStore>): Editor {
  const editor = store.get(pageEditorAtom) as Editor | null;
  if (!editor) throw new Error("editor not published");
  return editor;
}

beforeEach(() => {
  hoisted.providers.length = 0;
  hoisted.persistences.length = 0;
  hoisted.localFirst = true;
  hoisted.idStampAttempts = 0;
  resetPageYdocRegistryForTests();
  localStorage.setItem(
    "currentUser",
    JSON.stringify({
      user: { id: "u-1", name: "Tester", settings: {} },
      workspace: { id: "w-1" },
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("#564 body-instant: live body from the local ydoc, read-only until remote", () => {
  it("renders the body live from a NON-EMPTY local ydoc with no remote connection, read-only", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    // The remote provider is never told to connect/sync in this test.
    act(() => persistence.emitSynced());

    // Body swapped to the LIVE editor and shows the local ydoc's content.
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Local body text");
    });

    const editor = getEditor(store);
    // Read-only at the ProseMirror level...
    expect(editor.isEditable).toBe(false);
    expect(editor.view.editable).toBe(false);

    // ...AND at the Yjs level: a real user edit produces no Y.Doc update.
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).not.toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(1);

    // And the Yjs gate is not merely `view.editable`: a doc-changing transaction
    // that bypasses ProseMirror's input handling entirely (a programmatic tiptap
    // command — the shape a plugin's appendTransaction or a stray code path
    // takes) is rejected by the write guard's filterTransaction, so nothing is
    // written into the Y.Doc that could be pushed to the server on connect.
    act(() => {
      editor.commands.insertContent("<p>sneaky programmatic write</p>");
    });
    expect(updates).not.toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(1);
    expect(persistence.doc.getXmlFragment("default").toString()).not.toContain(
      "sneaky",
    );

    // The quiet "connecting" badge is shown (never an alarming offline banner)
    // and the page-wide offline state is NOT published.
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
  });

  it("becomes editable — and edits reach the ydoc — only once the remote syncs", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    expect(getEditor(store).isEditable).toBe(false);

    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });

    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    // Non-vacuity of the read-only assertion above: the SAME simulated edit now
    // mutates the Y.Doc, so "no update while read-only" was a real gate, not an
    // inert edit path.
    const editor = getEditor(store);
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).toHaveBeenCalled();
    expect(persistence.doc.getXmlFragment("default").length).toBe(2);

    // Nothing left to warn about.
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
  });

  it("a UniqueID-style provider.on('synced') dispatch lands (rejected before sync, passes in the emit)", async () => {
    // #564 F3. @tiptap/extension-unique-id assigns every node its `data-id` from
    // a `provider.on("synced")` callback that dispatches ONCE and unsubscribes
    // immediately. That callback runs INSIDE the same synchronous emit as the
    // page editor's own onSynced handler — so if the Yjs write guard only opened
    // on a React state update (which lands a re-render later), the id transaction
    // would be REJECTED and the extension would already be gone: every node would
    // stay without a `data-id` for the life of the editor, silently breaking
    // comment anchors, transclusions and the TOC. The guard must therefore open
    // SYNCHRONOUSLY inside onSynced.
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });

    const editor = getEditor(store);
    // The stamper has subscribed but not fired: nothing is stamped yet, and a
    // dispatch in this window is still rejected (the read-only guarantee holds).
    expect(hoisted.idStampAttempts).toBe(0);
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("[ids]", 1));
    });
    expect(editor.state.doc.textContent).not.toContain("[ids]");

    // The synced emit: page-editor's onSynced runs first, then the stamper's
    // callback — all synchronously, in this one emit.
    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });

    // It fired exactly once (it unsubscribed) — and its transaction SURVIVED.
    expect(hoisted.idStampAttempts).toBe(1);
    await waitFor(() => {
      expect(getEditor(store).state.doc.textContent).toContain("[ids]");
    });
    // ...and it really reached the ydoc, not just the ProseMirror doc.
    expect(persistence.doc.getXmlFragment("default").toString()).toContain(
      "[ids]",
    );
  });

  it("keeps the static copy when the local ydoc is EMPTY (guard 1: no blank body)", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence(); // nothing seeded: first visit
    act(() => persistence.emitSynced());

    // No swap: the server-seeded static copy stays until the remote answers.
    await waitFor(() => {
      expect(container.textContent).toContain("Server seeded copy");
    });
    expect(container.querySelector(".editor-container")).toBeNull();

    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
  });

  it("a FAILED remote connection leaves a read-only body + the page-wide offline banner", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });

    // The socket gives up (this is also what the 7500ms timeout does).
    const provider = lastProvider();
    act(() => provider.emitStatus("disconnected"));

    const editor = getEditor(store);
    await waitFor(() => expect(editor.isEditable).toBe(false));

    // No stale-doc editing: still zero Yjs writes.
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).not.toHaveBeenCalled();

    // The user is told, page-wide (chrome included, via FullEditor).
    await waitFor(() =>
      expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(true),
    );
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
  });

  it("a remote that syncs and then DROPS keeps the body editable (no regression)", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    act(() => {
      provider.emitStatus("disconnected");
      provider.emitSynced(false);
    });

    // Remote confirmation is sticky: the doc HAS reconciled with the server, so
    // offline editing stays allowed exactly as today.
    expect(getEditor(store).isEditable).toBe(true);
    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).toBeNull();
  });

  it("a page switch mid local-only never binds the previous page's ydoc", async () => {
    const store = createStore();
    const { container, rerender } = renderEditor(store, PAGE_A);

    const persistenceA = lastPersistence();
    seedYdoc(persistenceA.doc, "PAGE A LOCAL BODY");
    act(() => persistenceA.emitSynced());
    await waitFor(() => {
      expect(container.textContent).toContain("PAGE A LOCAL BODY");
    });

    // Navigate to page B WITHOUT remounting (no `key`), mid local-only window.
    await act(async () => {
      rerender(wrap(store, PAGE_B));
    });

    // Page A's providers are gone, page B has its own (empty) ydoc.
    expect(persistenceA.destroyed).toBe(true);
    const persistenceB = lastPersistence();
    expect(persistenceB).not.toBe(persistenceA);
    expect(persistenceB.name).toBe(`page.${PAGE_B}`);

    // The sync state did NOT carry over: page B is back on the static copy and
    // page A's body is nowhere on screen.
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(container.textContent).toContain("Server seeded copy");

    // A late "synced" from page A's destroyed persistence must not swap page B.
    act(() => persistenceA.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();

    // Page B's own local sync (empty doc) still doesn't swap; its remote does,
    // and the editor is then bound to page B's ydoc.
    act(() => persistenceB.emitSynced());
    expect(container.querySelector(".editor-container")).toBeNull();
    const providerB = lastProvider();
    expect(providerB.document).toBe(persistenceB.doc);
    act(() => {
      providerB.emitStatus("connected");
      providerB.emitSynced(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    expect(container.textContent).not.toContain("PAGE A LOCAL BODY");
  });
});

describe("#564 flag OFF: behavior identical to today", () => {
  beforeEach(() => {
    hoisted.localFirst = false;
  });

  it("does NOT swap early even with a non-empty local ydoc; swaps + edits on remote sync", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());

    // Today's rule: the network still gates the body.
    await waitFor(() => {
      expect(container.textContent).toContain("Server seeded copy");
    });
    expect(container.querySelector(".editor-container")).toBeNull();
    expect(getEditor(store).isEditable).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();

    const provider = lastProvider();
    act(() => {
      provider.emitStatus("connected");
      provider.emitSynced(true);
    });

    await waitFor(() => {
      expect(container.querySelector(".editor-container")).not.toBeNull();
    });
    await waitFor(() => expect(getEditor(store).isEditable).toBe(true));

    const editor = getEditor(store);
    const updates = vi.fn();
    persistence.doc.on("update", updates);
    act(() => simulateUserEdit(editor));
    expect(updates).toHaveBeenCalled();
  });

  it("shows no offline banner while disconnected in the static window (today's badge only)", async () => {
    const store = createStore();
    const { container } = renderEditor(store, PAGE_A);

    const persistence = lastPersistence();
    seedYdoc(persistence.doc, "Local body text");
    act(() => persistence.emitSynced());
    act(() => lastProvider().emitStatus("disconnected"));

    expect(store.get(bodyLocalOnlyAtom).isOffline).toBe(false);
    expect(
      container.querySelector('[data-testid="body-connecting-badge"]'),
    ).not.toBeNull();
    expect(container.querySelector(".editor-container")).toBeNull();
  });
});
