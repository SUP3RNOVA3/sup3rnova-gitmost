import { isChangeOrigin } from "@tiptap/extension-collaboration";

/**
 * Whether a TitleEditor `onUpdate` should drive URL + tree propagation.
 *
 * Only genuine LOCAL edits propagate. Remote/collab-origin Yjs updates
 * (detected via `isChangeOrigin`) are skipped so a remote title change is not
 * re-broadcast back, which would create a feedback loop. A missing transaction
 * is treated as a local edit (propagate).
 *
 * Extracted as a pure helper so the skip decision is unit-testable without
 * mounting the full collaborative editor.
 */
export function shouldPropagateTitleChange(transaction: unknown): boolean {
  return !(
    transaction &&
    isChangeOrigin(transaction as Parameters<typeof isChangeOrigin>[0])
  );
}
