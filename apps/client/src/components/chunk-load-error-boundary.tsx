import { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Button, Center, Stack, Text } from "@mantine/core";

// sessionStorage key holding the epoch-ms timestamp of the last automatic reload.
const RELOAD_AT_KEY = "chunk-reload-at";
// Allow at most one automatic reload per this window. A stale-deploy 404 is cured
// by a single reload, so anything inside the window is treated as a reload loop
// (permanently-broken chunk) and falls through to the manual UI. A window (rather
// than a one-shot flag) lets a SECOND deploy in the same tab's lifetime recover too.
const RELOAD_WINDOW_MS = 5 * 60 * 1000;

// Pure window decision, unit-tested in isolation: auto-reload only if we have never
// auto-reloaded (lastReloadAt null/NaN) or the last one was strictly older than the
// window. Anything inside the window is suppressed to break an infinite reload loop.
export function shouldAutoReload(
  now: number,
  lastReloadAt: number | null,
  windowMs: number,
): boolean {
  if (lastReloadAt === null || Number.isNaN(lastReloadAt)) return true;
  return now - lastReloadAt > windowMs;
}

// Heuristic detection of a failed dynamic import. Since the code-splitting work,
// every route (plus Aside / AiChatWindow) is React.lazy: when a new deploy
// replaces the hashed chunks, a tab left open on the old index.html requests a
// chunk URL that now 404s, and React.lazy rejects. Browsers / Vite surface these
// with a ChunkLoadError name or one of these messages.
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = (error as { message?: string }).message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

function handleError(error: unknown) {
  if (!isChunkLoadError(error)) return;
  // A stale-chunk 404 is cured by a full reload that re-fetches index.html and
  // the new chunk manifest. Auto-reload at most once per RELOAD_WINDOW_MS: this
  // recovers across multiple deploys in a single tab's lifetime, yet a
  // permanently-broken lazy chunk (which would loop) is stopped after the first
  // reload and falls through to the manual recovery UI below.
  try {
    const raw = sessionStorage.getItem(RELOAD_AT_KEY);
    const lastReloadAt = raw === null ? null : Number.parseInt(raw, 10);
    const now = Date.now();
    if (!shouldAutoReload(now, lastReloadAt, RELOAD_WINDOW_MS)) return;
    sessionStorage.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    // sessionStorage unavailable (private mode / disabled): skip the automatic
    // reload rather than risk an unguarded loop; the fallback UI still recovers.
    return;
  }
  window.location.reload();
}

// Root-level boundary that sits ABOVE every route-level Suspense boundary so a
// lazy route/component chunk failure is caught here instead of unmounting the
// whole tree into a blank white screen. Per-feature ErrorBoundaries (page.tsx,
// transclusion, page-embed) remain in place underneath for their local errors.
export function ChunkLoadErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={handleError}
      fallbackRender={({ error }) => {
        const chunk = isChunkLoadError(error);
        return (
          <Center h="100vh" p="md">
            <Stack align="center" gap="sm" maw={420}>
              <Text fw={600}>
                {chunk ? "A new version is available" : "Something went wrong"}
              </Text>
              <Text size="sm" c="dimmed" ta="center">
                {chunk
                  ? "Please reload the page to load the latest version."
                  : "An unexpected error occurred. Reloading the page may help."}
              </Text>
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </Stack>
          </Center>
        );
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
