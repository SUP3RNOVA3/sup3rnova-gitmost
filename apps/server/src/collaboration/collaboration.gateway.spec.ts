import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationHandler } from './collaboration.handler';

/**
 * Focused test for the COLLAB_DISABLE_REDIS fallback in handleYjsEvent.
 *
 * With Redis disabled the gateway builds no RedisSyncExtension, so the old code
 * (`return this.redisSync?.handleEvent(...)`) returned undefined and every
 * doc-mutation event silently no-opped. The fallback must instead invoke the
 * handler locally against the single hocuspocus instance and return its verdict.
 *
 * We construct the gateway with stub extensions and an EnvironmentService whose
 * isCollabDisableRedis() returns true (redisSync stays null, real hocuspocus is
 * still built), then spy getHandlers so no real direct connection is opened.
 */

const stubExtension = {} as any;

function makeEnv() {
  return {
    getRedisUrl: () => 'redis://localhost:6379',
    isCollabDisableRedis: () => true,
  } as any;
}

describe('CollaborationGateway.handleYjsEvent (no-Redis fallback)', () => {
  it('invokes the handler locally and returns its verdict instead of undefined', async () => {
    const collabHandler = new CollaborationHandler();
    const verdict = { applied: true, currentText: 'new' };
    const fakeHandler = jest.fn().mockResolvedValue(verdict);
    // Bypass the real direct-connection code path — assert dispatch only.
    jest
      .spyOn(collabHandler, 'getHandlers')
      .mockReturnValue({ applyCommentSuggestion: fakeHandler } as any);

    const gateway = new CollaborationGateway(
      stubExtension,
      stubExtension,
      stubExtension,
      makeEnv(),
      collabHandler,
    );

    const payload = {
      commentId: 'c1',
      expectedText: 'old',
      newText: 'new',
      user: { id: 'u1' } as any,
    };
    const result = await gateway.handleYjsEvent(
      'applyCommentSuggestion' as any,
      'doc-1',
      payload as any,
    );

    expect(fakeHandler).toHaveBeenCalledWith('doc-1', payload);
    expect(result).toEqual(verdict);
    expect(result).not.toBeUndefined();
  });
});
