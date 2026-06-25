import { resolveSource } from './persistence.extension';

// Red-team finding #14: an explicit git-sync write (no agent edit in the
// coalescing window) must keep the 'git-sync' source so the git-sync
// listener's loop-guard can recognize its own writes and not re-export them.
describe('resolveSource — #14 git-sync provenance loop-guard', () => {
  it('keeps git-sync source for an explicit git-sync write (stickyTouched=true, actor=git-sync)', () => {
    expect(resolveSource(true, 'git-sync')).toBe('git-sync');
  });
});
