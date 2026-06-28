import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { FullEditor } from "@/features/editor/full-editor";
import HistoryModal from "@/features/page-history/components/history-modal";
import { Helmet } from "react-helmet-async";
import PageHeader from "@/features/page/components/header/page-header.tsx";
import { extractPageSlugId } from "@/lib";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { useTranslation } from "react-i18next";
import React from "react";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { OfflineFallback } from "@/features/offline/offline-fallback.tsx";
import { IconAlertTriangle, IconFileOff } from "@tabler/icons-react";
import { Button } from "@mantine/core";
import { Link } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
const MemoizedFullEditor = React.memo(FullEditor);
const MemoizedPageHeader = React.memo(PageHeader);
const MemoizedHistoryModal = React.memo(HistoryModal);

export default function Page() {
  const { t } = useTranslation();
  const { pageSlug } = useParams();

  return (
    <ErrorBoundary
      resetKeys={[pageSlug]}
      fallbackRender={({ resetErrorBoundary }) => (
        <EmptyState
          icon={IconAlertTriangle}
          title={t("Failed to load page. An error occurred.")}
          action={
            <Button variant="default" size="sm" mt="xs" onClick={resetErrorBoundary}>
              {t("Try again")}
            </Button>
          }
        />
      )}
    >
      <PageContent pageSlug={pageSlug} />
    </ErrorBoundary>
  );
}

function PageContent({ pageSlug }: { pageSlug: string | undefined }) {
  const { t } = useTranslation();

  const {
    data: page,
    isLoading,
    isError,
    error,
  } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);

  const canEdit = !page?.deletedAt && (page?.permissions?.canEdit ?? false);
  const canComment =
    canEdit ||
    (space?.settings?.comments?.allowViewerComments === true);

  if (isLoading) {
    return <></>;
  }

  if (isError || !page) {
    // An offline fetch of a page that was never saved for offline use yields a
    // network error with NO HTTP status (status is undefined), which would
    // otherwise fall through to the generic "Error fetching page data." state.
    // When we are offline (or the failure is a network error with no status),
    // show the dedicated "You're offline — this page isn't saved for offline"
    // fallback instead, so the user understands why the page won't load.
    const httpStatus = error?.["status"];
    const isOffline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    if (isOffline || (isError && httpStatus == null)) {
      return <OfflineFallback />;
    }
    if ([401, 403, 404].includes(httpStatus)) {
      return (
        <EmptyState
          icon={IconFileOff}
          title={t("Page not found")}
          description={t(
            "This page may have been deleted, moved, or you may not have access.",
          )}
          action={
            <Button component={Link} to="/home" variant="default" size="sm" mt="xs">
              {t("Go to homepage")}
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        icon={IconFileOff}
        title={t("Error fetching page data.")}
      />
    );
  }

  if (!space) {
    return <></>;
  }

  return (
    page && (
      <div>
        <Helmet>
          <title>{`${page?.icon || ""}  ${page?.title || t("Untitled")}`}</title>
        </Helmet>

        <MemoizedPageHeader readOnly={!canEdit} />

        <MemoizedFullEditor
          key={page.id}
          pageId={page.id}
          title={page.title}
          content={page.content}
          slugId={page.slugId}
          spaceSlug={page?.space?.slug}
          editable={canEdit}
          creator={page.creator}
          contributors={page.contributors}
          canComment={canComment}
        />
        <MemoizedHistoryModal pageId={page.id} />
      </div>
    )
  );
}
