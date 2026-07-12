import { Modal, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms";
import HistoryModalDesktop from "@/features/page-history/components/history-modal-desktop";
import HistoryModalMobile from "@/features/page-history/components/history-modal-mobile";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "@mantine/hooks";

interface Props {
  pageId: string;
  pageTitle?: string;
}

export default function HistoryModal({ pageId, pageTitle }: Props) {
  const { t } = useTranslation();
  const [isModalOpen, setModalOpen] = useAtom(historyAtoms);
  const isMobile = useMediaQuery("(max-width: 800px)");

  if (isMobile) {
    return (
      <Modal.Root
        opened={isModalOpen}
        onClose={() => setModalOpen(false)}
        fullScreen
        aria-label={t("Page history")}
      >
        <Modal.Overlay />
        <Modal.Content style={{ overflow: "hidden" }}>
          <Modal.Header>
            <Modal.Title>
              <Text size="md" fw={500}>
                {t("Page history")}
              </Text>
            </Modal.Title>
            <Modal.CloseButton aria-label={t("Close")} />
          </Modal.Header>
          <Modal.Body
            p={0}
            style={{ height: "calc(100vh - 60px)", overflow: "hidden" }}
          >
            <HistoryModalMobile pageId={pageId} pageTitle={pageTitle} />
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    );
  }

  // #568 — the redesigned desktop window carries its OWN single-row header
  // (title + selected label + diff nav + Restore + close), so the Modal chrome is
  // dropped for desktop and the body renders edge-to-edge.
  return (
    <Modal.Root
      size={1400}
      opened={isModalOpen}
      onClose={() => setModalOpen(false)}
      aria-label={t("Page history")}
    >
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Body p={0}>
          <HistoryModalDesktop
            pageId={pageId}
            onClose={() => setModalOpen(false)}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
