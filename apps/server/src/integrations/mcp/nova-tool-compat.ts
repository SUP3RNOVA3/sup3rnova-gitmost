/** Legacy NOVA read names only. Authentication and tool authorization are unchanged. */
export function normalizeNovaReadTool(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const rpc = body as { method?: string; params?: { name?: string } };
  if (rpc.method !== 'tools/call' || !rpc.params) return body;
  const names: Record<string, string> = {
    list_spaces: 'listSpaces', list_pages: 'listPages', get_page: 'getPage',
  };
  const name = names[rpc.params.name ?? ''];
  return name ? { ...rpc, params: { ...rpc.params, name } } : body;
}
