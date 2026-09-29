// The specialization report states, per binding and style property, when its
// value is known: Build (compile time), Mount, or Frame (every update).
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ANIMATABLE, ENUMS, PROP, f32Bits, type StyleRecord } from "../contracts/spec/spec.ts";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { attachAotModel, BOOL, I32, STRING, type AotExpr, type AotNode, type AotProgram } from "../microts/compiler/aot-ir.ts";
import { analyzeAotSpecialization, formatAotSpecializationReport } from "../microts/compiler/aot-specialization.ts";
import { binary, call, component, freeze, instance, lit, loc, local, num, program, raw, text, view, vm } from "./helpers/microts-specialization.ts";

function report(p: AotProgram) {
  const result = analyzeAotSpecialization(p);
  const nodes = result.components.flatMap(c => c.nodes);
  const node = (id: number) => nodes.find(n => n.id === id)!;
  return {
    result, nodes, node,
    text: (id: number) => node(id).bindings.find(b => b.name === "text")!,
    prop: (id: number, name: string) => node(id).properties.find(p => p.name === name)!,
    criterion: (id: number, name: string) => node(id).region!.criteria.find(c => c.name === name)!.passed,
  };
}

/** A 100x50 box with `shrink: 0`, the shape a layout region requires. */
const box = (...extra: NonNullable<StyleRecord["base"]>): StyleRecord =>
  ({ base: [{ prop: PROP.width, value: f32Bits(100) }, { prop: PROP.height, value: f32Bits(50) }, { prop: PROP.shrink, value: f32Bits(0) }, ...extra] });
/** Model source files resolve next to the IR location. */
const modelFile = loc.file.replace(/tsx$/, "ts");

function* conclusions(value: unknown): Generator<{ stage: string; reasons: string[] }> {
  if (!value || typeof value !== "object") return;
  if ("stage" in value && "reasons" in value) yield value as { stage: string; reasons: string[] };
  for (const child of Object.values(value)) yield* conclusions(child);
}

test.each(["solid-aot-lab", "vue-sfc-lab", "settings"])("%s report is read-only, deterministic, and explains every Frame result", app => {
  const p = freeze(analyzeAot(resolve(`apps/${app}/app.${app === "vue-sfc-lab" ? "vue" : "tsx"}`), { strict: true }));
  const { result, nodes } = report(p);
  expect(result.summary.nodes).toBeGreaterThan(0);
  expect(result.summary.bindings.Build).toBeGreaterThan(0);
  expect(result.summary.bindings.Frame).toBeGreaterThan(0);
  expect(new Set(nodes.map(n => n.path)).size).toBe(nodes.length);
  expect([...conclusions(result)].filter(c => c.stage === "Frame" && c.reasons.length === 0)).toEqual([]);
  expect(analyzeAotSpecialization(p)).toEqual(result);
  expect(formatAotSpecializationReport(result)).toContain("deps=");
  expect(result.diagnostics.filter(d => d.severity !== "warning")).toEqual([]);
  if (app === "settings") expect(nodes.map(n => n.debugName)).toContain("SettingsScreen");
});

test("text content, instance existence and display are separate facts", () => {
  const hidden = { base: [{ prop: PROP.display, value: ENUMS.Display.None }] };
  const r = report(program([
    text(["Build text"], 1), text([""], 2), text([vm("label", STRING)], 3),
    { kind: "if", id: 4, loc, branches: [{ condition: lit(false), children: [text(["dead"], 5)] }, { children: [text(["live"], 6)] }] },
    view(0, [text(["inside display:none"], 8)], 7),
  ], { styles: [hidden] }));
  expect(r.text(1)).toMatchObject({ stage: "Build", nonEmpty: "Yes" });
  expect(r.text(2).nonEmpty).toBe("No");
  expect(r.text(3)).toMatchObject({ stage: "Frame", deps: "top", nonEmpty: "Unknown" });
  expect([5, 6, 8].map(id => r.node(id).exists.value)).toEqual(["Never", "Always", "Always"]);
  expect(r.node(8).inLayout.value).toBe("No");
  expect(r.prop(1, "gradDir").value).toEqual({ kind: "Known", value: 0xffffffff });
});

test("model reads, not subscriptions, are dependencies; private fields are top", () => {
  const model = analyzeModel(modelFile, { source: `import {createSignal} from "solid-js";
export const [count,setCount]=createSignal(0); let privateCount=0;
export function read(){return count();} export function privateRead(){return privateCount;} export function change(){privateCount+=1;}` });
  const p = program([text([call("read")], 1), text([call("privateRead")], 2)]);
  attachAotModel(p, model);
  // A read-only consumer: the Ledger records the read but no subscription.
  const read = model.modules[0]!.functions.find(f => f.name === "read")!;
  read.ledger = { ...read.ledger, subscriptions: [], maySubscribe: [], mustSubscribe: [] };
  expect(read.ledger.reads).toHaveLength(1);
  const r = report(p);
  expect(r.text(1)).toMatchObject({ stage: "Frame", deps: [{ kind: "signal", name: "count" }] });
  expect(r.text(2).deps).toBe("top");
  expect(r.text(2).reasons.join(" ")).toContain("private field");
});

test("style values split paint from layout and include focus, transition and timeline writes", () => {
  const dynamic = view(0, [], 1);
  dynamic.dynamicStyle = { id: 1, expression: { kind: "conditional", condition: vm("flag", BOOL), consequent: lit(0, { kind: "style" }), alternate: lit(1, { kind: "style" }), type: { kind: "style" }, loc } };
  const r = report(program([dynamic, view(2, [], 2), view(3, [], 3), view(4, [], 4)], {
    styles: [
      box({ prop: PROP.bgColor, value: 0xff000000 }),
      box({ prop: PROP.bgColor, value: 0xffffffff }),
      { ...box(), transition: { mask: 1 << ANIMATABLE.indexOf("width"), durMs: 200, delayMs: 20, easing: 0 } },
      { ...box(), animation: { anims: [0], loopFrames: 60 } },
      { ...box(), focus: [{ prop: PROP.opacity, value: f32Bits(0.5) }] },
    ],
    anims: [{ delayFrames: 0, periodFrames: 60, iterations: 0, fill: 2, tracks: [{ prop: PROP.opacity, segments: [{ t0: 0, t1: 60, from: f32Bits(0), to: f32Bits(1), easing: 0 }] }] }],
  }));
  // Node 1 switches between styles 0 and 1, which differ only in color.
  expect(r.prop(1, "width")).toMatchObject({ stage: "Build", value: { kind: "Known", value: 100 } });
  expect(r.prop(1, "bgColor")).toMatchObject({ stage: "Frame", domain: "paint", value: { kind: "Candidates", values: [0xff000000, 0xffffffff] } });
  expect(r.prop(2, "width")).toMatchObject({ stage: "Frame", animated: [{ kind: "Transition", durationMs: 200, delayMs: 20 }] });
  expect(r.prop(3, "opacity")).toMatchObject({ stage: "Frame", animated: [{ kind: "Timeline", periodFrames: 60 }] });
  expect(r.prop(4, "opacity")).toMatchObject({ stage: "Frame", env: ["styles.bin", "input.focus", "input.active"] });
  // A width transition moves layout; an opacity timeline only repaints.
  expect([r.node(2).region!.eligible, r.node(3).region!.eligible]).toEqual([false, true]);
});

test("animate and jump on a node ref make only the written properties Frame", () => {
  const model = analyzeModel(modelFile, { source: `import {createNodeRef,animate,jump} from "@pocketjs/framework/animation";
export const bar=createNodeRef(); export function change(){animate(bar,"width",120,{dur:200});jump(bar,"opacity",0.5);}` });
  const p = program(component("App", [{ ...view(0, [], 1), ref: "renamed" }], { refs: [{ name: "renamed", sourceName: "bar" }] }), { styles: [box()] });
  attachAotModel(p, model);
  const r = report(p);
  expect(r.prop(1, "width")).toMatchObject({ stage: "Frame", modelWrites: ["animate"] });
  expect(r.prop(1, "opacity")).toMatchObject({ stage: "Frame", modelWrites: ["jump"] });
  expect(r.prop(1, "height").stage).toBe("Build");
  expect(r.node(1).region!.eligible).toBe(false);
});

test("region proofs reject auto width, default shrink, grow and min-width above width", () => {
  const defaultShrink = { base: box().base!.filter(entry => entry.prop !== PROP.shrink) };
  const r = report(program([text(["auto"], 1), view(0, [], 2), view(1, [], 3), view(2, [], 4), view(3, [], 5)], {
    styles: [defaultShrink, box({ prop: PROP.grow, value: f32Bits(1) }), box({ prop: PROP.minW, value: f32Bits(110) }), box()],
  }));
  expect(r.criterion(1, "definite-width")).toBe(false);
  expect(r.criterion(2, "no-shrink")).toBe(false);
  expect(r.criterion(3, "no-grow")).toBe(false);
  expect(r.criterion(4, "compatible-min-max")).toBe(false);
  expect(r.node(5).region).toMatchObject({ eligible: true, baking: { eligible: false, status: "NeedsEnvironment" } });
  // Warnings: VS101 auto width, VS102 default shrink.
  expect(r.result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(["VS101", "VS102"]));
});

test("props are staged per call site; keyed row keys are Mount, other row values Frame", () => {
  const label = component("Label", [text([{ kind: "binding", scope: "prop", name: "label", type: STRING, loc }], 10)], { props: [{ name: "label", type: STRING }] });
  const labelled = (id: number, value: AotExpr) => instance("Label", { id, props: [{ name: "label", value }] });
  const row = { kind: "named" as const, name: "Row" };
  const key: AotExpr = { kind: "field", object: local("row", row), name: "id", optional: false, type: num("i32"), loc };
  const rows: AotNode = { kind: "for", id: 3, source: vm("rows", { kind: "array", element: row }), item: "row", index: "index", key, itemType: row, loc,
    children: [text([key], 4), text([{ ...key, name: "value" } as AotExpr], 5), text([local("index")], 6)] };
  const r = report(program([labelled(1, lit("static")), labelled(2, vm("label", STRING)), rows], { components: [label] }));
  const labels = r.result.components.filter(c => c.component === "Label").map(c => c.nodes[0]!.bindings.find(b => b.name === "text")!.stage);
  expect(labels).toEqual(["Build", "Frame"]);
  expect([4, 5, 6].map(id => r.text(id).stage)).toEqual(["Mount", "Frame", "Frame"]);
  expect(r.node(4).exists.value).toBe("Conditional");
});

test("factory parameter reads are Mount only while the parameter is never assigned", () => {
  const rootFile = resolve(modelFile, "../Root.ts");
  const model = analyzeModel(rootFile, { name: "Root", factories: [modelFile], sources: new Map([[rootFile, ""], [modelFile,
    `import type {i32} from "@pocketjs/framework/solid/std"; export function createApp(seed:i32){function read():i32{return seed;} return {read};}`]]) });
  const p = program(component("App", [text([call("read")], 1)], { factory: { name: "createApp", sourceName: "createApp", module: "./App" } }));
  attachAotModel(p, model);
  expect(report(p).text(1).stage).toBe("Mount");
  const module = model.modules.find(m => m.params.length)!;
  const read = module.functions.find(f => f.name === "read")!;
  read.body.stmts.unshift({ kind: "assign", target: { kind: "local", id: module.params[0]!.id }, value: { kind: "literal", value: 2, type: I32, loc, ledger: { reads: [], writes: [], subscriptions: [], external: false } } });
  expect(report(p).text(1)).toMatchObject({ stage: "Frame", deps: "top" });
});

test("constant conditions fold with the integer width of their type", () => {
  const u8 = num("u8");
  const wraps = binary("===", binary("+", lit(255, u8), lit(1, u8)), lit(0, u8), BOOL); // 255u8 + 1 == 0
  const r = report(freeze(program([{ kind: "if", id: 1, loc, branches: [{ condition: wraps, children: [text(["wrapped"], 2)] }, { children: [text(["wrong"], 3)] }] }])));
  expect([2, 3].map(id => r.node(id).exists.value)).toEqual(["Always", "Never"]);
});

test("an unreachable branch of a conditional does not make a binding Frame", () => {
  const value: AotExpr = { kind: "conditional", condition: lit(false), consequent: vm("unreachable", STRING), alternate: lit("constant"), type: STRING, loc };
  expect(report(program([text([value], 1)])).text(1)).toMatchObject({ stage: "Build", deps: [], nonEmpty: "Yes" });
});

test("a decimal width with no proven f32 value cannot establish a region", () => {
  const root = view(0, [], 1);
  // Just above the midpoint between two adjacent f32 values.
  root.props.push({ name: "width", prop: PROP.width, memo: 1, value: raw("1.0000000596046447753906250000000001") });
  const r = report(program([root], { styles: [box()] }));
  expect(r.prop(1, "width")).toMatchObject({ stage: "Build", value: { kind: "Unknown" } });
  expect(r.node(1).region!.eligible).toBe(false);
});
