import { normalizeNovaReadTool } from './nova-tool-compat';
describe('NOVA read compatibility', () => {
  it.each([['list_spaces','listSpaces'],['list_pages','listPages'],['get_page','getPage']])('maps %s without changing arguments', (oldName, newName) => {
    const body = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: oldName, arguments: { pageId: 'restricted-page' } } };
    expect(normalizeNovaReadTool(body)).toEqual({ ...body, params: { ...body.params, name: newName } });
    expect(body.params.name).toBe(oldName);
  });
  it('does not introduce write aliases or reinterpret unrelated messages', () => {
    for (const body of [null, [], { method: 'tools/call', params: { name: 'delete_page' } }, { method: 'tools/list' }]) expect(normalizeNovaReadTool(body)).toBe(body);
  });
});
