import "@/features/editor/styles/index.css";
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extension-placeholder";
import { useAtomValue } from "jotai";
import {
  currentPageEditModeAtom,
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import { updatePageData } from "@/features/page/queries/page-query";
import { useDebouncedCallback, getHotkeyHandler } from "@mantine/hooks";
import { useAtom } from "jotai";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import {
  Collaboration,
  isChangeOrigin,
} from "@tiptap/extension-collaboration";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import EmojiCommand from "@/features/editor/extensions/emoji-command.ts";
import { UpdateEvent } from "@/features/websocket/types";
import localEmitter from "@/lib/local-emitter.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { searchSpotlight } from "@/features/search/constants.ts";
import { platformModifierKey } from "@/lib";
import { useTitleAutofocus } from "@/features/editor/hooks/use-title-autofocus";
import { useEditorProviders } from "@/features/editor/contexts/editor-providers-context";
import { queryClient } from "@/main.tsx";
import { IPage } from "@/features/page/types/page.types.ts";

export interface TitleEditorProps {
  pageId: string;
  slugId: string;
  title: string;
  spaceSlug: string;
  editable: boolean;
}

export function TitleEditor({
  pageId,
  slugId,
  title,
  spaceSlug,
  editable,
}: TitleEditorProps) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const [, setTitleEditor] = useAtom(titleEditorAtom);
  const emit = useQueryEmit();
  const navigate = useNavigate();
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);

  // Shared Y.Doc (title lives in its own 'title' fragment of the same doc as
  // the body). Yjs is the source of truth for the title content.
  const editorProviders = useEditorProviders();
  const ydoc = editorProviders?.ydoc ?? null;
  const providersReady = editorProviders?.providersReady ?? false;

  // Until the shared doc is ready, the collaborative editor binds nothing and
  // would render an empty heading until the Yjs 'title' fragment hydrates. Show
  // a non-editable static <h1> with the `title` prop in the meantime. The prop
  // is NEVER fed into the collaborative editor (Yjs stays the single source of
  // truth — seeding it would duplicate the title).
  const titleReady = providersReady && !!ydoc;

  const titleEditor = useEditor(
    {
      extensions: [
        Document.extend({
          content: "heading",
        }),
        Heading.configure({
          levels: [1],
        }),
        Text,
        Placeholder.configure({
          placeholder: t("Untitled"),
          showOnlyWhenEditable: false,
        }),
        // Bind the title to the dedicated 'title' fragment of the shared doc.
        // Collaboration also manages undo/redo, so the History extension is
        // intentionally omitted (it would conflict with Yjs). When the doc is
        // not ready yet the editor renders empty until the doc arrives.
        ...(ydoc
          ? [Collaboration.configure({ document: ydoc, field: "title" })]
          : []),
        EmojiCommand,
      ],
      onCreate({ editor }) {
        if (editor) {
          // @ts-ignore
          setTitleEditor(editor);
        }
      },
      onUpdate({ editor, transaction }) {
        // Drive URL + tree propagation only on genuine local edits; skip
        // remote/collab-origin Yjs updates to avoid feedback loops.
        if (transaction && isChangeOrigin(transaction)) return;
        debouncedPropagateTitle(editor.getText());
      },
      editable: editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          "aria-label": t("Page title"),
        },
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (platformModifierKey(event) && event.code === "KeyS") {
              event.preventDefault();
              return true;
            }
            if (platformModifierKey(event) && event.code === "KeyK") {
              searchSpotlight.open();
              return true;
            }
          },
        },
      },
    },
    [pageId, ydoc],
  );

  useEffect(() => {
    const anchorId = window.location.hash
      ? window.location.hash.substring(1)
      : undefined;
    const pageSlug = buildPageUrl(spaceSlug, slugId, title, anchorId);
    navigate(pageSlug, { replace: true });
  }, [title]);

  // On a local title change: update the URL slug and propagate the change to
  // the live tree/breadcrumbs for online users. No REST round-trip — the title
  // itself is persisted through Yjs. Offline this simply no-ops the socket
  // emit and the title syncs on reconnect.
  const debouncedPropagateTitle = useDebouncedCallback((titleText: string) => {
    const anchorId = window.location.hash
      ? window.location.hash.substring(1)
      : undefined;
    navigate(buildPageUrl(spaceSlug, slugId, titleText, anchorId), {
      replace: true,
    });

    const page =
      queryClient.getQueryData<IPage>(["pages", slugId]) ??
      queryClient.getQueryData<IPage>(["pages", pageId]);
    if (!page) return;

    const updatedPage: IPage = { ...page, title: titleText };

    const event: UpdateEvent = {
      operation: "updateOne",
      spaceId: page.spaceId,
      entity: ["pages"],
      id: page.id,
      payload: {
        title: titleText,
        slugId: page.slugId,
        parentPageId: page.parentPageId,
        icon: page.icon,
      },
    };

    updatePageData(updatedPage);
    localEmitter.emit("message", event);
    emit(event);
  }, 500);

  useTitleAutofocus(titleEditor, pageId);

  useEffect(() => {
    if (!titleEditor) return;
    titleEditor.setEditable(editable && currentPageEditMode === PageEditMode.Edit);
  }, [currentPageEditMode, titleEditor, editable]);

  const openSearchDialog = () => {
    const event = new CustomEvent("openFindDialogFromEditor", {});
    document.dispatchEvent(event);
  };

  function handleTitleKeyDown(event: any) {
    if (!titleEditor || !pageEditor || event.shiftKey) return;

    // Prevent focus shift when IME composition is active
    // `keyCode === 229` is added to support Safari where `isComposing` may not be reliable
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;

    const { key } = event;
    const { $head } = titleEditor.state.selection;

    if (key === "Enter") {
      event.preventDefault();

      const { $from } = titleEditor.state.selection;
      const titleText = titleEditor.getText();

      // Get the text offset within the heading node (not document position)
      const textOffset = $from.parentOffset;

      const textAfterCursor = titleText.slice(textOffset);

      // Delete text after cursor from title (this will be in undo history)
      const endPos = titleEditor.state.doc.content.size;
      if (textAfterCursor) {
        titleEditor.commands.deleteRange({ from: $from.pos, to: endPos });
      }

      // Don't add to history so undo in page editor won't remove this split
      pageEditor
        .chain()
        .command(({ tr }) => {
          tr.setMeta("addToHistory", false);
          return true;
        })
        .insertContentAt(0, {
          type: "paragraph",
          content: textAfterCursor
            ? [{ type: "text", text: textAfterCursor }]
            : undefined,
        })
        .focus("start")
        .run();
      return;
    }

    const shouldFocusEditor =
      key === "ArrowDown" || (key === "ArrowRight" && !$head.nodeAfter);

    if (shouldFocusEditor) {
      pageEditor.commands.focus("start");
    }
  }

  return (
    <div className="page-title">
      {titleReady ? (
        <EditorContent
          editor={titleEditor}
          onKeyDown={(event) => {
            // First handle the search hotkey
            getHotkeyHandler([["mod+F", openSearchDialog]])(event);

            // Then handle other key events
            handleTitleKeyDown(event);
          }}
        />
      ) : (
        // Static, non-editable fallback so the title is visible before Yjs
        // hydrates the 'title' fragment. Not wired into the collaborative editor.
        <h1>{title}</h1>
      )}
    </div>
  );
}
