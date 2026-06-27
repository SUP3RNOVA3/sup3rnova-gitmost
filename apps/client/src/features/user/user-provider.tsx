import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import React, { useEffect } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useTranslation } from "react-i18next";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { io } from "socket.io-client";
import { SOCKET_URL } from "@/features/websocket/types";
import { useQuerySubscription } from "@/features/websocket/use-query-subscription.ts";
import { useTreeSocket } from "@/features/websocket/use-tree-socket.ts";
import { useNotificationSocket } from "@/features/notification/hooks/use-notification-socket.ts";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { OfflineFallback } from "@/features/offline/offline-fallback.tsx";
import { queryClient } from "@/main.tsx";
import { makeConnectHandler } from "@/features/user/connect-resync.ts";

export function UserProvider({ children }: React.PropsWithChildren) {
  const [, setCurrentUser] = useAtom(currentUserAtom);
  const { data, isLoading, error, isError } = useCurrentUser();
  const { i18n } = useTranslation();
  const [, setSocket] = useAtom(socketAtom);
  // fetch collab token on load
  const { data: collab } = useCollabToken();

  useEffect(() => {
    if (isLoading || isError) {
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ["websocket"],
      withCredentials: true,
    });

    // @ts-ignore
    setSocket(newSocket);

    // Distinguish the first connect from a reconnect so we only resync after a
    // gap. The handler owns the first-connect-vs-reconnect decision through a
    // private closure flag (see makeConnectHandler): on RECONNECT it refetches
    // the sidebar tree through the authorized API so the view re-converges after
    // a gap where ws events were missed (wifi blip, laptop sleep), invalidating
    // both the root level and the nested-page levels of every space tree.
    const handleConnect = makeConnectHandler(queryClient);
    newSocket.on("connect", () => {
      console.log("ws connected");
      handleConnect();
    });

    return () => {
      console.log("ws disconnected");
      newSocket.disconnect();
    };
  }, [isError, isLoading]);

  useQuerySubscription();
  useTreeSocket();
  useNotificationSocket();

  useEffect(() => {
    if (data && data.user && data.workspace) {
      setCurrentUser(data);
      i18n.changeLanguage(
        data.user.locale === "en" ? "en-US" : data.user.locale,
      );
    }
  }, [data, isLoading]);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage || i18n.language || "en-US";
  }, [i18n.language, i18n.resolvedLanguage]);

  // First load with no cached user yet: render nothing briefly while the
  // persisted ['currentUser'] cache hydrates (avoids flashing the offline
  // fallback before restore). Once we have a user we render the app even if a
  // refetch is still in flight.
  if (isLoading && !data) return <></>;

  if (isError && error?.["response"]?.status === 404) {
    return <Error404 />;
  }

  // We have a (possibly cached/stale) user — render the app. Offline, the
  // POST /api/users/me refetch fails as a network error, but the persisted/
  // hydrated user is enough to render the cached UI. Previously `if (error)
  // return <></>` blanked every authenticated route on an offline reload even
  // though the cached data was present (#237/#238).
  if (data) {
    return <>{children}</>;
  }

  // No user AND an error (offline cold boot of a page never warmed for offline,
  // or no persisted cache to restore): show an explicit offline fallback rather
  // than a blank white screen.
  if (error) {
    return <OfflineFallback />;
  }

  return <>{children}</>;
}
