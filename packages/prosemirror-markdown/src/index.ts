/**
 * Public surface of `@docmost/prosemirror-markdown`.
 *
 * A headless, framework-free ProseMirror <-> Markdown converter plus the
 * Docmost schema mirror. Everything lives under `lib/` (the converter core);
 * this top-level barrel simply re-exports that surface so the package entry is
 * the converter surface.
 */
export * from "./lib/index.js";
