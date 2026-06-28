import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import * as path from "path";
import { execSync } from "node:child_process";

const envPath = path.resolve(process.cwd(), "..", "..");

// Resolve the version string shown in the UI.
// Priority: explicit APP_VERSION env (injected by Docker/CI, where .git is absent),
// then `git describe` for local builds, then the package.json version as a fallback.
function resolveAppVersion(cwd: string): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git describe --tags --always", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return `v${process.env.npm_package_version ?? "0.0.0"}`;
  }
}

export default defineConfig(({ mode }) => {
  const {
    APP_URL,
    FILE_UPLOAD_SIZE_LIMIT,
    FILE_IMPORT_SIZE_LIMIT,
    DRAWIO_URL,
    CLOUD,
    SUBDOMAIN_HOST,
    COLLAB_URL,
    BILLING_TRIAL_DAYS,
    POSTHOG_HOST,
    POSTHOG_KEY,
  } = loadEnv(mode, envPath, "");

  return {
    define: {
      "process.env": {
        APP_URL,
        FILE_UPLOAD_SIZE_LIMIT,
        FILE_IMPORT_SIZE_LIMIT,
        DRAWIO_URL,
        CLOUD,
        SUBDOMAIN_HOST,
        COLLAB_URL,
        BILLING_TRIAL_DAYS,
        POSTHOG_HOST,
        POSTHOG_KEY,
      },
      APP_VERSION: JSON.stringify(resolveAppVersion(envPath)),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        injectRegister: null,
        strategies: "generateSW",
        manifest: false,
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,json}"],
          navigateFallback: "index.html",
          // Segment-anchored (`^/<seg>(/|$)`) so navigation requests to these
          // segments are consistently excluded from the SPA fallback, mirroring
          // the runtimeCaching urlPattern regexes below.
          //
          // `/share`, `/mcp`, `/l`, and `/robots.txt` mirror the server
          // static-serve exclude list (apps/server/src/main.ts setGlobalPrefix
          // `exclude`): robots.txt, the SEO/OG/analytics-injected public share
          // HTML, the embedded MCP endpoint, and the `l/:alias` vanity short-link
          // (a server 302 to a share page) are served by server controllers, so
          // the SW must never shadow them with the precached index.html app shell.
          // For `/l/:alias` the client router has NO matching route, so serving
          // the app shell would dead-end on Error404 and break the public link;
          // it must reach the server to perform the redirect.
          navigateFallbackDenylist: [
            /^\/api(\/|$)/,
            /^\/collab(\/|$)/,
            /^\/socket\.io(\/|$)/,
            /^\/share(\/|$)/,
            /^\/mcp(\/|$)/,
            /^\/l(\/|$)/,
            /^\/robots\.txt$/,
          ],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          // The urlPattern regexes below mirror apps/client/src/pwa/sw-strategy.ts
          // and MUST be kept in sync with it. Workbox `generateSW` serializes these
          // functions standalone into the generated service worker, so they cannot
          // import the module — the matching logic is intentionally duplicated as
          // self-contained inline regex literals anchored to a path segment boundary.
          runtimeCaching: [
            { urlPattern: ({ url }) => /^\/(collab|socket\.io)(\/|$)/.test(url.pathname), handler: "NetworkOnly" },
            // All /api stays network-only; offline reads come from the persisted
            // React Query cache (IndexedDB) + y-indexeddb, not the SW HTTP cache.
            { urlPattern: ({ url }) => /^\/api(\/|$)/.test(url.pathname), handler: "NetworkOnly" },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    build: {
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: APP_URL,
          changeOrigin: false,
        },
        "/socket.io": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
        "/collab": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  };
});
