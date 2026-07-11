export enum QueueName {
  EMAIL_QUEUE = '{email-queue}',
  ATTACHMENT_QUEUE = '{attachment-queue}',
  GENERAL_QUEUE = '{general-queue}',
  BILLING_QUEUE = '{billing-queue}',
  FILE_TASK_QUEUE = '{file-task-queue}',
  AI_QUEUE = '{ai-queue}',
  HISTORY_QUEUE = '{history-queue}',
  NOTIFICATION_QUEUE = '{notification-queue}',
  AUDIT_QUEUE = '{audit-queue}',
}

export enum QueueJob {
  SEND_EMAIL = 'send-email',
  DELETE_SPACE_ATTACHMENTS = 'delete-space-attachments',
  ATTACHMENT_INDEX_CONTENT = 'attachment-index-content',
  ATTACHMENT_INDEXING = 'attachment-indexing',
  DELETE_PAGE_ATTACHMENTS = 'delete-page-attachments',
  DELETE_AI_CHAT_ATTACHMENTS = 'delete-ai-chat-attachments',

  DELETE_USER_AVATARS = 'delete-user-avatars',

  PAGE_BACKLINKS = 'page-backlinks',
  ADD_PAGE_WATCHERS = 'add-page-watchers',

  STRIPE_SEATS_SYNC = 'sync-stripe-seats',
  TRIAL_ENDED = 'trial-ended',
  WELCOME_EMAIL = 'welcome-email',
  FIRST_PAYMENT_EMAIL = 'first-payment-email',

  IMPORT_TASK = 'import-task',
  EXPORT_TASK = 'export-task',

  TYPESENSE_FLUSH = 'typesense-flush',

  PAGE_CREATED = 'page-created',
  PAGE_CONTENT_UPDATED = 'page-content-updated',
  PAGE_MOVED_TO_SPACE = 'page-moved-to-space',
  PAGE_UPDATED = 'page-updated',
  PAGE_SOFT_DELETED = 'page-soft-deleted',
  PAGE_RESTORED = 'page-restored',
  PAGE_DELETED = 'page-deleted',

  SPACE_CREATED = 'space-created',
  SPACE_UPDATED = 'space-updated',
  SPACE_DELETED = 'space-deleted',

  WORKSPACE_CREATED = 'workspace-created',
  WORKSPACE_SPACE_UPDATED = 'workspace-updated',
  WORKSPACE_DELETED = 'workspace-deleted',
  WORKSPACE_CREATE_EMBEDDINGS = 'workspace-create-embeddings',
  WORKSPACE_DELETE_EMBEDDINGS = 'workspace-delete-embeddings',

  GENERATE_PAGE_EMBEDDINGS = 'generate-page-embeddings',
  DELETE_PAGE_EMBEDDINGS = 'delete-page-embeddings',

  PAGE_HISTORY = 'page-history',

  COMMENT_NOTIFICATION = 'comment-notification',
  COMMENT_RESOLVED_NOTIFICATION = 'comment-resolved-notification',
  // #399: off-critical-path mirror of a comment's inline mark into the collab
  // Y.Doc (resolve/unresolve flip, or ephemeral-suggestion anchor removal).
  COMMENT_MARK_UPDATE = 'comment-mark-update',
  PAGE_MENTION_NOTIFICATION = 'page-mention-notification',
  PAGE_PERMISSION_GRANTED = 'page-permission-granted',
  PAGE_UPDATE_DIGEST = 'page-update-digest',
  PAGE_VERIFICATION_EXPIRING = 'page-verification-expiring',
  PAGE_VERIFICATION_EXPIRED = 'page-verification-expired',
  VERIFICATION_RECONCILE = 'verification-reconcile',
  PAGE_VERIFIED_NOTIFICATION = 'page-verified-notification',
  PAGE_APPROVAL_REQUESTED_NOTIFICATION = 'page-approval-requested-notification',
  PAGE_APPROVAL_REJECTED_NOTIFICATION = 'page-approval-rejected-notification',

  AUDIT_LOG = 'audit-log',
  AUDIT_CLEANUP = 'audit-cleanup',

  PDF_EXPORT_TASK = 'pdf-export-task',
  PDF_EXPORT_CLEANUP = 'pdf-export-cleanup',
}
