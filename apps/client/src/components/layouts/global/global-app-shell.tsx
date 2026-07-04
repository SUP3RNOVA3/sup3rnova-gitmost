import { AppShell, Container } from "@mantine/core";
import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SettingsSidebar from "@/components/settings/settings-sidebar.tsx";
import { useAtom } from "jotai";
import {
  APP_NAVBAR_ID,
  NAVBAR_COLLAPSE_BREAKPOINT,
  asideStateAtom,
  desktopSidebarAtom,
  mobileSidebarAtom,
  sidebarWidthAtom,
} from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { SpaceSidebar } from "@/features/space/components/sidebar/space-sidebar.tsx";
import { AppHeader } from "@/components/layouts/global/app-header.tsx";
import Aside from "@/components/layouts/global/aside.tsx";
import AiChatWindow from "@/features/ai-chat/components/ai-chat-window.tsx";
import GitmostGlobalBridge from "@/features/editor/gitmost/gitmost-global-bridge.tsx";
import classes from "./app-shell.module.css";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";
import GlobalSidebar from "@/components/layouts/global/global-sidebar.tsx";
import { ASIDE_PANEL_ID } from "@/hooks/use-toggle-aside.tsx";
import { MAIN_CONTENT_ID, SkipToMain } from "@/components/ui/skip-to-main.tsx";

export default function GlobalAppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [mobileOpened] = useAtom(mobileSidebarAtom);
  const toggleMobile = useToggleSidebar(mobileSidebarAtom);
  const [desktopOpened] = useAtom(desktopSidebarAtom);
  const [{ isAsideOpen, tab: asideTab }] = useAtom(asideStateAtom);
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef(null);

  const startResizing = React.useCallback((mouseDownEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = React.useCallback(
    (mouseMoveEvent) => {
      if (isResizing) {
        const newWidth =
          mouseMoveEvent.clientX -
          sidebarRef.current.getBoundingClientRect().left;
        if (newWidth < 220) {
          setSidebarWidth(220);
          return;
        }
        if (newWidth > 600) {
          setSidebarWidth(600);
          return;
        }
        setSidebarWidth(newWidth);
      }
    },
    [isResizing],
  );

  useEffect(() => {
    // Attach the global mousemove/mouseup only WHILE resizing (started on the
    // handle's mousedown via startResizing → isResizing=true) and detach on
    // mouseup (stopResizing → isResizing=false). Previously these listeners were
    // attached for the whole app lifetime, so every mouse move over the app ran
    // the resize handler.
    // https://codesandbox.io/p/sandbox/kz9de
    if (!isResizing) return;
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  const location = useLocation();
  const isSettingsRoute = location.pathname.startsWith("/settings");
  const isSpaceRoute = location.pathname.startsWith("/s/");
  const isPageRoute = location.pathname.includes("/p/");
  const showGlobalSidebar = !isSpaceRoute && !isSettingsRoute;

  return (
    <>
      <SkipToMain />
      <AppShell
      header={{ height: 45 }}
      navbar={{
        width: isSpaceRoute ? sidebarWidth : 300,
        // `md` (not `sm`): below 992px the fixed ~300px sidebar leaves too little
        // room for content — the settings tables (Members/…) overflow the offset
        // content area on tablet (~768px) and clip the Role/actions columns
        // off-screen with no horizontal scroll. Collapsing the navbar to a toggle
        // drawer across the whole tablet band frees the full width for content
        // (the mobile drawer is closed by default, so nothing overlaps on load).
        breakpoint: NAVBAR_COLLAPSE_BREAKPOINT,
        collapsed: {
          mobile: !mobileOpened,
          desktop: !desktopOpened,
        },
      }}
      aside={
        isPageRoute && {
          width: 420,
          breakpoint: "md",
          collapsed: { mobile: !isAsideOpen, desktop: !isAsideOpen },
        }
      }
      padding={{ base: "xs", sm: "md" }}
    >
      <AppShell.Header px="md" className={classes.header}>
        <AppHeader />
      </AppShell.Header>
      <AppShell.Navbar
        id={APP_NAVBAR_ID}
        className={classes.navbar}
        withBorder={false}
        ref={sidebarRef}
        aria-label={
          isSpaceRoute
            ? t("Space navigation")
            : isSettingsRoute
              ? t("Settings navigation")
              : t("Main navigation")
        }
      >
        {isSpaceRoute && (
          <div className={classes.resizeHandle} onMouseDown={startResizing} />
        )}
        {isSpaceRoute && <SpaceSidebar />}
        {isSettingsRoute && <SettingsSidebar />}
        {showGlobalSidebar && <GlobalSidebar />}
      </AppShell.Navbar>
      <AppShell.Main id={MAIN_CONTENT_ID} tabIndex={-1}>
        {isSettingsRoute ? (
          <Container size={900} pb={80}>
            {children}
          </Container>
        ) : (
          children
        )}
      </AppShell.Main>

      {isPageRoute && (
        <AppShell.Aside
          id={ASIDE_PANEL_ID}
          tabIndex={-1}
          className={classes.aside}
          p="sm"
          withBorder={false}
          aria-label={
            asideTab === "comments"
              ? t("Comments")
              : asideTab === "toc"
                ? t("Table of contents")
                : asideTab === "details"
                  ? t("Details")
                  : undefined
          }
        >
          <Aside />
        </AppShell.Aside>
      )}
    </AppShell>
    {/* Floating AI chat window. Mounted once globally; it is position: fixed
        and self-hides when closed, so its place in the tree is not critical. */}
    <AiChatWindow />
      {/* Global gitmost native bridge: registers listSpaces / listPages /
          createPageWithRecording on window.gitmost so the native host can
          create a page with a recording even when no page editor is open. */}
      <GitmostGlobalBridge />
    </>
  );
}
