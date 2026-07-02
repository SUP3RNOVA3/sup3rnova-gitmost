import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "@docmost/editor-ext";
import {
  normalizeTableColumnWidths,
  classifyClipboardSelection,
} from "./markdown-clipboard";

// normalizeTableColumnWidths mutates a DOM subtree (jsdom provides document).
function root(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function firstRowColWidths(container: HTMLElement): (string | null)[] {
  const row = container.querySelector("tr");
  return Array.from(row?.children ?? []).map((c) =>
    c.getAttribute("colwidth"),
  );
}

describe("normalizeTableColumnWidths", () => {
  // The core "squash столбцов вставленной таблицы" concern: markdown has no
  // widths, so every pasted table would otherwise render at table-layout:fixed
  // / 100% and squash columns. This stamps an explicit per-column px width.
  it("stamps the default px width on every column when no widths are present", () => {
    const container = root(
      "<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["150", "150", "150"]);
  });

  it("derives column widths from a colgroup", () => {
    const container = root(
      "<table>" +
        '<colgroup><col style="width:200px"><col style="width:80px"></colgroup>' +
        "<tbody><tr><td>a</td><td>b</td></tr></tbody>" +
        "</table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["200", "80"]);
  });

  it("derives column widths from per-cell width attributes", () => {
    const container = root(
      '<table><tbody><tr><td width="120">a</td><td width="90">b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["120", "90"]);
  });

  it("derives column widths from a cell style:width:px", () => {
    const container = root(
      '<table><tbody><tr><td style="width:140px">a</td><td>b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    // First cell width parsed; a fully-unmeasured column is left untouched
    // (the 100 fallback only fills in NULL gaps inside an otherwise-measured
    // multi-column slice, e.g. a colspan).
    expect(firstRowColWidths(container)).toEqual(["140", null]);
  });

  it("fills a null gap inside a measured colspanned slice with 100", () => {
    // colgroup gives [200, null]; the single colspan=2 cell spans both, so its
    // slice is [200, null] -> the null is backfilled to 100 => "200,100".
    const container = root(
      "<table>" +
        '<colgroup><col style="width:200px"><col></colgroup>' +
        '<tbody><tr><td colspan="2">merged</td></tr></tbody>' +
        "</table>",
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["200,100"]);
  });

  it("splits a measured width across a colspanned cell", () => {
    const container = root(
      '<table><tbody><tr><td colspan="2" width="300">merged</td><td width="100">x</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    // 300 / colspan(2) = 150 per underlying column => "150,150" on the merged cell.
    expect(firstRowColWidths(container)).toEqual(["150,150", "100"]);
  });

  it("falls back to the default width per spanned column when nothing is measurable", () => {
    const container = root(
      '<table><tbody><tr><td colspan="2">merged</td><td>x</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["150,150", "150"]);
  });

  it("leaves cells that already have a colwidth untouched", () => {
    const container = root(
      '<table><tbody><tr><td colwidth="42">a</td><td>b</td></tr></tbody></table>',
    );
    normalizeTableColumnWidths(container);
    expect(firstRowColWidths(container)).toEqual(["42", "150"]);
  });

  it("normalizes every table in the subtree", () => {
    const container = root(
      "<table><tbody><tr><td>a</td></tr></tbody></table>" +
        "<table><tbody><tr><td>b</td><td>c</td></tr></tbody></table>",
    );
    normalizeTableColumnWidths(container);
    const tables = container.querySelectorAll("table");
    const widths = Array.from(tables).map((t) =>
      Array.from(t.querySelector("tr")!.children).map((c) =>
        c.getAttribute("colwidth"),
      ),
    );
    expect(widths).toEqual([["150"], ["150", "150"]]);
  });

  it("only annotates the first row (column widths are defined once)", () => {
    const container = root(
      "<table><tbody>" +
        "<tr><td>a</td><td>b</td></tr>" +
        "<tr><td>c</td><td>d</td></tr>" +
        "</tbody></table>",
    );
    normalizeTableColumnWidths(container);
    const rows = container.querySelectorAll("tr");
    expect(
      Array.from(rows[1].children).map((c) => c.getAttribute("colwidth")),
    ).toEqual([null, null]);
  });
});

describe("classifyClipboardSelection", () => {
  it("serializes a list of 2+ items as markdown", () => {
    expect(
      classifyClipboardSelection([{ name: "bulletList", childCount: 2 }]),
    ).toEqual({ asMarkdown: true, wrapBareRows: false });
  });

  it("leaves a single-item list as plain text", () => {
    expect(
      classifyClipboardSelection([{ name: "bulletList", childCount: 1 }]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("serializes a whole table without wrapping bare rows", () => {
    expect(
      classifyClipboardSelection([{ name: "table", childCount: 3 }]),
    ).toEqual({ asMarkdown: true, wrapBareRows: false });
  });

  it("serializes a partial cell selection (bare rows) and flags wrapping", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 2 },
        { name: "tableRow", childCount: 2 },
      ]),
    ).toEqual({ asMarkdown: true, wrapBareRows: true });
  });

  it("leaves plain paragraphs as plain text", () => {
    expect(
      classifyClipboardSelection([{ name: "paragraph", childCount: 1 }]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });

  it("does not wrap when rows are mixed with other block types", () => {
    expect(
      classifyClipboardSelection([
        { name: "tableRow", childCount: 2 },
        { name: "paragraph", childCount: 1 },
      ]),
    ).toEqual({ asMarkdown: false, wrapBareRows: false });
  });
});

// Output-level tests for the table clipboard regression: copying a table must
// yield a real GFM pipe table, NOT one-value-per-line concatenated cells.
// These exercise the actual markdown produced by htmlToMarkdown (the same
// serializer step the clipboardTextSerializer runs), so they pin the OUTPUT
// shape that the classifier-flag tests above do not cover.
describe("table clipboard markdown output (htmlToMarkdown)", () => {
  // Trim each line and drop blanks so structural assertions are whitespace-robust.
  function lines(md: string): string[] {
    return md
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  // A GFM separator row like "| --- | --- |" (any number of columns), tolerant
  // of the padding turndown emits.
  function isSeparatorRow(line: string): boolean {
    const compact = line.replace(/\s+/g, "");
    return /^\|(?:-{3,}\|)+$/.test(compact);
  }

  // Split a pipe-delimited row into trimmed cell values.
  function cells(line: string): string[] {
    return line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  it("serializes a header-less partial cell selection (bare rows) as a valid GFM pipe table", () => {
    // Mirror the serializer's `wrapBareRows` branch exactly: bare <tr> nodes are
    // wrapped in <table><tbody> and htmlToMarkdown(div.innerHTML) is called.
    // See markdown-clipboard.ts clipboardTextSerializer:
    //   const table = document.createElement("table");
    //   const tbody = document.createElement("tbody");
    //   tbody.appendChild(fragment); table.appendChild(tbody);
    //   div.appendChild(table);
    //   return htmlToMarkdown(div.innerHTML);
    const div = document.createElement("div");
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (const [c1, c2] of [
      ["a", "b"],
      ["c", "d"],
    ]) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = c1;
      const td2 = document.createElement("td");
      td2.textContent = c2;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    div.appendChild(table);

    const md = htmlToMarkdown(div.innerHTML);
    const ls = lines(md);

    // Valid GFM: a header/data separator row is present (an empty header is
    // synthesized by the GFM turndown plugin for a header-less table — fine).
    expect(ls.some(isSeparatorRow)).toBe(true);
    // NOT the old broken "one value per line" shape: every line is pipe-delimited
    // and no line is a bare cell value on its own.
    expect(ls.every((l) => l.includes("|"))).toBe(true);
    expect(md).not.toMatch(/^\s*(a|b|c|d)\s*$/m);
    // The cell values land in real pipe-delimited data rows.
    const dataRows = ls.filter((l) => !isSeparatorRow(l)).map(cells);
    expect(dataRows).toContainEqual(["a", "b"]);
    expect(dataRows).toContainEqual(["c", "d"]);
  });

  it("serializes a whole table with a header row as a proper GFM table (headline regression)", () => {
    // Mirror the serializer's non-wrap branch: the full <table> node is appended
    // directly (div.appendChild(fragment)) and htmlToMarkdown(div.innerHTML) runs.
    const div = document.createElement("div");
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const h of ["Name", "Age"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const [name, age] of [
      ["Alice", "30"],
      ["Bob", "25"],
    ]) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = name;
      const td2 = document.createElement("td");
      td2.textContent = age;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    div.appendChild(table);

    const md = htmlToMarkdown(div.innerHTML);
    const ls = lines(md);

    // Proper GFM structure: separator row + all rows pipe-delimited.
    expect(ls.some(isSeparatorRow)).toBe(true);
    expect(ls.every((l) => l.includes("|"))).toBe(true);

    const rows = ls.filter((l) => !isSeparatorRow(l)).map(cells);
    // Header row comes first, followed by both data rows.
    expect(rows[0]).toEqual(["Name", "Age"]);
    expect(rows).toContainEqual(["Alice", "30"]);
    expect(rows).toContainEqual(["Bob", "25"]);
    // Headline regression: the table is NOT concatenated one-value-per-line.
    expect(md).not.toMatch(/^\s*(Name|Age|Alice|Bob|30|25)\s*$/m);
  });
});
