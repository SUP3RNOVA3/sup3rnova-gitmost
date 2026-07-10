// draw.io (mxGraph) XML support for the MCP drawio tools (issue #423, stage 1).
//
// This module owns everything that is pure data-plumbing for draw.io diagrams:
//   - the DECODE CHAIN that turns a stored `diagram.drawio.svg` attachment back
//     into mxGraph XML (handles both the plain nested-XML form Docmost writes
//     and draw.io's own COMPRESSED `<diagram>` payload — base64 + raw-deflate);
//   - the ENCODE side that wraps mxGraph XML into the `.drawio.svg` attachment
//     using the exact same contract as the import service's createDrawioSvg;
//   - a deterministic LINTER that rejects the structural mistakes generators
//     make before anything is written (each violation carries the offending
//     cellId + position so the model can auto-retry);
//   - a stable HASH over the normalized XML, used as the optimistic-lock key.
//
// HARD CONSTRAINT: no backend rendering. Nothing here shells out or renders a
// bitmap; the only runtime dependencies are jsdom (already used across this
// package for XML parsing) and pako (raw-inflate for the compressed format).

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import pako from "pako";

// --- shared XML parser -----------------------------------------------------

// A single reusable JSDOM window; constructing one per parse is wasteful and
// these tools are low-frequency. Only the DOMParser is used.
let _window: any = null;
function xmlWindow(): any {
  if (!_window) _window = new JSDOM("").window;
  return _window;
}

/** Default mxGraphModel attributes used when the server wraps a cell list. */
const DEFAULT_MODEL_ATTRS =
  'dx="0" dy="0" grid="1" gridSize="10" page="1" pageWidth="850" pageHeight="1100"';

// --- structured lint errors ------------------------------------------------

export interface DrawioLintIssue {
  /** Machine-readable rule id, e.g. "edge-geometry". */
  rule: string;
  /** Human-readable explanation the model can act on. */
  message: string;
  /** The offending cell's id, when the rule is cell-scoped. */
  cellId?: string;
  /** Extra location info: cell index in <root>, or a parser line:col. */
  position?: string;
}

/**
 * Thrown by the linter and by decode/prepare when the input is unusable. Carries
 * the full list of issues so the caller can surface a structured tool-error the
 * model auto-retries against.
 */
export class DrawioLintError extends Error {
  issues: DrawioLintIssue[];
  constructor(issues: DrawioLintIssue[]) {
    const summary = issues
      .map((i) => {
        const where = [
          i.cellId != null ? `cellId=${i.cellId}` : null,
          i.position != null ? `at ${i.position}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return `[${i.rule}] ${i.message}${where ? ` (${where})` : ""}`;
      })
      .join("; ");
    super(`drawio lint failed: ${summary}`);
    this.name = "DrawioLintError";
    this.issues = issues;
  }
}

// --- parsed-cell model -----------------------------------------------------

export interface DrawioGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  relative: boolean;
  hasGeometry: boolean;
}

export interface DrawioCell {
  id: string;
  parent?: string;
  source?: string;
  target?: string;
  vertex: boolean;
  edge: boolean;
  value: string;
  style: string;
  styleMap: Record<string, string>;
  /** Non-key/value leading token of the style (a base stylename), if any. */
  baseStyle?: string;
  geometry: DrawioGeometry;
}

export interface DrawioBBox {
  width: number;
  height: number;
}

// --- style parsing ---------------------------------------------------------

/**
 * Parse a draw.io style string into { baseStyle, map }. Grammar:
 *   [stylename;]key=value;key=value;...
 * A single leading token without '=' is the base stylename (e.g. "text" or
 * "ellipse"). Every other non-empty segment must be exactly one key=value pair.
 * Returns `null` (the segment index) on the first malformed segment so the
 * linter can report a precise error.
 */
export function parseStyle(
  style: string,
): { baseStyle?: string; map: Record<string, string>; badSegment?: string } {
  const map: Record<string, string> = {};
  let baseStyle: string | undefined;
  const segments = style.split(";");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].trim();
    if (seg === "") continue; // trailing/empty segments are fine
    const eq = seg.indexOf("=");
    if (eq === -1) {
      // A bare token is only valid as the FIRST meaningful segment (base style).
      if (baseStyle === undefined && Object.keys(map).length === 0) {
        baseStyle = seg;
        continue;
      }
      return { baseStyle, map, badSegment: seg };
    }
    // A second '=' inside the same segment is malformed.
    if (seg.indexOf("=", eq + 1) !== -1) {
      return { baseStyle, map, badSegment: seg };
    }
    const key = seg.slice(0, eq).trim();
    const val = seg.slice(eq + 1).trim();
    if (key === "") return { baseStyle, map, badSegment: seg };
    map[key] = val;
  }
  return { baseStyle, map };
}

// --- low-level XML helpers -------------------------------------------------

function parseXml(xml: string): { doc: any; error: string | null } {
  const parser = new (xmlWindow().DOMParser)();
  const doc = parser.parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror");
  if (err.length > 0) {
    // jsdom prefixes the message with "line:col:" — keep it as the position.
    return { doc, error: (err[0].textContent || "malformed XML").trim() };
  }
  return { doc, error: null };
}

function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract the raw `<mxGraphModel …>…</mxGraphModel>` substring, or null. */
function sliceModel(xml: string): string | null {
  const open = xml.indexOf("<mxGraphModel");
  if (open === -1) return null;
  const close = xml.indexOf("</mxGraphModel>", open);
  if (close === -1) {
    // Self-closed empty model, e.g. `<mxGraphModel .../>`.
    const selfClose = xml.indexOf("/>", open);
    if (selfClose !== -1) return xml.slice(open, selfClose + 2);
    return null;
  }
  return xml.slice(open, close + "</mxGraphModel>".length);
}

// --- decode chain ----------------------------------------------------------

/**
 * Read the `content=` attribute out of a `.drawio.svg` string. Docmost stores a
 * base64 payload there (createDrawioSvg); draw.io's own SVG export may store the
 * XML entity-encoded instead. The DOM decodes entities for us, so the caller
 * only has to distinguish "starts with '<'" (raw XML) from base64.
 */
export function extractContentAttr(svg: string): string {
  const { doc, error } = parseXml(svg);
  if (!error) {
    const root = doc.documentElement;
    if (root && root.hasAttribute && root.hasAttribute("content")) {
      return root.getAttribute("content") || "";
    }
  }
  // Fallback for a malformed wrapper: pull the attribute directly. The content
  // value itself never contains a double-quote (base64 / entity-encoded XML).
  const m = /content="([^"]*)"/.exec(svg);
  if (m) {
    // Decode the handful of XML entities a raw regex would leave encoded.
    return m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  throw new Error("drawio: SVG has no content= attribute to decode");
}

/**
 * Turn a decoded draw.io file (`<mxfile>` or a bare `<mxGraphModel>`, possibly
 * with a COMPRESSED `<diagram>` payload) into the mxGraphModel XML. For the
 * plain form the raw substring is returned verbatim so a round-trip stays
 * byte-stable; the compressed form is inflated (base64 → raw-deflate →
 * decodeURIComponent), which is how draw.io stores diagrams by default.
 */
export function decodeDrawioFileToModel(fileXml: string): string {
  // Plain, nested XML: return the model substring untouched (byte-stable).
  const sliced = sliceModel(fileXml);
  if (sliced) return sliced;

  // Otherwise it must be the compressed `<diagram>…</diagram>` text payload.
  const open = fileXml.indexOf("<diagram");
  if (open !== -1) {
    const gt = fileXml.indexOf(">", open);
    const close = fileXml.indexOf("</diagram>", gt);
    if (gt !== -1 && close !== -1) {
      const payload = fileXml.slice(gt + 1, close).trim();
      if (payload) {
        const inflated = inflateDiagramPayload(payload);
        const model = sliceModel(inflated);
        if (model) return model;
        return inflated;
      }
    }
  }
  throw new Error(
    "drawio: could not decode file — no <mxGraphModel> and no compressed <diagram> payload",
  );
}

/**
 * Upper bound on the inflated size of a compressed `<diagram>` payload
 * (decompression-bomb guard). `fetchInternalFile` caps the DOWNLOAD at 64 MiB,
 * but a tiny crafted compressed payload can inflate to gigabytes and OOM the
 * process. A real diagram's mxGraphModel XML is small (KBs to low MBs even for
 * large diagrams), so 16 MiB is far above any legitimate payload while keeping
 * memory bounded. Chars ~= bytes for the (mostly ASCII) URI-encoded XML.
 */
export const MAX_INFLATED_DIAGRAM_BYTES = 16 * 1024 * 1024;

/**
 * Inflate draw.io's compressed diagram payload:
 *   base64-decode → raw-inflate (raw deflate, windowBits -15) →
 *   decodeURIComponent.
 *
 * Uses pako's streaming Inflate so we can abort as soon as the decompressed
 * output exceeds MAX_INFLATED_DIAGRAM_BYTES — the full bomb is never
 * materialised in memory.
 */
export function inflateDiagramPayload(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const inflator = new pako.Inflate({ raw: true, to: "string" });
  let total = 0;
  const passthrough = inflator.onData.bind(inflator);
  inflator.onData = (chunk: string | Uint8Array) => {
    total += chunk.length;
    if (total > MAX_INFLATED_DIAGRAM_BYTES) {
      // Throwing here propagates out of push(), aborting inflation immediately.
      throw new Error(
        `drawio: refusing to decode diagram — decompressed size exceeds ` +
          `${MAX_INFLATED_DIAGRAM_BYTES} bytes (possible decompression bomb)`,
      );
    }
    passthrough(chunk);
  };
  inflator.push(bytes, true);
  if (inflator.err) {
    throw new Error(
      `drawio: failed to inflate compressed <diagram> payload (${inflator.msg || inflator.err})`,
    );
  }
  const uriEncoded = inflator.result as string;
  return decodeURIComponent(uriEncoded);
}

/** Full decode chain: `.drawio.svg` string → mxGraphModel XML. */
export function decodeDrawioSvg(svg: string): string {
  const content = extractContentAttr(svg).trim();
  const fileXml = content.startsWith("<")
    ? content
    : Buffer.from(content, "base64").toString("utf-8");
  return decodeDrawioFileToModel(fileXml);
}

// --- encode side -----------------------------------------------------------

/**
 * Wrap an mxGraphModel in the plain (uncompressed) `<mxfile><diagram>` envelope.
 * draw.io opens uncompressed XML fine, and staying uncompressed keeps the
 * write path deterministic and the round-trip byte-stable.
 */
export function encodeDrawioFile(modelXml: string, title = "Page-1"): string {
  const safeTitle = xmlEscape(title);
  return `<mxfile host="drawio"><diagram id="page-1" name="${safeTitle}">${modelXml}</diagram></mxfile>`;
}

/**
 * Build the `diagram.drawio.svg` attachment. Mirrors the import service's
 * createDrawioSvg contract exactly:
 *   <svg xmlns=… xmlns:xlink=… content="${base64(drawioFile)}">${inner}</svg>
 * plus width/height/viewBox from the diagram bounding box and the schematic
 * preview as the visible children (`inner`).
 */
export function buildDrawioSvg(
  modelXml: string,
  inner: string,
  bbox: DrawioBBox,
  title = "Page-1",
): string {
  const file = encodeDrawioFile(modelXml, title);
  const base64 = Buffer.from(file, "utf-8").toString("base64");
  const w = Math.max(1, Math.round(bbox.width));
  const h = Math.max(1, Math.round(bbox.height));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `content="${base64}">${inner}</svg>`
  );
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- normalization + hash --------------------------------------------------

/**
 * Normalize mxGraph XML for hashing / stable comparison: drop the whitespace
 * between tags and trim. This is intentionally conservative — it never reorders
 * attributes or cells (that would be lossy) — so two documents hash equal iff
 * they differ only in inter-tag formatting.
 */
export function normalizeXml(xml: string): string {
  return xml.replace(/>\s+</g, "><").trim();
}

/** Stable optimistic-lock hash over the normalized model XML (sha256, hex). */
export function mxHash(modelXml: string): string {
  return createHash("sha256").update(normalizeXml(modelXml), "utf-8").digest("hex");
}

// --- cell parsing ----------------------------------------------------------

/** Parse every `<mxCell>` in a model into a structured DrawioCell list. */
export function parseCells(modelXml: string): DrawioCell[] {
  const { doc, error } = parseXml(modelXml);
  if (error) {
    throw new DrawioLintError([
      { rule: "well-formed-xml", message: error, position: firstLineCol(error) },
    ]);
  }
  const cells: DrawioCell[] = [];
  const els = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < els.length; i++) {
    cells.push(readCell(els[i]));
  }
  return cells;
}

function readCell(el: any): DrawioCell {
  const style = el.getAttribute("style") || "";
  const parsed = parseStyle(style);
  const geoEl = firstChildByTag(el, "mxGeometry");
  const geometry: DrawioGeometry = geoEl
    ? {
        x: num(geoEl.getAttribute("x")),
        y: num(geoEl.getAttribute("y")),
        width: num(geoEl.getAttribute("width")),
        height: num(geoEl.getAttribute("height")),
        relative: geoEl.getAttribute("relative") === "1",
        hasGeometry: true,
      }
    : { relative: false, hasGeometry: false };
  return {
    id: el.getAttribute("id") ?? "",
    parent: el.getAttribute("parent") ?? undefined,
    source: el.getAttribute("source") ?? undefined,
    target: el.getAttribute("target") ?? undefined,
    vertex: el.getAttribute("vertex") === "1",
    edge: el.getAttribute("edge") === "1",
    value: el.getAttribute("value") ?? "",
    style,
    styleMap: parsed.map,
    baseStyle: parsed.baseStyle,
    geometry,
  };
}

function firstChildByTag(el: any, tag: string): any {
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && c.tagName === tag) return c;
  }
  return null;
}

function firstLineCol(msg: string): string | undefined {
  const m = /^(\d+:\d+)/.exec(msg);
  return m ? m[1] : undefined;
}

// --- bounding box ----------------------------------------------------------

/**
 * Absolute bounding box of the diagram from its vertex geometries. Container
 * children are relative, so absolute positions are resolved along the parent
 * chain before taking the extent. Falls back to a default canvas when empty.
 */
export function computeBBox(cells: DrawioCell[]): DrawioBBox {
  const byId = new Map(cells.map((c) => [c.id, c]));
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (const c of cells) {
    if (!c.vertex || !c.geometry.hasGeometry) continue;
    const g = c.geometry;
    if (g.width == null || g.height == null) continue;
    const { x, y } = absolutePos(c, byId);
    maxX = Math.max(maxX, x + g.width);
    maxY = Math.max(maxY, y + g.height);
    any = true;
  }
  if (!any) return { width: 300, height: 200 };
  // A small margin so borders/labels are not clipped at the edge.
  return { width: Math.ceil(maxX) + 20, height: Math.ceil(maxY) + 20 };
}

/** Absolute (x,y) of a vertex, following its parent chain (containers). */
export function absolutePos(
  cell: DrawioCell,
  byId: Map<string, DrawioCell>,
): { x: number; y: number } {
  let x = cell.geometry.x ?? 0;
  let y = cell.geometry.y ?? 0;
  const seen = new Set<string>([cell.id]);
  let parentId = cell.parent;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const p = byId.get(parentId);
    // Sentinels (0/1) carry no geometry; stop there.
    if (!p || !p.vertex || !p.geometry.hasGeometry) break;
    x += p.geometry.x ?? 0;
    y += p.geometry.y ?? 0;
    parentId = p.parent;
  }
  return { x, y };
}

// --- linter ----------------------------------------------------------------

/**
 * Run every deterministic pre-write rule over a full mxGraphModel string. On any
 * violation it throws a DrawioLintError carrying one issue per violation, each
 * with the offending cellId + position. Returns the parsed cells on success.
 */
export function lintModel(modelXml: string): {
  cells: DrawioCell[];
  warnings: string[];
} {
  const issues: DrawioLintIssue[] = [];
  const warnings: string[] = [];

  // Rule: no XML comments. Checked on the raw string (a comment survives DOM
  // parsing as a comment node, but the intent is to reject them outright — they
  // routinely wrap "TODO" cruft that breaks downstream tooling).
  if (modelXml.includes("<!--")) {
    issues.push({
      rule: "no-comments",
      message: "XML comments (<!-- -->) are not allowed in diagram XML",
    });
  }

  // Rule: value escaping + literal newline. Scan raw <mxCell> tags so the error
  // can name the cell id even when the whole document is otherwise malformed.
  scanRawValues(modelXml, issues);

  // Well-formedness — everything below needs a parsed DOM.
  const { doc, error } = parseXml(modelXml);
  if (error) {
    issues.push({
      rule: "well-formed-xml",
      message: error,
      position: firstLineCol(error),
    });
    throw new DrawioLintError(issues);
  }

  const root = doc.documentElement;
  if (!root || root.tagName !== "mxGraphModel") {
    issues.push({
      rule: "structure",
      message: `root element must be <mxGraphModel>, got <${root ? root.tagName : "?"}>`,
    });
    throw new DrawioLintError(issues);
  }
  if (!firstChildByTag(root, "root")) {
    issues.push({
      rule: "structure",
      message: "<mxGraphModel> must contain a <root> element",
    });
    throw new DrawioLintError(issues);
  }

  const cells = parseCells(modelXml);
  const ids = new Set<string>();

  // Rule: sentinel cells id="0" and id="1"(parent="0").
  const cell0 = cells.find((c) => c.id === "0");
  const cell1 = cells.find((c) => c.id === "1");
  if (!cell0) {
    issues.push({
      rule: "sentinel-cells",
      message: 'missing the root sentinel cell <mxCell id="0"/>',
      cellId: "0",
    });
  }
  if (!cell1) {
    issues.push({
      rule: "sentinel-cells",
      message: 'missing the layer sentinel cell <mxCell id="1" parent="0"/>',
      cellId: "1",
    });
  } else if (cell1.parent !== "0") {
    issues.push({
      rule: "sentinel-cells",
      message: 'the layer sentinel <mxCell id="1"> must have parent="0"',
      cellId: "1",
    });
  }

  cells.forEach((c, index) => {
    const pos = `cell #${index}`;
    const isSentinel = c.id === "0" || c.id === "1";

    // Rule: unique, non-empty ids; user cells must not reuse 0/1.
    if (c.id === "") {
      issues.push({ rule: "cell-id", message: "cell has an empty id", position: pos });
    } else if (ids.has(c.id)) {
      issues.push({
        rule: "duplicate-id",
        message: `duplicate cell id "${c.id}"`,
        cellId: c.id,
        position: pos,
      });
    }
    ids.add(c.id);

    if (isSentinel) return; // sentinels are exempt from the shape rules below

    // Rule: vertex XOR edge (a cell may be neither: groups/containers).
    if (c.vertex && c.edge) {
      issues.push({
        rule: "vertex-edge-exclusive",
        message: 'a cell cannot be both vertex="1" and edge="1"',
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: every edge has a child <mxGeometry as="geometry"/>.
    if (c.edge && !c.geometry.hasGeometry) {
      issues.push({
        rule: "edge-geometry",
        message:
          'edge is missing its child <mxGeometry relative="1" as="geometry"/> — it will not render',
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: edge endpoints resolve to existing ids.
    if (c.edge) {
      for (const end of ["source", "target"] as const) {
        const ref = c[end];
        if (ref != null && ref !== "" && !cellExists(cells, ref)) {
          issues.push({
            rule: "edge-endpoint",
            message: `edge ${end} "${ref}" does not resolve to any cell`,
            cellId: c.id,
            position: pos,
          });
        }
      }
    }

    // Rule: parent must exist.
    if (c.parent != null && c.parent !== "" && !cellExists(cells, c.parent)) {
      issues.push({
        rule: "parent-exists",
        message: `parent "${c.parent}" does not resolve to any cell`,
        cellId: c.id,
        position: pos,
      });
    }

    // Rule: style parses as key=value; pairs.
    if (c.style !== "") {
      const parsed = parseStyle(c.style);
      if (parsed.badSegment !== undefined) {
        issues.push({
          rule: "style-format",
          message: `malformed style segment "${parsed.badSegment}" (expected key=value)`,
          cellId: c.id,
          position: pos,
        });
      }
    }
  });

  if (issues.length > 0) throw new DrawioLintError(issues);
  return { cells, warnings };
}

function cellExists(cells: DrawioCell[], id: string): boolean {
  return cells.some((c) => c.id === id);
}

/**
 * Raw-string scan of every `value="…"`/`value='…'` on an mxCell tag. Catches an
 * unescaped `&`/`<`/`>` and a literal newline character inside a value, keyed to
 * the cell's id. Runs before DOM parsing so a value bug is reported with its
 * cellId even when the document is otherwise malformed.
 */
function scanRawValues(xml: string, issues: DrawioLintIssue[]): void {
  const tagRe = /<mxCell\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1];
    const idM = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
    const cellId = idM ? idM[1] : undefined;
    const valM = /\bvalue\s*=\s*"([^"]*)"/.exec(attrs) || /\bvalue\s*=\s*'([^']*)'/.exec(attrs);
    if (!valM) continue;
    const raw = valM[1];
    // Literal newline (0x0A / 0x0D) inside the attribute value.
    if (/[\n\r]/.test(raw)) {
      issues.push({
        rule: "value-newline",
        message:
          "value contains a literal newline; use &#xa; (or <br> with html=1) instead",
        cellId,
      });
    }
    // Unescaped '<' or '>' inside a value.
    if (raw.includes("<") || raw.includes(">")) {
      issues.push({
        rule: "value-escaping",
        message: "value contains an unescaped '<' or '>'; use &lt; / &gt;",
        cellId,
      });
    }
    // '&' that does not begin a valid entity.
    const badAmp = /&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(raw);
    if (badAmp) {
      issues.push({
        rule: "value-escaping",
        message: "value contains an unescaped '&'; use &amp;",
        cellId,
      });
    }
  }
}

// --- input normalization + prepare -----------------------------------------

/**
 * Normalize an accepted tool input into a full mxGraphModel string:
 *   - a bare `<mxGraphModel>` is used as-is;
 *   - an `<mxfile>` is decoded to its first page's model;
 *   - a list of `<mxCell>` is wrapped with the mxGraphModel/root envelope and
 *     the sentinel cells (id=0, id=1 parent=0) are added when absent.
 */
export function normalizeInput(inputXml: string): string {
  let xml = inputXml.trim();
  // Strip an optional XML prolog.
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (end !== -1) xml = xml.slice(end + 2).trim();
  }
  if (xml.startsWith("<mxfile")) {
    return decodeDrawioFileToModel(xml);
  }
  if (xml.startsWith("<mxGraphModel")) {
    return xml;
  }
  if (xml.includes("<mxCell")) {
    return wrapCellFragment(xml);
  }
  throw new DrawioLintError([
    {
      rule: "unrecognized-input",
      message:
        "input must be a <mxGraphModel>, an <mxfile>, or a list of <mxCell> elements",
    },
  ]);
}

function wrapCellFragment(fragment: string): string {
  // Validate the fragment is well-formed (wrapped so a bare list parses) and
  // discover which sentinels are already present.
  const { doc, error } = parseXml(`<root>${fragment}</root>`);
  if (error) {
    throw new DrawioLintError([
      {
        rule: "well-formed-xml",
        message: error,
        position: firstLineCol(error),
      },
    ]);
  }
  const existing = new Set<string>();
  const els = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < els.length; i++) {
    existing.add(els[i].getAttribute("id") ?? "");
  }
  let prefix = "";
  if (!existing.has("0")) prefix += '<mxCell id="0"/>';
  if (!existing.has("1")) prefix += '<mxCell id="1" parent="0"/>';
  return `<mxGraphModel ${DEFAULT_MODEL_ATTRS}><root>${prefix}${fragment}</root></mxGraphModel>`;
}

export interface PreparedModel {
  /** Canonical (normalized) mxGraphModel XML that gets written. */
  modelXml: string;
  cells: DrawioCell[];
  bbox: DrawioBBox;
  /** Number of user cells (excludes the id=0/id=1 sentinels). */
  cellCount: number;
  warnings: string[];
  hash: string;
}

/**
 * Full pre-write pipeline for create/update: normalize the input into a model,
 * lint it (throws DrawioLintError on any violation), then compute the canonical
 * form, bounding box, cell count and hash. Never touches the network.
 */
export function prepareModel(inputXml: string): PreparedModel {
  const rawModel = normalizeInput(inputXml);
  const { cells, warnings } = lintModel(rawModel);
  const modelXml = normalizeXml(rawModel);
  const bbox = computeBBox(cells);
  const cellCount = cells.filter((c) => c.id !== "0" && c.id !== "1").length;
  return {
    modelXml,
    cells,
    bbox,
    cellCount,
    warnings,
    hash: mxHash(modelXml),
  };
}

/** Cell count of a decoded model (user cells only) — used by drawio_get meta. */
export function countUserCells(modelXml: string): number {
  return parseCells(modelXml).filter((c) => c.id !== "0" && c.id !== "1").length;
}
