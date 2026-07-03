import { IComment } from "@/features/comment/types/comment.types";

// Whether the suggested-edit (#315) "Apply" button should be shown for a
// comment: it must carry a suggestion, not already be applied or resolved, be a
// top-level comment, and the viewer must be able to edit the page.
export function canShowApply(comment: IComment, canEdit?: boolean): boolean {
  return Boolean(
    canEdit &&
      comment.suggestedText &&
      !comment.suggestionAppliedAt &&
      !comment.resolvedAt &&
      !comment.parentCommentId,
  );
}
