// Jest stub for @tiptap/react. The server export/import code paths transitively
// import editor-ext, whose node extensions reference `ReactNodeViewRenderer`
// inside `addNodeView()` — code that only runs inside a live browser editor and
// is NEVER invoked on the server. The real module eagerly pulls react-dom, which
// throws `navigator is not defined` under jest's node environment. This stub
// supplies the named exports the extensions bind at import time; if any were
// actually called on the server that would (correctly) surface as a test error.
module.exports = {
  ReactNodeViewRenderer: () => () => ({}),
  NodeViewWrapper: () => null,
  NodeViewContent: () => null,
  ReactRenderer: class {},
};
