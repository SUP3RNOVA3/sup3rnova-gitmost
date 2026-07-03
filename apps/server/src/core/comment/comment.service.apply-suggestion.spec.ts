import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommentService } from './comment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';

/**
 * Focused coverage for CommentService.applySuggestion (comment.service.ts).
 * The service is constructed directly with jest-mocked deps (the @InjectQueue
 * tokens can't be resolved by Test.createTestingModule — see the sibling specs).
 *
 * The collaboration gateway verdict is the pivot of the whole flow, so each test
 * pins a specific { applied, currentText } and asserts the DB persistence,
 * auto-resolve, audit, ws broadcast, and error mapping that follow from it.
 */
describe('CommentService — applySuggestion', () => {
  const UPDATED = { id: 'c-1', __updated: true } as any;

  function makeService(verdict: unknown) {
    const commentRepo: any = {
      // Both the applied-stamp re-read and resolveComment's re-read go through
      // findById; return a recognizable enriched row.
      findById: jest.fn(async () => UPDATED),
      updateComment: jest.fn(async () => undefined),
    };
    const pageRepo: any = {};
    const wsService: any = { emitCommentEvent: jest.fn() };
    const collaborationGateway: any = {
      handleYjsEvent: jest.fn(async () => verdict),
    };
    const generalQueue: any = { add: jest.fn(() => Promise.resolve()) };
    const notificationQueue: any = { add: jest.fn(async () => undefined) };
    const auditService: any = { log: jest.fn() };

    const service = new CommentService(
      commentRepo,
      pageRepo,
      wsService,
      collaborationGateway,
      generalQueue,
      notificationQueue,
      auditService,
    );

    return {
      service,
      commentRepo,
      wsService,
      collaborationGateway,
      auditService,
    };
  }

  const suggestionComment = (over?: Partial<any>): any => ({
    id: 'c-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    creatorId: 'user-1',
    parentCommentId: null,
    selection: 'old text',
    suggestedText: 'new text',
    suggestionAppliedAt: null,
    resolvedAt: null,
    ...over,
  });
  const user = (over?: Partial<any>): any => ({ id: 'user-1', ...over });

  // Pull the updateComment patch that carries the applied stamps.
  const appliedPatch = (commentRepo: any) =>
    commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((patch: any) => 'suggestionAppliedAt' in patch);

  it('applied=true → replaces text, persists applied stamps, auto-resolves, audits, returns updated', async () => {
    const { service, commentRepo, wsService, collaborationGateway, auditService } =
      makeService({ applied: true, currentText: 'new text' });

    const result = await service.applySuggestion(suggestionComment(), user());

    // The atomic replace was requested against the exact marked text.
    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'applyCommentSuggestion',
      'page.page-1',
      expect.objectContaining({
        commentId: 'c-1',
        expectedText: 'old text',
        newText: 'new text',
        user: expect.objectContaining({ id: 'user-1' }),
      }),
    );

    // Applied stamps persisted.
    const patch = appliedPatch(commentRepo);
    expect(patch.suggestionAppliedAt).toBeInstanceOf(Date);
    expect(patch.suggestionAppliedById).toBe('user-1');

    // Auto-resolved: resolveComment writes a resolvedAt/resolvedById patch too.
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    expect(resolvePatch.resolvedById).toBe('user-1');

    // Audit + broadcast + return.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
        resourceType: AuditResource.COMMENT,
        resourceId: 'c-1',
        spaceId: 'space-1',
        metadata: { pageId: 'page-1' },
      }),
    );
    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({ operation: 'commentUpdated', comment: UPDATED }),
    );
    expect(result).toBe(UPDATED);
  });

  it('applied=false but currentText === suggestedText → idempotent success (no 409)', async () => {
    const { service, commentRepo, auditService } = makeService({
      applied: false,
      currentText: 'new text',
    });

    const result = await service.applySuggestion(suggestionComment(), user());

    // The stamps are still persisted (reconciling a crash between the doc
    // mutation and the DB write) and the call succeeds.
    const patch = appliedPatch(commentRepo);
    expect(patch.suggestionAppliedAt).toBeInstanceOf(Date);
    expect(patch.suggestionAppliedById).toBe('user-1');
    expect(auditService.log).toHaveBeenCalledTimes(1);
    expect(result).toBe(UPDATED);
  });

  it('applied=false and currentText differs → ConflictException with currentText in payload', async () => {
    const { service, commentRepo, auditService } = makeService({
      applied: false,
      currentText: 'someone else edited this',
    });

    const err = await service
      .applySuggestion(suggestionComment(), user())
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      currentText: 'someone else edited this',
    });
    // No persistence and no audit on a conflict.
    expect(appliedPatch(commentRepo)).toBeUndefined();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('already-applied AND already-resolved → idempotent success, no collab call, no re-resolve (#315 double-click)', async () => {
    const { service, collaborationGateway, commentRepo, auditService } =
      makeService({ applied: true, currentText: 'new text' });

    const result = await service.applySuggestion(
      suggestionComment({
        suggestionAppliedAt: new Date(),
        resolvedAt: new Date(),
        resolvedById: 'user-1',
      }),
      user(),
    );

    // Idempotent SUCCESS, not a 409. The suggestion is already applied, so the
    // collaborative document is never touched again and nothing is re-stamped
    // or re-resolved.
    expect(result).toBe(UPDATED);
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
    expect(commentRepo.updateComment).not.toHaveBeenCalled();
    // Same success shape as the applied path (broadcast + audit).
    expect(auditService.log).toHaveBeenCalledTimes(1);
  });

  it('already-applied but NOT resolved (crash window) → idempotent success, self-heals resolve, no re-apply', async () => {
    const { service, collaborationGateway, commentRepo } = makeService({
      applied: true,
      currentText: 'new text',
    });

    const result = await service.applySuggestion(
      suggestionComment({ suggestionAppliedAt: new Date(), resolvedAt: null }),
      user(),
    );

    expect(result).toBe(UPDATED);

    // The suggestion is NOT re-applied to the document…
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalledWith(
      'applyCommentSuggestion',
      expect.anything(),
      expect.anything(),
    );
    // …but the open thread is self-healed to resolved via resolveComment, which
    // writes the resolve patch and updates the resolve mark.
    const resolvePatch = commentRepo.updateComment.mock.calls
      .map((c: any[]) => c[0])
      .find((p: any) => 'resolvedAt' in p);
    expect(resolvePatch.resolvedAt).toBeInstanceOf(Date);
    expect(resolvePatch.resolvedById).toBe('user-1');
    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      expect.objectContaining({ commentId: 'c-1', resolved: true }),
    );
    // The applied stamps are NOT re-written (already stamped).
    expect(appliedPatch(commentRepo)).toBeUndefined();
  });

  it('rejects a comment with no suggestedText', async () => {
    const { service, collaborationGateway } = makeService({
      applied: true,
      currentText: 'x',
    });

    await expect(
      service.applySuggestion(
        suggestionComment({ suggestedText: null }),
        user(),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(collaborationGateway.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('gateway returning undefined → hard error, not a silent success', async () => {
    const { service, commentRepo, auditService } = makeService(undefined);

    await expect(
      service.applySuggestion(suggestionComment(), user()),
    ).rejects.toThrow(InternalServerErrorException);

    // Nothing persisted, nothing audited.
    expect(appliedPatch(commentRepo)).toBeUndefined();
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
