import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import '@mantine/dates/styles.css';
import "@/styles/a11y-overrides.css";

import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { mantineCssResolver, theme } from "@/theme";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { HelmetProvider } from "react-helmet-async";
import "./i18n";
import { PostHogProvider } from "posthog-js/react";
import {
  getPostHogHost,
  getPostHogKey,
  isCloud,
  isPostHogEnabled,
} from "@/lib/config.ts";
import {
  queryPersister,
  shouldDehydrateOfflineQuery,
} from "@/features/offline/query-persister";
import { PwaUpdatePrompt } from "@/pwa/pwa-update-prompt";
import { isCapacitorNativePlatform } from "@/pwa/is-capacitor";
import posthog from "posthog-js";
import { initVitals } from "@/lib/telemetry/vitals";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5 * 60 * 1000,
      // Keep cached read data around long enough to be persisted/restored for offline use.
      gcTime: 1000 * 60 * 60 * 24,
    },
  },
});

if (isCloud() && isPostHogEnabled) {
  posthog.init(getPostHogKey(), {
    api_host: getPostHogHost(),
    defaults: "2025-05-24",
    disable_session_recording: true,
    capture_pageleave: false,
  });
}

// #355 — client perf-telemetry. Decides sampling ONCE (25%/session) before
// subscribing to any observer; non-sampled sessions send nothing.
initVitals();

const container = document.getElementById("root") as HTMLElement;
const root = (container as any).__reactRoot ??= ReactDOM.createRoot(container);

root.render(
  <BrowserRouter>
    <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
      <ModalsProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister: queryPersister,
            maxAge: 1000 * 60 * 60 * 24,
            buster: APP_VERSION,
            dehydrateOptions: {
              shouldDehydrateQuery: shouldDehydrateOfflineQuery,
            },
          }}
        >
          <Notifications position="bottom-center" limit={3} zIndex={10000} />
          {/* Skip SW registration inside the Capacitor native WebView — the
              native shell serves assets itself; a browser SW would conflict. */}
          {!isCapacitorNativePlatform() && <PwaUpdatePrompt />}
          <HelmetProvider>
            <PostHogProvider client={posthog}>
              <App />
            </PostHogProvider>
          </HelmetProvider>
        </PersistQueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  </BrowserRouter>,
);

// Register the service worker for PWA installability and an offline app shell.
// Production only: in dev the Vite server and HMR must not be intercepted.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
