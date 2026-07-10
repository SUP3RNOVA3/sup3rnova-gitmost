// Unit tests for the ELK auto-layout (issue #424, part 4). Acceptance #3: a
// 10+ node graph with rough/overlapping coordinates, laid out with ELK, has no
// bbox overlaps and produces no quality warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyElkLayout } from "../../build/lib/drawio-layout.js";
import { prepareModel, parseCells } from "../../build/lib/drawio-xml.js";

/** Build a model where every vertex starts stacked at (10,10). */
function stackedGraph(n, edges) {
  let cells = "";
  for (let i = 2; i < 2 + n; i++) {
    cells +=
      `<mxCell id="${i}" value="N${i}" style="rounded=1;html=1;" vertex="1" parent="1">` +
      `<mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell>`;
  }
  let ei = 0;
  for (const [s, t] of edges) {
    cells +=
      `<mxCell id="e${ei++}" edge="1" parent="1" source="${s}" target="${t}">` +
      `<mxGeometry relative="1" as="geometry"/></mxCell>`;
  }
  return (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cells +
    "</root></mxGraphModel>"
  );
}

test("acceptance #3: a 10-node graph with rough coords lays out with no warnings", async () => {
  const edges = [
    [2, 3], [2, 4], [3, 5], [4, 5], [5, 6],
    [6, 7], [6, 8], [7, 9], [8, 10], [9, 11], [10, 11],
  ];
  const model = stackedGraph(10, edges);

  // Before: everything is stacked at (10,10) -> lots of overlap warnings.
  const before = prepareModel(model);
  assert.ok(before.warnings.length > 0, "the stacked input should warn");

  const laid = await applyElkLayout(model);
  const after = prepareModel(laid);
  assert.equal(
    after.warnings.length,
    0,
    `ELK layout should clear all warnings, got: ${after.warnings.join(" | ")}`,
  );
  // Same number of user cells survived the layout.
  assert.equal(after.cellCount, before.cellCount);
});

test("ELK honours nested containers as compound nodes (no warnings, children stay nested)", async () => {
  const model =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="g" value="VPC" style="container=1;dropTarget=1;fillColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="100" as="geometry"/></mxCell>' +
    '<mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="g"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="g"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="c" value="C" style="rounded=1;" vertex="1" parent="1"><mxGeometry width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="ab" edge="1" parent="g" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '<mxCell id="bc" edge="1" parent="1" source="b" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";
  const laid = await applyElkLayout(model);
  const cells = parseCells(laid);
  const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
  // Children keep their container parent; the container was sized to hold them.
  assert.equal(byId.a.parent, "g");
  assert.equal(byId.b.parent, "g");
  assert.ok((byId.g.geometry.width ?? 0) >= 260, "container widened to fit children");
  const after = prepareModel(laid);
  assert.equal(after.warnings.length, 0, after.warnings.join(" | "));
});

test("edges and cell count are preserved by layout", async () => {
  const model = stackedGraph(4, [[2, 3], [3, 4], [4, 5]]);
  const laid = await applyElkLayout(model);
  const cells = parseCells(laid);
  assert.equal(cells.filter((c) => c.edge).length, 3);
  assert.equal(cells.filter((c) => c.vertex).length, 4);
});

test("layout is best-effort: an empty/degenerate model is returned intact", async () => {
  const model =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const laid = await applyElkLayout(model);
  // No vertices -> unchanged, still lints clean.
  const after = prepareModel(laid);
  assert.equal(after.cellCount, 0);
});
