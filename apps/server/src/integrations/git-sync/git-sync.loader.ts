import { pathToFileURL } from 'node:url';
import type {
  VaultGit as VaultGitClass,
  vaultGitEnv as vaultGitEnvFn,
  runCycle as runCycleFn,
  parseDocmostMarkdown as parseDocmostMarkdownFn,
  markdownToProseMirror as markdownToProseMirrorFn,
} from '@docmost/git-sync';

/**
 * Runtime value-export surface of the ESM-only `@docmost/git-sync` package that
 * the server consumes. Types are imported with `import type` (erased at compile,
 * no runtime require); only the VALUE exports below need the dynamic-load
 * treatment so a CJS `require()` of the ESM package never happens.
 */
interface GitSyncModule {
  VaultGit: typeof VaultGitClass;
  vaultGitEnv: typeof vaultGitEnvFn;
  runCycle: typeof runCycleFn;
  parseDocmostMarkdown: typeof parseDocmostMarkdownFn;
  markdownToProseMirror: typeof markdownToProseMirrorFn;
}

// TS with module:commonjs downlevels a literal `import()` to `require()`, which
// cannot load the ESM-only `@docmost/git-sync` package. Indirect through
// Function so the real dynamic `import()` survives compilation and can load ESM
// from CommonJS at runtime (same trick as
// apps/server/src/core/ai-chat/tools/docmost-client.loader.ts and
// integrations/mcp/mcp.service.ts).
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

// Memoize the in-flight/loaded module so the dynamic import runs at most once.
let modulePromise: Promise<GitSyncModule> | null = null;

/**
 * Lazily load the ESM-only `@docmost/git-sync` package (cached). Resolves the
 * package entry to an absolute path, then imports it as a `file://` URL so the
 * package "exports" map is honoured without bare-specifier resolution-base
 * fragility.
 */
export async function loadGitSync(): Promise<GitSyncModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const entry = require.resolve('@docmost/git-sync');
      const mod = (await esmImport(
        pathToFileURL(entry).href,
      )) as GitSyncModule;
      return mod;
    })().catch((err) => {
      // Do not cache a rejected import — allow the next call to retry.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}
