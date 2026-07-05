import { Range } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";

interface TextNodesWithPosition {
  text: string;
  pos: number;
}

/**
 * Shared "find all occurrences of a term in the doc" primitive.
 *
 * Walks every text node of the document and returns each regex match as a
 * `{ from, to }` range. Contiguous text nodes (which may differ only by marks)
 * are concatenated into a single run, so a match that spans e.g. "wo" + bold
 * "rd" is still found; runs are split by any non-text node, so a match never
 * crosses a node boundary. Whitespace-only matches are ignored.
 *
 * This is used by BOTH search-and-replace (highlight/replace) and multi-cursor
 * (turn occurrences into active cursors) so the two stay behaviourally in sync.
 * Extracted verbatim from the original `processSearches` walk.
 */
export function findOccurrences(doc: PMNode, searchTerm: RegExp): Range[] {
  const results: Range[] = [];

  if (!searchTerm) return results;

  let textNodesWithPosition: TextNodesWithPosition[] = [];
  let index = 0;

  doc?.descendants((node, pos) => {
    if (node.isText) {
      if (textNodesWithPosition[index]) {
        textNodesWithPosition[index] = {
          text: textNodesWithPosition[index].text + node.text,
          pos: textNodesWithPosition[index].pos,
        };
      } else {
        textNodesWithPosition[index] = {
          text: `${node.text}`,
          pos,
        };
      }
    } else {
      index += 1;
    }
  });

  textNodesWithPosition = textNodesWithPosition.filter(Boolean);

  for (const element of textNodesWithPosition) {
    const { text, pos } = element;
    const matches = Array.from(text.matchAll(searchTerm)).filter(
      ([matchText]) => matchText.trim(),
    );

    for (const m of matches) {
      if (m[0] === "") break;

      if (m.index !== undefined) {
        results.push({
          from: pos + m.index,
          to: pos + m.index + m[0].length,
        });
      }
    }
  }

  return results;
}
