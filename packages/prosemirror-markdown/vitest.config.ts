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
// Resolve the cross-package `@docmost/editor-ext` specifier to the SIBLING
// workspace SOURCE. In a normal checkout this is what pnpm's workspace link +
// the package's `module` field already yield; pinning it here makes the schema
// contract tests (incl. the #515 code-excludes parity) hermetic and independent
// of node_modules layout (e.g. a shared/hoisted store in a git worktree).
const editorExtBarrel = path.resolve(here, '../editor-ext/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      'docmost-client': libBarrel,
      '@docmost/editor-ext': editorExtBarrel,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Register the Node (jsdom) HTML parser before any test runs. Tests import
    // the converter via relative src/lib modules, bypassing the top-level entry
    // that normally installs the parser as a side effect (see setup file).
    setupFiles: ['test/setup.dom-parser.ts'],
  },
});
