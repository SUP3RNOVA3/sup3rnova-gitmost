import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
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
    plugins: [react()],
    build: {
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
              // NOTE: TipTap/ProseMirror/Yjs are intentionally NOT force-grouped
              // into a single vendor chunk. Doing so backfires: rolldown co-locates
              // a small module shared with the (eager) react-i18next runtime into
              // that group chunk, which then drags the whole ~590KB editor engine
              // into the eager modulepreload graph. Left to the default splitting,
              // the editor engine stays in lazily-loaded chunks pulled only by the
              // route-split editor/share pages. KaTeX is safe to group (nothing
              // eager references it).
              // KaTeX in its own stable chunk; loaded on demand by the lazy math
              // node views (never in the startup path).
              {
                name: "vendor-katex",
                test: /[\\/]node_modules[\\/]katex[\\/]/,
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
