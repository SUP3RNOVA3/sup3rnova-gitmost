// ELK auto-layout for draw.io models (issue #424, stage 2). The model declares
// the LOGICAL structure (which nodes exist, which containers nest which
// children, which edges connect what) with rough or arbitrary coordinates; this
// module runs an Eclipse Layout Kernel "layered" pass (via elkjs — a pure-JS
// port, no native/browser deps) that HONOURS nested containers as compound
// nodes, then rewrites every vertex's <mxGeometry> with the computed pixels.
//
// Principle: "the model declares logical structure, the server computes pixels."
// Coordinates ELK returns for a node are relative to its parent, which is
// exactly mxGraph's convention for a child of a container, so they map across
// directly. Container sizes are computed by ELK; leaf sizes are preserved.

import ELK from "elkjs/lib/elk.bundled.js";
import { JSDOM } from "jsdom";
import { normalizeInput, parseCells, type DrawioCell } from "./drawio-xml.js";

// Default sizes when a vertex declares no geometry (appendix base sizes).
const DEFAULT_W = 140;
const DEFAULT_H = 60;

// Spacing is set >=150px on purpose so an ELK layout never trips the linter's
// "gap between adjacent shapes < 150px" quality warning (acceptance #3).
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  // Route edges across container boundaries in a single hierarchical pass.
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "170",
  "elk.spacing.nodeNode": "170",
  "elk.spacing.edgeNode": "40",
  "elk.spacing.edgeEdge": "30",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};

// Per-container options: pad children >=30px off the frame (appendix rule) and
// carry the same generous spacing so nested nodes never trip the "gap <150px"
// warning either.
const CONTAINER_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.padding": "[top=40,left=30,bottom=30,right=30]",
  "elk.layered.spacing.nodeNodeBetweenLayers": "170",
  "elk.spacing.nodeNode": "170",
};

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
}
interface ElkGraph extends ElkNode {
  edges?: ElkEdge[];
}

/**
 * Apply an ELK layered layout to a drawio input and return a full mxGraphModel
 * string with rewritten geometry. Accepts the same three input forms as
 * drawio_create (a bare model, an <mxfile>, or a <mxCell> list). Async because
 * elkjs' layout() is promise-based. On any layout failure the ORIGINAL
 * (normalized) model is returned unchanged — layout is best-effort polish, never
 * a reason to fail the write.
 */
export async function applyElkLayout(inputXml: string): Promise<string> {
  const modelXml = normalizeInput(inputXml);
  let cells: DrawioCell[];
  try {
    cells = parseCells(modelXml);
  } catch {
    return modelXml; // unparseable -> let the linter report it downstream
  }

  const byId = new Map(cells.map((c) => [c.id, c]));
  const vertices = cells.filter(
    (c) => c.vertex && c.id !== "0" && c.id !== "1",
  );
  if (vertices.length === 0) return modelXml;

  // A vertex is a CONTAINER iff some other vertex names it as parent.
  const childrenOf = new Map<string, DrawioCell[]>();
  for (const v of vertices) {
    const p = v.parent && byId.get(v.parent)?.vertex ? v.parent : "__root__";
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(v);
  }
  const isContainer = (id: string) => childrenOf.has(id);

  const buildNode = (v: DrawioCell): ElkNode => {
    const kids = childrenOf.get(v.id);
    const node: ElkNode = { id: v.id };
    if (kids && kids.length > 0) {
      node.children = kids.map(buildNode);
      node.layoutOptions = { ...CONTAINER_OPTIONS };
    } else {
      node.width = v.geometry.width ?? DEFAULT_W;
      node.height = v.geometry.height ?? DEFAULT_H;
    }
    return node;
  };

  const roots = (childrenOf.get("__root__") ?? []).map(buildNode);

  // All edges at the root; INCLUDE_CHILDREN lets them span the hierarchy. Only
  // edges whose endpoints are laid-out vertices are handed to ELK.
  const vertexIds = new Set(vertices.map((v) => v.id));
  const edges: ElkEdge[] = [];
  for (const c of cells) {
    if (!c.edge || !c.source || !c.target) continue;
    if (!vertexIds.has(c.source) || !vertexIds.has(c.target)) continue;
    edges.push({ id: c.id || `e${edges.length}`, sources: [c.source], targets: [c.target] });
  }

  const graph: ElkGraph = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: roots,
    edges,
  };

  let laid: ElkGraph;
  try {
    // elkjs ships a CJS default export whose interop shape varies across
    // module systems; resolve the real constructor at runtime, then cast (the
    // runtime call is verified — see the layout unit test).
    const Ctor: any = (ELK as any).default ?? ELK;
    const elk = new Ctor();
    laid = (await elk.layout(graph as any)) as ElkGraph;
  } catch {
    return modelXml; // best-effort: keep the model as-is on any ELK failure
  }

  // Collect computed geometry per node id (coords are parent-relative already).
  const geo = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: ElkNode) => {
    if (n.id !== "root") {
      geo.set(n.id, {
        x: Math.round(n.x ?? 0),
        y: Math.round(n.y ?? 0),
        w: Math.round(n.width ?? DEFAULT_W),
        h: Math.round(n.height ?? DEFAULT_H),
      });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(laid);

  return rewriteGeometry(modelXml, geo, isContainer);
}

/**
 * Rewrite each vertex cell's <mxGeometry> x/y (and width/height for containers,
 * whose size ELK computed) using the DOM, then serialize back. Leaf sizes are
 * left untouched. Edges and non-geometry attributes are preserved verbatim.
 */
function rewriteGeometry(
  modelXml: string,
  geo: Map<string, { x: number; y: number; w: number; h: number }>,
  isContainer: (id: string) => boolean,
): string {
  const dom = new JSDOM("");
  const parser = new dom.window.DOMParser();
  const doc = parser.parseFromString(modelXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return modelXml;

  const cellEls = doc.getElementsByTagName("mxCell");
  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i];
    const id = el.getAttribute("id") || "";
    const g = geo.get(id);
    if (!g) continue;
    let geoEl: any = null;
    for (let j = 0; j < el.childNodes.length; j++) {
      const ch = el.childNodes[j];
      if (ch.nodeType === 1 && (ch as any).tagName === "mxGeometry") {
        geoEl = ch;
        break;
      }
    }
    if (!geoEl) {
      geoEl = doc.createElement("mxGeometry");
      geoEl.setAttribute("as", "geometry");
      el.appendChild(geoEl);
    }
    geoEl.setAttribute("x", String(g.x));
    geoEl.setAttribute("y", String(g.y));
    // Containers take ELK's computed size; leaves keep their authored size.
    if (isContainer(id) || !geoEl.hasAttribute("width")) {
      geoEl.setAttribute("width", String(g.w));
    }
    if (isContainer(id) || !geoEl.hasAttribute("height")) {
      geoEl.setAttribute("height", String(g.h));
    }
  }

  const ser = new dom.window.XMLSerializer();
  return ser.serializeToString(doc.documentElement);
}
