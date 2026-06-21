import { useEffect, useRef, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  onStatusParameters,
  WebSocketStatus,
  HocuspocusProviderWebsocket,
  onSyncedParameters,
  onStatelessParameters,
} from "@hocuspocus/provider";
import { useAtom, useSetAtom } from "jotai";
import useCollaborationUrl from "@/features/editor/hooks/use-collaboration-url";
import {
  isLocalSyncedAtom,
  isRemoteSyncedAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { useDocumentVisibility } from "@mantine/hooks";
import { useIdle } from "@/hooks/use-idle.ts";
import { queryClient } from "@/main.tsx";
import { IPage } from "@/features/page/types/page.types.ts";
import { useParams } from "react-router-dom";
import { extractPageSlugId } from "@/lib";
import { FIVE_MINUTES } from "@/lib/constants.ts";
import { jwtDecode } from "jwt-decode";

export interface PageCollabProviders {
  ydoc: Y.Doc | null;
  remote: HocuspocusProvider | null;
  socket: HocuspocusProviderWebsocket | null;
  providersReady: boolean;
  isLocalSynced: boolean;
  isRemoteSynced: boolean;
}

/**
 * Owns the full collaboration provider lifecycle for a page so that the title
 * and body editors can share a single Y.Doc + HocuspocusProvider. The behavior
 * is relocated verbatim from page-editor.tsx: it creates the providers once per
 * pageId, connects/disconnects on idle/visibility, attaches each render,
 * destroys on unmount, refreshes the collab token on auth failure, and applies
 * the onStateless 'page.updated' cache update.
 */
export function usePageCollabProviders(pageId: string): PageCollabProviders {
  const collaborationURL = useCollaborationUrl();
  const [isLocalSynced, setIsLocalSynced] = useState(false);
  const [isRemoteSynced, setIsRemoteSynced] = useState(false);
  const [yjsConnectionStatus, setYjsConnectionStatus] = useAtom(
    yjsConnectionStatusAtom,
  );
  const setIsLocalSyncedAtom = useSetAtom(isLocalSyncedAtom);
  const setIsRemoteSyncedAtom = useSetAtom(isRemoteSyncedAtom);
  const { data: collabQuery, refetch: refetchCollabToken } = useCollabToken();
  const { isIdle, resetIdle } = useIdle(FIVE_MINUTES, { initialState: false });
  const documentState = useDocumentVisibility();
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);

  // Providers only created once per pageId
  const providersRef = useRef<{
    ydoc: Y.Doc;
    local: IndexeddbPersistence;
    remote: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
  } | null>(null);
  const [providersReady, setProvidersReady] = useState(false);

  // Mirror the local/remote sync flags into shared atoms so the header
  // indicator can read them, and keep the local component state in sync too.
  const setLocalSynced = (value: boolean) => {
    setIsLocalSynced(value);
    setIsLocalSyncedAtom(value);
  };
  const setRemoteSynced = (value: boolean) => {
    setIsRemoteSynced(value);
    setIsRemoteSyncedAtom(value);
  };

  useEffect(() => {
    if (!providersRef.current) {
      const documentName = `page.${pageId}`;
      const ydoc = new Y.Doc();
      const local = new IndexeddbPersistence(documentName, ydoc);
      const socket = new HocuspocusProviderWebsocket({
        url: collaborationURL,
      });
      const onLocalSyncedHandler = () => {
        setLocalSynced(true);
      };
      const onStatusHandler = (event: onStatusParameters) => {
        setYjsConnectionStatus(event.status);
      };
      const onSyncedHandler = (event: onSyncedParameters) => {
        setRemoteSynced(event.state);
      };
      const onStatelessHandler = ({ payload }: onStatelessParameters) => {
        try {
          const message = JSON.parse(payload);
          if (message?.type !== "page.updated" || !message.updatedAt) return;
          const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);
          if (pageData) {
            queryClient.setQueryData(["pages", slugId], {
              ...pageData,
              updatedAt: message.updatedAt,
              ...(message.lastUpdatedBy && {
                lastUpdatedBy: message.lastUpdatedBy,
              }),
            });
          }
        } catch {
          // ignore unrelated stateless messages
        }
      };
      const onAuthenticationFailedHandler = () => {
        const payload = jwtDecode(collabQuery?.token);
        const now = Date.now().valueOf() / 1000;
        const isTokenExpired = now >= payload.exp;
        if (isTokenExpired) {
          refetchCollabToken().then((result) => {
            if (result.data?.token) {
              socket.disconnect();
              setTimeout(() => {
                remote.configuration.token = result.data.token;
                socket.connect();
              }, 100);
            }
          });
        }
      };
      const remote = new HocuspocusProvider({
        websocketProvider: socket,
        name: documentName,
        document: ydoc,
        token: collabQuery?.token,
        onAuthenticationFailed: onAuthenticationFailedHandler,
        onStatus: onStatusHandler,
        onSynced: onSyncedHandler,
        onStateless: onStatelessHandler,
      });

      local.on("synced", onLocalSyncedHandler);
      providersRef.current = { ydoc, socket, local, remote };
      setProvidersReady(true);
    } else {
      setProvidersReady(true);
    }
    // Only destroy on final unmount
    return () => {
      providersRef.current?.socket.destroy();
      providersRef.current?.remote.destroy();
      providersRef.current?.local.destroy();
      providersRef.current = null;
      // Reset shared sync state on page change/unmount.
      setLocalSynced(false);
      setRemoteSynced(false);
    };
  }, [pageId]);

  // Only connect/disconnect on tab/idle, not destroy
  useEffect(() => {
    if (!providersReady || !providersRef.current) return;
    const socket = providersRef.current.socket;

    if (
      isIdle &&
      documentState === "hidden" &&
      yjsConnectionStatus === WebSocketStatus.Connected
    ) {
      socket.disconnect();
      return;
    }
    if (
      documentState === "visible" &&
      yjsConnectionStatus === WebSocketStatus.Disconnected
    ) {
      resetIdle();
      socket.connect();
    }
  }, [isIdle, documentState, providersReady, resetIdle]);

  // Attach here, to make sure the connection gets properly established
  providersRef.current?.remote.attach();

  return {
    ydoc: providersRef.current?.ydoc ?? null,
    remote: providersRef.current?.remote ?? null,
    socket: providersRef.current?.socket ?? null,
    providersReady,
    isLocalSynced,
    isRemoteSynced,
  };
}
