import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import '@mantine/dates/styles.css';
import "@/styles/a11y-overrides.css";

import { ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { mantineCssResolver, theme } from "@/theme";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import { ChunkLoadErrorBoundary } from "@/components/chunk-load-error-boundary.tsx";
import "./i18n";
import {
  getPostHogHost,
  getPostHogKey,
  isCloud,
  isPostHogEnabled,
} from "@/lib/config.ts";
import { initVitals } from "@/lib/telemetry/vitals";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

// #355 — client perf-telemetry. Decides sampling ONCE (25%/session) before
// subscribing to any observer; non-sampled sessions send nothing.
initVitals();

const container = document.getElementById("root") as HTMLElement;
const root = (container as any).__reactRoot ??= ReactDOM.createRoot(container);

function renderApp(app: ReactNode) {
  root.render(
    <BrowserRouter>
      <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
        <ModalsProvider>
          <QueryClientProvider client={queryClient}>
            <Notifications position="bottom-center" limit={3} zIndex={10000} />
            <HelmetProvider>
              {/* Root boundary above every lazy route's Suspense: a stale-chunk
                  404 after a deploy is caught and recovered here instead of
                  blanking the whole app. */}
              <ChunkLoadErrorBoundary>{app}</ChunkLoadErrorBoundary>
            </HelmetProvider>
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </BrowserRouter>,
  );
}

async function initAnalytics() {
  // posthog-js (and its React provider) is only pulled in for cloud deployments
  // with analytics enabled, so self-hosted builds never download it. The gate is
  // kept identical to the previous eager code so cloud analytics behavior is
  // unchanged; the import is simply deferred behind it.
  //
  // Crucially this runs AFTER the immediate first render below, so first paint is
  // never gated on the analytics chunk. Any failure (network, stale 404, or an
  // ad-blocker blocking a chunk named "posthog") is swallowed so the user keeps a
  // working app without analytics instead of a permanently blank page.
  if (!(isCloud() && isPostHogEnabled)) return;
  try {
    const { default: posthog } = await import("posthog-js");
    const { PostHogProvider } = await import("posthog-js/react");
    posthog.init(getPostHogKey(), {
      api_host: getPostHogHost(),
      defaults: "2025-05-24",
      disable_session_recording: true,
      capture_pageleave: false,
    });
    // Re-render with the provider now that analytics is ready. React reconciles
    // the same root, attaching the PostHog context above the (already painted)
    // app so the whole cloud tree is wrapped in PostHogProvider as before.
    renderApp(
      <PostHogProvider client={posthog}>
        <App />
      </PostHogProvider>,
    );
  } catch {
    // Analytics failed to load — degrade gracefully; the app already rendered.
  }
}

// Paint immediately for everyone (self-hosted stays exactly as instant as before,
// cloud no longer blocks on the analytics import). Analytics is attached after.
renderApp(<App />);
void initAnalytics();
