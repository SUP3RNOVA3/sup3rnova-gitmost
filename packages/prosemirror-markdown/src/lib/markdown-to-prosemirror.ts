/**
 * Pure markdown -> ProseMirror conversion.
 *
 * The converter path is `markdownToProseMirror` (marked -> HTML ->
 * generateJSON) plus the two pre/post processors it needs (`preprocessCallouts`,
 * `bridgeTaskLists`). The gitmost server writes the resulting page bodies
 * natively through the collab gateway, so no websocket/Yjs write-path lives
 * here.
 */
import { generateJSON } from "@tiptap/html";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { docmostExtensions } from "./docmost-schema.js";
import { parseAttachedComment } from "./attached-comment.js";

// Setup DOM environment for Tiptap HTML parsing in Node.js
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
global.window = dom.window as any;
global.document = dom.window.document;
// @ts-ignore
global.Element = dom.window.Element;

/**
 * Hard ceiling above which we skip callout preprocessing entirely. The linear
 * scanner below has no quadratic blow-up, but we still cap input defensively so
 * a pathological multi-megabyte payload cannot tie up the event loop; in that
 * case the markdown is passed through verbatim (callouts are simply not
 * detected) rather than risking a slow scan.
 */
const MAX_CALLOUT_PREPROCESS_BYTES = 4 * 1024 * 1024; // 4 MB

/** Matches an opening callout fence: `:::type` (type captured, lower-cased). */
const CALLOUT_OPEN_RE = /^:::\s*(\w+)\s*$/;
/** Matches a bare closing callout fence: `:::`. */
const CALLOUT_CLOSE_RE = /^:::\s*$/;
/**
 * Matches an Obsidian-native callout opener: `> [!type]` (type captured). An
 * optional title after the type is allowed but ignored (the Docmost callout
 * schema has no title). The body is the following contiguous blockquote lines.
 */
const CALLOUT_BQ_OPEN_RE = /^>\s*\[!(\w+)\]/;
/** Matches any blockquote continuation line (`>` … ). */
const BLOCKQUOTE_LINE_RE = /^>/;
/** Matches the start/end of a code fence (``` or ~~~), capturing the marker. */
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Pre-process Docmost-flavoured markdown: convert `:::type ... :::`
 * callout blocks (the syntax our markdown export produces) into HTML
 * divs that the callout extension parses. The inner content is rendered
 * through marked as regular markdown.
 *
 * Implemented as a single linear pass over the lines (no quadratic regex
 * rescan). It:
 *   - tracks fenced code regions (```...``` and ~~~...~~~) and never treats a
 *     `:::` line that lives inside a code fence as a callout delimiter, so a
 *     callout body that itself contains a fenced code block with a `:::` line is
 *     no longer corrupted;
 *   - matches an opening `:::type` line with the next CLOSING `:::` at the SAME
 *     nesting level, supporting NESTED callouts via a depth counter (an inner
 *     `:::type` opens a deeper level and consumes a matching `:::`);
 *   - emits the same `<div data-type="callout" data-callout-type="TYPE">` output
 *     (inner rendered through marked) as the previous regex implementation.
 */
async function preprocessCallouts(markdown: string): Promise<string> {
  // Defensive cap: skip preprocessing for pathologically large inputs.
  if (markdown.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return markdown;
  }

  // Recursively transform a slice of lines, converting top-level callouts in
  // that slice into <div> blocks and rendering their inner content (which may
  // itself contain nested callouts) through this same function.
  const transform = async (lines: string[]): Promise<string> => {
    const out: string[] = [];
    let inCodeFence = false;
    let codeFenceMarker = ""; // the exact run of backticks/tildes that opened it
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Inside a code fence, only its matching closing fence is significant;
      // everything else (including `:::` lines) is copied through verbatim.
      if (inCodeFence) {
        out.push(line);
        const fence = line.match(CODE_FENCE_RE);
        if (fence && fence[2].startsWith(codeFenceMarker[0]) &&
            fence[2].length >= codeFenceMarker.length) {
          inCodeFence = false;
          codeFenceMarker = "";
        }
        i++;
        continue;
      }

      // A code fence opening outside any callout body: enter code-fence mode.
      const fenceOpen = line.match(CODE_FENCE_RE);
      if (fenceOpen) {
        inCodeFence = true;
        codeFenceMarker = fenceOpen[2];
        out.push(line);
        i++;
        continue;
      }

      // An opening callout fence: scan forward (with code-fence and nested
      // callout awareness) for its matching closing `:::` at the same level.
      const open = line.match(CALLOUT_OPEN_RE);
      if (open) {
        const type = open[1].toLowerCase();
        const bodyLines: string[] = [];
        let depth = 1;
        let innerInCodeFence = false;
        let innerCodeFenceMarker = "";
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bl = lines[j];
          if (innerInCodeFence) {
            const f = bl.match(CODE_FENCE_RE);
            if (f && f[2].startsWith(innerCodeFenceMarker[0]) &&
                f[2].length >= innerCodeFenceMarker.length) {
              innerInCodeFence = false;
              innerCodeFenceMarker = "";
            }
            bodyLines.push(bl);
            continue;
          }
          const innerFence = bl.match(CODE_FENCE_RE);
          if (innerFence) {
            innerInCodeFence = true;
            innerCodeFenceMarker = innerFence[2];
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_OPEN_RE.test(bl)) {
            depth++;
            bodyLines.push(bl);
            continue;
          }
          if (CALLOUT_CLOSE_RE.test(bl)) {
            depth--;
            if (depth === 0) break; // matching close for THIS callout
            bodyLines.push(bl);
            continue;
          }
          bodyLines.push(bl);
        }

        if (j < lines.length) {
          // Found the matching closing fence: render the body (recursively, so
          // nested callouts are handled) and emit the callout div.
          const inner = await transform(bodyLines);
          const renderedInner = await marked.parse(inner);
          out.push(
            `\n<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>\n`,
          );
          i = j + 1; // skip past the closing `:::`
          continue;
        }
        // No matching close (unterminated callout): treat the opener as a
        // literal line and continue, preserving the original text.
        out.push(line);
        i++;
        continue;
      }

      // An Obsidian-native callout: `> [!type]` opener; the body is the following
      // CONTIGUOUS blockquote (`>`-prefixed) lines. Strip ONE blockquote level and
      // recurse so nested callouts (`> > [!type]`) are handled, then emit the same
      // callout div the `:::` path produces. A normal blockquote (no `[!type]` on
      // its first line) does not match and stays a blockquote.
      const bqOpen = line.match(CALLOUT_BQ_OPEN_RE);
      if (bqOpen) {
        const type = bqOpen[1].toLowerCase();
        const bodyLines: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (!BLOCKQUOTE_LINE_RE.test(lines[j])) break;
          bodyLines.push(lines[j].replace(/^>\s?/, ""));
        }
        const inner = await transform(bodyLines);
        const renderedInner = await marked.parse(inner);
        out.push(
          `\n<div data-type="callout" data-callout-type="${type}">${renderedInner}</div>\n`,
        );
        i = j;
        continue;
      }

      out.push(line);
      i++;
    }

    return out.join("\n");
  };

  return transform(markdown.split("\n"));
}

/**
 * Bridge marked's checkbox lists to TipTap task lists.
 *
 * marked renders GitHub task list items (`- [x] done`) as a plain
 * `<ul><li><p><input type="checkbox" checked> text</p></li></ul>` WITHOUT the
 * markup TipTap's TaskList/TaskItem extensions parse. This rewrites such lists
 * into the shape those extensions expect:
 *   TaskList parseHTML matches `ul[data-type="taskList"]`,
 *   TaskItem matches `li[data-type="taskItem"]`,
 *   the checked state is read from `data-checked === "true"`.
 *
 * A list is only converted when it has at least one `<li>` and EVERY direct
 * `<li>` contains a checkbox input. Both `<ul>` and `<ol>` are considered: a
 * numbered checklist (`1. [x] a`, which marked renders as an `<ol>` of checkbox
 * `<li>`s) would otherwise lose its task state. TipTap task lists are unordered,
 * so a matching `<ol>` is emitted as `data-type="taskList"` exactly like a
 * `<ul>`. Mixed or ordinary lists (including ordinary `<ol>` lists) are left
 * untouched so they keep rendering as bullet/numbered lists. The marked `<p>`
 * wrapper is kept inside the `<li>` because TaskItem content allows paragraphs.
 */
function bridgeTaskLists(html: string): string {
  // Cheap early-out: if the markup contains no checkbox input at all there is
  // nothing to bridge, so skip the expensive JSDOM parse entirely. This is the
  // common case (most pages have no task lists).
  if (!/type=["']?checkbox/i.test(html)) {
    return html;
  }
  // Defensive cap (consistent with preprocessCallouts): skip the bridge for
  // pathologically large inputs rather than running a second expensive JSDOM
  // parse on a multi-megabyte payload. The markup is passed through verbatim.
  if (html.length > MAX_CALLOUT_PREPROCESS_BYTES) {
    return html;
  }
  const dom = new JSDOM(html);
  const document = dom.window.document;
  // Collect the checkbox(es) that belong to THIS <li> directly: either direct
  // child <input type="checkbox"> elements or ones inside the <li>'s direct <p>
  // child (the shape marked emits: `<li><p><input type="checkbox"> text</p></li>`).
  // Checkboxes nested deeper (e.g. inside a child <ul>/<ol>) are excluded so a
  // bullet <li> that merely contains a nested task sublist is not misdetected.
  // Raw inline HTML can put more than one checkbox in a single <li>; we gather
  // ALL of them so none survive into the converted item.
  const directCheckboxes = (li: Element): Element[] => {
    const found: Element[] = [];
    for (const child of Array.from(li.children)) {
      if (
        child.tagName === "INPUT" &&
        child.getAttribute("type") === "checkbox"
      ) {
        found.push(child);
        continue;
      }
      if (child.tagName === "P") {
        for (const inp of Array.from(
          child.querySelectorAll(":scope > input[type='checkbox']"),
        )) {
          found.push(inp);
        }
      }
    }
    return found;
  };
  // Both <ul> and <ol> are candidates: an <ol> whose every direct <li> carries
  // its own checkbox is a numbered checklist that must also become a taskList.
  const lists = Array.from(document.querySelectorAll("ul, ol"));
  for (const list of lists) {
    // Only consider DIRECT child <li> elements; nested lists are handled by
    // their own iteration of the outer loop.
    const items = Array.from(list.children).filter(
      (child) => child.tagName === "LI",
    );
    if (items.length === 0) continue;
    const itemCheckboxes = items.map((li) => directCheckboxes(li));
    // Convert only when every direct <li> carries at least one OWN checkbox.
    if (!itemCheckboxes.every((boxes) => boxes.length > 0)) continue;

    // A numbered checklist arrives as an <ol>. We must NOT leave the tag as
    // <ol> while tagging it data-type="taskList": generateJSON would then match
    // BOTH the orderedList rule (tag ol) and the taskList rule (data-type),
    // emitting a phantom empty orderedList beside the real taskList. So rename a
    // qualifying <ol> to a <ul> — move its <li> children over and replace it —
    // leaving only the taskList rule to match. Already-<ul> lists are unchanged.
    let target: Element = list;
    if (list.tagName === "OL") {
      const ul = document.createElement("ul");
      // Carry over existing attributes (e.g. class) so nothing is silently lost.
      for (const attr of Array.from(list.attributes)) {
        ul.setAttribute(attr.name, attr.value);
      }
      // Move every child node (including the <li>s we collected) into the <ul>.
      while (list.firstChild) {
        ul.appendChild(list.firstChild);
      }
      list.replaceWith(ul);
      target = ul;
    }

    target.setAttribute("data-type", "taskList");
    items.forEach((li, index) => {
      const boxes = itemCheckboxes[index];
      // The first checkbox determines the checked state (matches the previous
      // single-checkbox behaviour); any extras only need removing.
      const input = boxes[0] ?? null;
      li.setAttribute("data-type", "taskItem");
      const checked =
        input != null &&
        (input.hasAttribute("checked") || (input as any).checked);
      li.setAttribute("data-checked", checked ? "true" : "false");
      // Remove ALL direct checkbox inputs so none survive into the content
      // (a raw-inline-HTML <li> may carry more than one).
      for (const box of boxes) {
        box.remove();
      }
    });
  }
  return document.body.innerHTML;
}

/**
 * Re-apply ATTACHED HTML comments (#293 canon) before the DOM/generateJSON
 * stage drops them.
 *
 * The serializer appends attributes that have no native markdown syntax as a
 * trailing `<!--name {json}-->` comment on the block's line (see
 * attached-comment.ts). `marked` keeps that comment as an HTML comment NODE
 * inside the block element (`<p>text <!--attrs {…}--></p>`), but the next stage
 * (parse5/jsdom via generateJSON) discards comment nodes, so the attributes
 * would be lost. This pass runs on the post-`marked` HTML: for every attached
 * comment it re-expresses the encoded attributes in a form the schema's
 * parseHTML already understands, then removes the comment so it cannot leak.
 *
 * This pass materializes BOTH comment conventions, discriminated by position:
 *
 *   - ATTACHED comments (#9 `attrs`): a comment sitting INSIDE a `<p>`/`<hN>`
 *     (same rendered line as visible content). The only handled key is
 *     `textAlign`, re-expressed as an inline `text-align` style on the parent,
 *     which the docmost-schema textAlign global attribute reads back.
 *   - STANDALONE machinery comments (#5 `subpages`/`pagebreak`): a lone comment
 *     line, which `marked` renders as an HTML block so jsdom makes it a DIRECT
 *     child of `<body>`. These are replaced with the schema-matching block div
 *     (`<div data-type="pageBreak">` / `<div data-type="subpages" [data-recursive]>`)
 *     that the schema's parseHTML rebuilds into the atom.
 *
 * Position determines legality: an `attrs` comment is honored only in attached
 * position, a `subpages`/`pagebreak` comment only in standalone position; a
 * comment in the wrong position is left INERT (generateJSON drops it). Fail-open
 * everywhere: a malformed comment (null from parseAttachedComment), an unknown
 * name, a wrong-position comment, or an unknown/empty attr value is ignored.
 * Future decisions (#4/#8) extend the per-name handling here without changing
 * the parse primitive.
 */
function applyCommentDirectives(html: string): string {
  // Cheap early-out: no comments at all -> nothing to intercept.
  if (!html.includes("<!--")) return html;
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const nodeFilter = dom.window.NodeFilter;
  // Walk the WHOLE document, not just <body>: when a standalone machinery
  // comment is the FIRST thing in the output (before any body content), the
  // HTML parser places it at document level (a child of `#document`, before
  // `<html>`), where it is outside `document.body` and would be lost. Attached
  // attrs comments always live inside body, so this wider walk still finds them.
  const walker = document.createTreeWalker(document, nodeFilter.SHOW_COMMENT);
  const comments: any[] = [];
  let current: any;
  while ((current = walker.nextNode())) comments.push(current);

  // Standalone machinery comments that were parsed at document level (leading,
  // before body content) must be MOVED into body — in document order — since we
  // return `document.body.innerHTML`. Because the parser only puts LEADING
  // comments at document level, prepending them to body preserves global order.
  const leadingDivs: any[] = [];

  for (const comment of comments) {
    const parsed = parseAttachedComment(comment.data);
    if (!parsed) continue; // malformed -> inert (dropped by generateJSON)
    const parent = comment.parentElement as any;
    const tag = String(parent?.tagName || "").toLowerCase();

    if (parsed.name === "subpages" || parsed.name === "pagebreak") {
      // #293 canon #5 STANDALONE machinery. A lone comment line is rendered by
      // marked as an HTML block; the parser places it either directly under
      // <body> (when other content surrounds it) or at document level (when it
      // leads the output). Both are STANDALONE position. A `subpages`/`pagebreak`
      // comment sitting inside a `<p>`/`<hN>` (or any other element) is attached
      // position -> INERT.
      const standalone = tag === "" || tag === "body" || tag === "html";
      if (!standalone) continue; // wrong position -> inert
      const div = document.createElement("div");
      if (parsed.name === "pagebreak") {
        div.setAttribute("data-type", "pageBreak");
      } else {
        div.setAttribute("data-type", "subpages");
        if (parsed.attrs.recursive === true) {
          div.setAttribute("data-recursive", "true");
        }
      }
      if (tag === "body") {
        // In-body: replace in place so surrounding content keeps its order.
        comment.replaceWith(div);
      } else {
        // Document-level (leading): drop the stray comment and queue the div to
        // be prepended into body below.
        comment.remove();
        leadingDivs.push(div);
      }
      continue;
    }

    if (!parent) continue; // attrs comment must have an element parent
    if (parsed.name !== "attrs") continue; // unknown name -> inert
    // #293 canon #9 ATTACHED attrs: honored only in attached position.
    const isBlock = tag === "p" || /^h[1-6]$/.test(tag);
    if (!isBlock) continue; // misplaced comment -> inert
    const align = parsed.attrs.textAlign;
    if (typeof align === "string" && align) {
      // Re-express as an inline style; the schema's textAlign parseHTML reads
      // `el.style.textAlign` back onto the paragraph/heading node.
      parent.style.textAlign = align;
    }
    // Consume the marker regardless (unknown keys are simply ignored) so no
    // attached comment ever survives into the parsed body.
    comment.remove();
  }
  // Prepend any document-level (leading) standalone divs into body, preserving
  // their document order relative to each other and ahead of existing content.
  for (let i = leadingDivs.length - 1; i >= 0; i--) {
    document.body.insertBefore(leadingDivs[i], document.body.firstChild);
  }
  return document.body.innerHTML;
}

/**
 * Recursively strip content-less paragraph nodes from a generated doc.
 *
 * A block-level atom whose markdown form is INLINE (e.g. the block `image`'s
 * `![](url)`, or a bare media element) is wrapped by marked in a <p>; the schema
 * then HOISTS the block atom out of that paragraph, leaving an EMPTY paragraph
 * sibling. On the next export that empty `<p>` renders to "" and the doc "\n\n"
 * join injects a phantom blank gap, so the markdown is not byte-stable.
 *
 * Markdown blank lines are separators, never content, so generateJSON only ever
 * produces an empty paragraph as such a hoist artifact — removing them is safe
 * and general (it also subsumes the <div>-wrapper workaround the `video` case
 * uses). We remove ONLY `type === 'paragraph'` nodes whose `content` is absent
 * or an empty array; every other node (including atoms without `content`) is
 * preserved, and we recurse into the content of any node that has children.
 */
function stripEmptyParagraphs(node: any): any {
  if (!node || !Array.isArray(node.content)) {
    // Atom / leaf node (no children to recurse into): keep as-is.
    return node;
  }
  const mapped = node.content.map((child: any) => stripEmptyParagraphs(child));
  const isEmptyParagraph = (child: any): boolean =>
    !!child &&
    child.type === "paragraph" &&
    (!Array.isArray(child.content) || child.content.length === 0);
  const filtered = mapped.filter((child: any) => !isEmptyParagraph(child));
  // Schema-validity guard: several nodes require NON-empty block content
  // (`content: "block+"` — tableCell, tableHeader, blockquote, column, callout,
  // and the doc root). For an empty one of those, generateJSON materializes a
  // single empty paragraph as its OBLIGATORY content — that is not a hoist
  // artifact. If stripping would empty the container, keep ONE empty paragraph
  // so the result stays schema-valid (an empty cell/quote must not become `[]`).
  const cleaned =
    filtered.length === 0 && mapped.length > 0 ? [mapped[0]] : filtered;
  return { ...node, content: cleaned };
}

/** Convert markdown to a ProseMirror doc using the full Docmost schema. */
export async function markdownToProseMirror(
  markdownContent: string,
): Promise<any> {
  const withCallouts = await preprocessCallouts(markdownContent);
  const html = await marked.parse(withCallouts);
  // Materialize comment directives (#293 #9 attached textAlign; #5 standalone
  // subpages/pageBreak) while the comment nodes still exist, before generateJSON
  // drops them.
  const withAttrs = applyCommentDirectives(html);
  const bridged = bridgeTaskLists(withAttrs);
  const doc = generateJSON(bridged, docmostExtensions);
  return stripEmptyParagraphs(doc);
}
