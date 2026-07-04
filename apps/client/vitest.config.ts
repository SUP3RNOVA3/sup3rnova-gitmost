import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Coverage gate (issue #324). v8 provider (not istanbul) so ESM barrels
    // like `@docmost/editor-ext` are not re-parsed/instrumented. Thresholds are
    // set a few points below the level measured on develop, scoped to the files
    // the suite exercises (`all: false`) rather than the whole app, so the gate
    // passes today but fails on a genuine coverage regression.
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      all: false,
      thresholds: {
        statements: 55,
        branches: 53,
        functions: 44,
        lines: 55,
      },
    },
  },
});
