import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Ported docmost-sync tests import the converter through the upstream package
// barrel specifier `docmost-client`. We vendored only the PURE half of that
// package into `src/lib`, so alias the barrel specifier to our local lib
// barrel; everything those tests use (converter, canonicalize, markdown
// envelope, markdownToProseMirror) is re-exported there.
const here = path.dirname(fileURLToPath(import.meta.url));
const libBarrel = path.resolve(here, 'src/lib/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      'docmost-client': libBarrel,
    },
  },
  test: {
    environment: 'node',
    // Runtime suites. The `.test.ts` glob deliberately EXCLUDES the type-only
    // contract file (`*.test-d.ts`), which is enforced by the typecheck pass
    // below instead — so the 35 runtime suites are never typechecked.
    include: ['test/**/*.test.ts'],
    // Type-level contract enforcement (Finding #1). Vitest runs `tsc` over the
    // `.test-d.ts` files so the `expectTypeOf`/`@ts-expect-error` guards in
    // git-sync-client.contract.test-d.ts become REAL build-time assertions: a
    // drift in the GitSyncClient result shapes makes `npx vitest run` FAIL with
    // a type error. Scoped to `*.test-d.ts` so the runtime suites stay
    // untouched, and pointed at the package tsconfig for the strict options.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      // A dedicated test-infra tsconfig (NOT the build one) that widens the file
      // set to include `test/**` — the build tsconfig scopes `tsc` to `src/**`
      // (rootDir ./src), so without this the type-test file is never checked.
      tsconfig: './tsconfig.vitest.json',
    },
  },
});
