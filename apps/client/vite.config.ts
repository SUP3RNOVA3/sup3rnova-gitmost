import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { compression } from "vite-plugin-compression2";
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
      // Emit .br and .gz next to every built asset so the server can serve the
      // precompressed copy (see @fastify/static preCompressed in static.module.ts).
      compression({
        algorithms: ["brotliCompress", "gzip"],
        // vite-plugin-compression2's default `include` only covers text-ish
        // bundle output (js/mjs/json/css/html/svg/…). Extend it with the large
        // VAD binaries copied from public/vad (.wasm ~26MB, .onnx ~2.3MB) so
        // they are brotli/gzip'd once at build time and served via
        // @fastify/static preCompressed — otherwise @fastify/compress would
        // re-brotli them on EVERY request. The default types are repeated here
        // because setting `include` replaces (does not extend) the default.
        include: /\.(html|xml|css|json|js|mjs|svg|yaml|yml|toml|wasm|onnx)$/,
        // index.html is rewritten at server boot (window.CONFIG injection); a
        // precompressed copy would go stale — NEVER precompress it.
        exclude: [/index\.html$/],
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
