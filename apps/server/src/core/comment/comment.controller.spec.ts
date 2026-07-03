import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CommentController } from './comment.controller';

/**
 * Authz-gate tests for the apply-suggestion route. Applying a suggestion
 * rewrites the page text, so the route MUST call
 * pageAccessService.validateCanEdit BEFORE handing off to
 * commentService.applySuggestion (which performs the document mutation + stamp).
 * That ordering is a security boundary: an unauthorized user must never reach
 * the mutation. These tests pin it against a fully mocked controller so any
 * regression that drops the gate (or reorders it after the mutation) fails here.
 */
describe('CommentController apply-suggestion authz', () => {
  function makeController() {
    const commentService = {
      applySuggestion: jest.fn(async () => ({ id: 'c-1', applied: true })),
    };
    const commentRepo = { findById: jest.fn() };
    const pageRepo = { findById: jest.fn() };
    const spaceAbility = {} as any;
    const pageAccessService = {
      validateCanEdit: jest.fn(async () => undefined),
    };
    const wsService = {} as any;
    const auditService = { log: jest.fn() };

    const controller = new CommentController(
      commentService as any,
      commentRepo as any,
      pageRepo as any,
      spaceAbility,
      pageAccessService as any,
      wsService,
      auditService as any,
    );
    return {
      controller,
      commentService,
      commentRepo,
      pageRepo,
      pageAccessService,
    };
  }

  const user: any = { id: 'u-1' };
  const workspace: any = { id: 'ws-1' };
  const provenance: any = undefined;
  const dto: any = { commentId: 'c-1' };

  const comment = {
    id: 'c-1',
    pageId: 'p-1',
    spaceId: 'sp-1',
    suggestedText: 'new text',
    selection: 'old text',
  };
  const page = { id: 'p-1', spaceId: 'sp-1', deletedAt: null };

  it('validateCanEdit throwing Forbidden rejects AND applySuggestion is never called', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    pageAccessService.validateCanEdit.mockRejectedValue(
      new ForbiddenException('no edit access'),
    );

    await expect(
      controller.applySuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The security boundary: the mutation/stamp must NOT run for an
    // unauthorized user.
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    expect(commentService.applySuggestion).not.toHaveBeenCalled();
  });

  it('happy path: validateCanEdit resolves → applySuggestion is called and its result returned', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(comment);
    pageRepo.findById.mockResolvedValue(page);
    const applied = { id: 'c-1', applied: true };
    commentService.applySuggestion.mockResolvedValue(applied);

    const result = await controller.applySuggestion(
      dto,
      user,
      workspace,
      provenance,
    );

    // Authorization ran before the mutation, then the service was invoked.
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
    expect(commentService.applySuggestion).toHaveBeenCalledWith(
      comment,
      user,
      provenance,
    );
    expect(result).toBe(applied);
  });

  it('missing comment: NotFound is thrown without authorizing or applying', async () => {
    const { controller, commentRepo, pageRepo, pageAccessService, commentService } =
      makeController();
    commentRepo.findById.mockResolvedValue(null);

    await expect(
      controller.applySuggestion(dto, user, workspace, provenance),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(commentService.applySuggestion).not.toHaveBeenCalled();
  });
});
