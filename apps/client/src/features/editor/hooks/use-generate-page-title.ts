import { useMutation } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { htmlToMarkdown } from "@docmost/editor-ext";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";
import {
  updatePageData,
  useUpdateTitlePageMutation,
} from "@/features/page/queries/page-query.ts";
import { generatePageTitle } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import { UpdateEvent } from "@/features/websocket/types";
import localEmitter from "@/lib/local-emitter.ts";

// Maximum length we send to the model. The server truncates again; this is a
// cheap client-side bound so we never ship a huge body over the wire.
const MAX_CONTENT_CHARS = 20000;

/**
 * Generate a title for the given page from the LIVE editor content (#199),
 * including unsaved edits, then apply it IMMEDIATELY (per product decision). The
 * server endpoint only summarizes the supplied markdown — it never writes the
 * page; the actual title write goes through the existing /pages/update mutation
 * (which enforces edit permission), and is mirrored to the title field + other
 * clients exactly like TitleEditor.saveTitle. Returns a mutation-like API so the
 * button can show a loading state via `isPending`.
 */
export function useGeneratePageTitle(pageId: string) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const { mutateAsync: updateTitle } = useUpdateTitlePageMutation();
  const emit = useQueryEmit();

  return useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!pageEditor || pageEditor.isDestroyed) return;

      const markdown = htmlToMarkdown(pageEditor.getHTML()).trim();
      if (!markdown) {
        notifications.show({ message: t("The note is empty"), color: "yellow" });
        return;
      }

      const title = (
        await generatePageTitle(markdown.slice(0, MAX_CONTENT_CHARS))
      ).trim();
      if (!title) {
        // The model returned nothing usable — keep the existing title untouched.
        notifications.show({
          message: t("Could not generate a title"),
          color: "yellow",
        });
        return;
      }

      const page = await updateTitle({ pageId, title }); // POST /pages/update
      updatePageData(page); // refresh the react-query cache

      // Do NOT write the title into the editor here. The title editor is bound to
      // the Yjs `title` fragment and Yjs is the source of truth. The server REST
      // /pages/update reseeds that fragment (writePageTitle → writeTitleFragment,
      // a full clear+replace) and the reseed reaches the bound title editor on
      // its own as a remote provider update. The old REST-era setContent here
      // would race that reseed and double/garble the title (the "Yjs duplication
      // trap"), so it is intentionally omitted. The DB write above is keyed by
      // the captured `pageId`, so it stays correct even if the user navigated
      // away during generation.

      // Broadcast to other clients, mirroring TitleEditor.saveTitle's event shape.
      const event: UpdateEvent = {
        operation: "updateOne",
        spaceId: page.spaceId,
        entity: ["pages"],
        id: page.id,
        payload: {
          title: page.title,
          slugId: page.slugId,
          parentPageId: page.parentPageId,
          icon: page.icon,
        },
      };
      localEmitter.emit("message", event);
      emit(event);

      notifications.show({ message: t("Title generated") });
    },
    onError: (err) => {
      // Map known HTTP statuses to friendly messages, falling back to generic.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      const message =
        status === 403
          ? t("AI title generation is disabled")
          : status === 503
            ? t("AI is not configured")
            : status === 429
              ? t("Too many requests, please try again later")
              : t("Failed to generate title");
      notifications.show({ message, color: "red" });
    },
  });
}
