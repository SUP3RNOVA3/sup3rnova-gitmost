import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #639 criterion 1 — the dev flag plumbing.
 *
 * The prod path feeds these flags through `window.CONFIG`; in dev the client
 * reads `process.env`, baked in by vite.config's `define`. A key absent from
 * EITHER the `loadEnv` destructuring OR the `define["process.env"]` allowlist
 * reads `undefined` in dev, so the flag is unreachable and e.g.
 * `isLocalFirstEnabled()` is ALWAYS false. We cannot run vite here (and a real
 * `@/lib/config` import cannot even load in this headless sandbox — its icon
 * graph pulls the unresolved `lucide-react/dynamic` subpath), so per the issue's
 * own guidance we assert the config plumbing keeps BOTH sites in sync by parsing
 * vite.config.ts.
 */
describe("vite.config flag allowlist (#639 criterion 1)", () => {
  // The client vitest runs with apps/client as cwd.
  const viteConfig = readFileSync(
    path.resolve(process.cwd(), "vite.config.ts"),
    "utf8",
  );

  // The destructuring block: `const { ... } = loadEnv(...)`.
  const loadEnvIdx = viteConfig.indexOf("= loadEnv");
  const destructuring = viteConfig.slice(
    viteConfig.lastIndexOf("const {", loadEnvIdx),
    loadEnvIdx,
  );
  // The define allowlist object: `"process.env": { ... }` (up to its closing }).
  const defineStart = viteConfig.indexOf('"process.env": {');
  const defineBlock = viteConfig.slice(
    defineStart,
    viteConfig.indexOf("\n      }", defineStart),
  );

  const KEYS = [
    "LOCAL_FIRST_ENABLED",
    "CLIENT_TELEMETRY_ENABLED",
    "COMPACT_PAGE_TREE",
    // #639 §4 — the sampling-rate override rides the same plumbing.
    "CLIENT_TELEMETRY_SAMPLE_RATE",
  ];

  it("splits the config into a real destructuring block and a real define block", () => {
    expect(loadEnvIdx).toBeGreaterThan(0);
    expect(defineStart).toBeGreaterThan(0);
    expect(destructuring).toContain("APP_URL");
    expect(defineBlock).toContain("APP_URL");
  });

  it("whitelists each flag in BOTH the loadEnv destructuring and the define object", () => {
    for (const key of KEYS) {
      expect(
        destructuring,
        `${key} missing from loadEnv destructuring`,
      ).toContain(key);
      expect(defineBlock, `${key} missing from define['process.env']`).toContain(
        key,
      );
    }
  });
});
