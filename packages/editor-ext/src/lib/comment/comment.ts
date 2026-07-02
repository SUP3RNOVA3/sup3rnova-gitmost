import { Mark, mergeAttributes } from "@tiptap/core";
import { commentDecoration } from "./comment-decoration";
import { Plugin } from "@tiptap/pm/state";

export interface ICommentOptions {
  HTMLAttributes: Record<string, any>;
}

export interface ICommentStorage {
  activeCommentId: string | null;
}

export const commentMarkClass = "comment-mark";
export const commentDecorationMetaKey = "decorateComment";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    comment: {
      setCommentDecoration: () => ReturnType;
      unsetCommentDecoration: () => ReturnType;
      setComment: (commentId: string) => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
      setCommentResolved: (commentId: string, resolved: boolean) => ReturnType;
    };
  }
}

export const Comment = Mark.create<ICommentOptions, ICommentStorage>({
  name: "comment",
  exitable: true,
  inclusive: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addStorage() {
    return {
      activeCommentId: null,
    };
  },

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment-id"),
        renderHTML: (attributes) => {
          if (!attributes.commentId) return;

          return {
            "data-comment-id": attributes.commentId,
          };
        },
      },
      resolved: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-resolved"),
        renderHTML: (attributes) => {
          if (!attributes.resolved) return {};

          return {
            "data-resolved": "true",
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-comment-id]",
        getAttrs: (el) => {
          const element = el as HTMLSpanElement;
          const commentId = element.getAttribute("data-comment-id")?.trim();
          const resolved = element.hasAttribute("data-resolved");

          if (!commentId) return false;

          return {
            commentId,
            resolved,
          };
        },
      },
    ];
  },

  addCommands() {
    return {
      setCommentDecoration:
        () =>
        ({ tr, dispatch }) => {
          tr.setMeta(commentDecorationMetaKey, true);
          if (dispatch) dispatch(tr);
          return true;
        },
      unsetCommentDecoration:
        () =>
        ({ tr, dispatch }) => {
          tr.setMeta(commentDecorationMetaKey, false);
          if (dispatch) dispatch(tr);
          return true;
        },
      setComment:
        (commentId) =>
        ({ commands }) => {
          if (!commentId) return false;
          // Just add the new mark, do not remove existing ones
          return commands.setMark(this.name, { commentId, resolved: false });
        },
      unsetComment:
        (commentId) =>
        ({ tr, dispatch }) => {
          if (!commentId) return false;

          tr.doc.descendants((node, pos) => {
            const from = pos;
            const to = pos + node.nodeSize;

            const commentMark = node.marks.find(
              (mark) =>
                mark.type.name === this.name &&
                mark.attrs.commentId === commentId
            );

            if (commentMark) {
              tr = tr.removeMark(from, to, commentMark);
            }
          });

          return dispatch?.(tr);
        },
      setCommentResolved:
        (commentId, resolved) =>
        ({ tr, dispatch }) => {
          if (!commentId) return false;

          tr.doc.descendants((node, pos) => {
            const from = pos;
            const to = pos + node.nodeSize;

            const commentMark = node.marks.find(
              (mark) =>
                mark.type.name === this.name &&
                mark.attrs.commentId === commentId
            );

            if (commentMark) {
              // Remove the existing mark and add a new one with updated resolved state
              tr = tr.removeMark(from, to, commentMark);
              tr = tr.addMark(
                from,
                to,
                this.type.create({
                  commentId: commentMark.attrs.commentId,
                  resolved: resolved,
                })
              );
            }
          });

          return dispatch?.(tr);
        },
    };
  },

  renderHTML({ HTMLAttributes }) {
    const commentId = HTMLAttributes?.["data-comment-id"] || null;
    const resolved = HTMLAttributes?.["data-resolved"] || false;

    // Prefer the static array (DOMOutputSpec) form whenever we are NOT in a real
    // interactive browser. Guarding only on `document`/`window` is insufficient
    // on the server: `generateHTML()` runs under a DOM shim (happy-dom/jsdom) that
    // DEFINES both globals, so the imperative `document.createElement` branch ran
    // server-side and its live node + addEventListener crashed the shim's
    // DOMSerializer ("Cannot read properties of undefined (reading 'length')"),
    // turning every Export / copy-as-markdown of a page with an inline comment
    // into an HTTP 500 (QA GS-EXPORT-500). A real browser has a non-empty
    // navigator.userAgent; the SSR shims do not — route the server to the safe
    // static form while keeping the clickable node in the actual editor.
    const isInteractiveBrowser =
      typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof navigator.userAgent === "string" &&
      // Real browsers ALL carry "Mozilla" in the UA string (historical); the
      // server-side DOM shim used by generateHTML() does not (e.g. "Node.js/22").
      // This keeps the interactive click node ONLY in a true browser and routes
      // the server to the crash-free static form.
      navigator.userAgent.includes("Mozilla");
    if (!isInteractiveBrowser) {
      return [
        "span",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          class: resolved ? "comment-mark resolved" : "comment-mark",
          "data-comment-id": commentId,
          ...(resolved && { "data-resolved": "true" }),
        }),
        0,
      ];
    }

    const elem = document.createElement("span");

    Object.entries(
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
    ).forEach(([attr, val]) => elem.setAttribute(attr, val));

    // Add resolved class if the comment is resolved
    if (resolved) {
      elem.classList.add("resolved");
    }

    elem.addEventListener("click", (e) => {
      const selection = document.getSelection();
      if (selection.type === "Range") return;

      this.storage.activeCommentId = commentId;
      const commentEventClick = new CustomEvent("ACTIVE_COMMENT_EVENT", {
        bubbles: true,
        detail: { commentId, resolved },
      });

      elem.dispatchEvent(commentEventClick);
    });

    return elem;
  },

  addProseMirrorPlugins(): Plugin[] {
    return [commentDecoration()];
  },
});
