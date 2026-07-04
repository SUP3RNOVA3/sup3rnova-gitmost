import React, { useState, useRef, useCallback, memo, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  ActionIcon,
  Center,
  Divider,
  Group,
  Paper,
  Stack,
  Tabs,
  Badge,
  Text,
  ScrollArea,
  Tooltip,
} from "@mantine/core";
import CommentListItem from "@/features/comment/components/comment-list-item";
import {
  useCommentsQuery,
  useCreateCommentMutation,
} from "@/features/comment/queries/comment-query";
import CommentEditor from "@/features/comment/components/comment-editor";
import CommentActions from "@/features/comment/components/comment-actions";
import { useFocusWithin } from "@mantine/hooks";
import { IComment } from "@/features/comment/types/comment.types.ts";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { extractPageSlugId } from "@/lib";
import { useTranslation } from "react-i18next";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { IconArrowUp, IconMessageOff, IconX } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";

interface CommentListWithTabsProps {
  onClose?: () => void;
}

function CommentListWithTabs({ onClose }: CommentListWithTabsProps) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const {
    data: comments,
    isLoading: isCommentsLoading,
    isError,
  } = useCommentsQuery({ pageId: page?.id });
  const createCommentMutation = useCreateCommentMutation();
  // mutateAsync is a stable reference across renders; depend on it (not the
  // mutation object) so the reply/comment callbacks stay stable.
  const createCommentAsync = createCommentMutation.mutateAsync;
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);

  const canEdit = page?.permissions?.canEdit ?? false;

  const canComment =
    canEdit ||
    (space?.settings?.comments?.allowViewerComments === true);

  // Separate active and resolved comments
  const { activeComments, resolvedComments } = useMemo(() => {
    if (!comments?.items) {
      return { activeComments: [], resolvedComments: [] };
    }

    const parentComments = comments.items.filter(
      (comment: IComment) => comment.parentCommentId === null,
    );

    const active = parentComments.filter(
      (comment: IComment) => !comment.resolvedAt,
    );
    const resolved = parentComments.filter(
      (comment: IComment) => comment.resolvedAt,
    );

    return { activeComments: active, resolvedComments: resolved };
  }, [comments]);

  // Index replies by their parent once, instead of an O(n^2) filter per thread.
  // The map ref changes on any comments update, so MemoizedChildComments re-runs
  // (cheap) and re-looks-up, while memoized CommentListItems skip unchanged items.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, IComment[]>();
    for (const c of comments?.items ?? []) {
      if (c.parentCommentId) {
        const arr = m.get(c.parentCommentId);
        if (arr) arr.push(c);
        else m.set(c.parentCommentId, [c]);
      }
    }
    return m;
  }, [comments?.items]);

  const [isPageCommentLoading, setIsPageCommentLoading] = useState(false);

  const handleAddPageComment = useCallback(
    async (_commentId: string, content: string) => {
      try {
        setIsPageCommentLoading(true);
        const createdComment = await createCommentAsync({
          pageId: page?.id,
          content: JSON.stringify(content),
        });

        setTimeout(() => {
          const selector = `div[data-comment-id="${createdComment.id}"]`;
          const commentElement = document.querySelector(selector);
          commentElement?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 400);
      } catch (error) {
        console.error("Failed to post comment:", error);
      } finally {
        setIsPageCommentLoading(false);
      }
    },
    [createCommentAsync, page?.id],
  );

  const handleAddReply = useCallback(
    async (commentId: string, content: string) => {
      // Pending state lives inside CommentEditorWithActions so sending a reply
      // does not churn renderComments and re-render the whole list.
      try {
        const commentData = {
          pageId: page?.id,
          parentCommentId: commentId,
          content: JSON.stringify(content),
        };

        await createCommentAsync(commentData);
      } catch (error) {
        console.error("Failed to post comment:", error);
      }
    },
    [createCommentAsync, page?.id],
  );

  const renderComments = useCallback(
    (comment: IComment) => (
      <Paper
        shadow="sm"
        radius="md"
        p="xs"
        mb="xs"
        withBorder
        key={comment.id}
        data-comment-id={comment.id}
      >
        <div>
          <CommentListItem
            comment={comment}
            pageId={page?.id}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={space?.membership?.role}
          />
          <MemoizedChildComments
            childrenByParent={childrenByParent}
            parentId={comment.id}
            pageId={page?.id}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={space?.membership?.role}
          />
        </div>

        {!comment.resolvedAt && canComment && (
          <>
            <Divider my={2} />
            <CommentEditorWithActions
              commentId={comment.id}
              onSave={handleAddReply}
            />
          </>
        )}
      </Paper>
    ),
    [
      childrenByParent,
      handleAddReply,
      page?.id,
      space?.membership?.role,
      canComment,
      canEdit,
    ],
  );

  if (isCommentsLoading) {
    return <></>;
  }

  if (isError) {
    return <div>{t("Error loading comments.")}</div>;
  }

  const totalComments = activeComments.length + resolvedComments.length;

  const pageCommentInput = canComment ? (
    <PageCommentInput
      onSave={handleAddPageComment}
      isLoading={isPageCommentLoading}
    />
  ) : null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Tabs
        defaultValue="open"
        variant="default"
        // Do not mount the inactive tab: the Resolved list (hundreds of items)
        // stays unmounted while the Open tab is shown, and vice versa.
        keepMounted={false}
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header row: full-width centered tab list with the close button overlaid on the right. */}
        <div style={{ position: "relative" }}>
          <Tabs.List justify="center">
            <Tabs.Tab
              value="open"
              leftSection={
                <Badge size="sm" variant="light" color="blue">
                  {activeComments.length}
                </Badge>
              }
            >
              {t("Open")}
            </Tabs.Tab>
            <Tabs.Tab
              value="resolved"
              leftSection={
                <Badge size="sm" variant="light" color="green">
                  {resolvedComments.length}
                </Badge>
              }
            >
              {t("Resolved")}
            </Tabs.Tab>
          </Tabs.List>
          {onClose && (
            <Tooltip label={t("Close")} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={onClose}
                aria-label={t("Close")}
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  // Nudge the close button slightly up to align with the tab labels.
                  transform: "translateY(calc(-50% - 4px))",
                }}
              >
                <IconX size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </div>

        <ScrollArea
          style={{ flex: "1 1 auto" }}
          scrollbarSize={5}
          type="scroll"
        >
          <div style={{ paddingBottom: "8px" }}>
            <Tabs.Panel value="open" pt="xs">
              {activeComments.length === 0 ? (
                <Center py="xl">
                  <Stack align="center" gap="xs">
                    <IconMessageOff
                      size={32}
                      stroke={1.5}
                      color="var(--mantine-color-dimmed)"
                    />
                    <Text size="sm" c="dimmed">
                      {t("No open comments.")}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                activeComments.map(renderComments)
              )}
            </Tabs.Panel>

            <Tabs.Panel value="resolved" pt="xs">
              {resolvedComments.length === 0 ? (
                <Center py="xl">
                  <Stack align="center" gap="xs">
                    <IconMessageOff
                      size={32}
                      stroke={1.5}
                      color="var(--mantine-color-dimmed)"
                    />
                    <Text size="sm" c="dimmed">
                      {t("No resolved comments.")}
                    </Text>
                  </Stack>
                </Center>
              ) : (
                resolvedComments.map(renderComments)
              )}
            </Tabs.Panel>
          </div>
        </ScrollArea>
      </Tabs>
      {pageCommentInput}
    </div>
  );
}

interface ChildCommentsProps {
  childrenByParent: Map<string, IComment[]>;
  parentId: string;
  pageId: string;
  canComment: boolean;
  canEdit?: boolean;
  userSpaceRole?: string;
}
const ChildComments = ({
  childrenByParent,
  parentId,
  pageId,
  canComment,
  canEdit,
  userSpaceRole,
}: ChildCommentsProps) => {
  const children = childrenByParent.get(parentId) ?? [];

  return (
    <div>
      {children.map((childComment) => (
        <div key={childComment.id}>
          <CommentListItem
            comment={childComment}
            pageId={pageId}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
          />
          <MemoizedChildComments
            childrenByParent={childrenByParent}
            parentId={childComment.id}
            pageId={pageId}
            canComment={canComment}
            canEdit={canEdit}
            userSpaceRole={userSpaceRole}
          />
        </div>
      ))}
    </div>
  );
};

const MemoizedChildComments = memo(ChildComments);

const CommentEditorWithActions = ({
  commentId,
  onSave,
  placeholder = undefined,
}) => {
  const { t } = useTranslation();
  // Lazily mount the TipTap reply editor: until the user interacts with the
  // stub, no editor instance is created for this thread. Once mounted it stays
  // mounted so the draft is preserved.
  const [mounted, setMounted] = useState(false);
  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { ref, focused } = useFocusWithin();
  const commentEditorRef = useRef(null);

  const activate = useCallback(() => setMounted(true), []);

  const handleSave = useCallback(async () => {
    try {
      setIsSending(true);
      await onSave(commentId, content);
      setContent("");
      commentEditorRef.current?.clearContent();
    } finally {
      setIsSending(false);
    }
  }, [commentId, content, onSave]);

  if (!mounted) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onFocus={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        style={{
          padding: "6px",
          fontSize: "var(--mantine-font-size-sm)",
          lineHeight: 1.4,
          color: "var(--mantine-color-placeholder)",
          cursor: "text",
          borderRadius: "var(--mantine-radius-sm)",
        }}
      >
        {placeholder || t("Reply...")}
      </div>
    );
  }

  return (
    <div ref={ref}>
      <CommentEditor
        ref={commentEditorRef}
        onUpdate={setContent}
        onSave={handleSave}
        editable={true}
        placeholder={placeholder}
        autofocus={true}
      />
      {focused && <CommentActions onSave={handleSave} isLoading={isSending} />}
    </div>
  );
};

const PageCommentInput = ({ onSave, isLoading }) => {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const { ref, focused } = useFocusWithin();
  const commentEditorRef = useRef(null);
  const [currentUser] = useAtom(currentUserAtom);

  const handleSave = useCallback(() => {
    onSave(null, content);
    setContent("");
    commentEditorRef.current?.clearContent();
  }, [content, onSave]);

  return (
    <div
      ref={ref}
      style={{
        flex: "0 0 auto",
        borderTop: "1px solid var(--mantine-color-default-border)",
        paddingTop: "var(--mantine-spacing-sm)",
        paddingBottom: 10,
        position: "relative",
      }}
    >
      <Group wrap="nowrap" align="flex-start" gap="xs">
        <CustomAvatar
          size="sm"
          avatarUrl={currentUser?.user?.avatarUrl}
          name={currentUser?.user?.name}
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <CommentEditor
            ref={commentEditorRef}
            onUpdate={setContent}
            onSave={handleSave}
            editable={true}
            placeholder={t("Add a comment...")}
            surface="muted"
          />
        </div>
      </Group>
      {focused && (
        <ActionIcon
          variant="filled"
          radius="xl"
          size="sm"
          aria-label={t("Send comment")}
          onClick={handleSave}
          onMouseDown={(e) => e.preventDefault()}
          loading={isLoading}
          style={{ position: "absolute", right: 8, bottom: 15 }}
        >
          <IconArrowUp size={16} />
        </ActionIcon>
      )}
    </div>
  );
};

export default CommentListWithTabs;
