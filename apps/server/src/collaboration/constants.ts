export const HISTORY_INTERVAL = 5 * 60 * 1000;
export const HISTORY_FAST_INTERVAL = 60 * 1000;
export const HISTORY_FAST_THRESHOLD = 5 * 60 * 1000;

// Redis pub/sub channel that bridges a PAGE_UPDATED tree snapshot (a title/icon
// rename) from the standalone collab process to the API process, which is the
// single broadcast authority. Imported by both halves of the bridge:
// PageTreeBridgePublisher (collab process) and PageTreeBridgeSubscriber (API process).
export const COLLAB_TREE_UPDATE_CHANNEL = 'collab:tree-update';
