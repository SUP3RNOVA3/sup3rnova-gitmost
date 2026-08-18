import { safeReturnPath } from './workos-auth.service';

describe('safeReturnPath', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['https://evil.example/path', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example/path', '/'],
    ['/spaces/knowledge\r\nLocation: https://evil.example', '/'],
    ['/spaces/knowledge', '/spaces/knowledge'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});
