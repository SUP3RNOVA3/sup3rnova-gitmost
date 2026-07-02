import { atomWithWebStorage } from "@/lib/jotai-helper.ts";
import { atom } from "jotai";

// Stable DOM id set on the app-shell navbar (<AppShell.Navbar>). Declared here —
// alongside the sidebar atoms — rather than in the chat window so the AI chat
// window can reference the navbar by id without importing the app shell (which
// would create a shell -> chat-window -> shell import cycle).
export const APP_NAVBAR_ID = "app-shell-navbar";

// Single source of truth for the navbar collapse breakpoint. The AppShell navbar
// `breakpoint` and BOTH burger toggles' `hiddenFrom`/`visibleFrom` MUST use this
// exact value: if they drift, the sidebar becomes unreachable on tablet widths
// (the round-1 regression of #292). Kept here so the shell and the header share
// one constant the compiler enforces, instead of three hand-synced string literals.
export const NAVBAR_COLLAPSE_BREAKPOINT = "md";

export const mobileSidebarAtom = atom<boolean>(false);

export const desktopSidebarAtom = atomWithWebStorage<boolean>(
  "showSidebar",
  true,
);

export const desktopAsideAtom = atom<boolean>(false);

// Valid `tab` values: "" | "comments" | "toc" | "details"
type AsideStateType = {
  tab: string;
  isAsideOpen: boolean;
};

export const asideStateAtom = atom<AsideStateType>({
  tab: "",
  isAsideOpen: false,
});

export const sidebarWidthAtom = atomWithWebStorage<number>('sidebarWidth', 300);