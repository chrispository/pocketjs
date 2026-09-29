import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { ANIMATABLE, ENUMS, PROP, f32Bits, type StyleRecord } from "../contracts/spec/spec.ts";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { attachAotModel, BOOL, I32, STRING, type AotComponent, type AotExpr, type AotNode, type AotProgram, type AotType } from "../microts/compiler/aot-ir.ts";
import { analyzeAotSpecialization, formatAotSpecializationReport, type AotSpecializationReport, type SpecializationNode } from "../microts/compiler/aot-specialization.ts";

const loc = { file: resolve("tests/fixtures/aot/specialization/App.tsx"), line: 1, column: 1, offset: 0 };
const literal = (value: string | number | boolean, type: AotType = typeof value === "number" ? I32 : typeof value === "boolean" ? BOOL : STRING): AotExpr => ({ kind: "literal", value, type, loc });
const vm = (name: string, type: AotType = I32): AotExpr => ({ kind: "binding", scope: "vm", name, type, loc });
const local = (name: string, type: AotType = I32): AotExpr => ({ kind: "binding", scope: "local", name, type, loc });
const call = (name: string): AotExpr => ({ kind: "call", target: "vm", name, arguments: [], type: I32, loc });
const text = (id: number, parts: (string | AotExpr)[]): AotNode => ({ kind: "element", id, tag: "Text", style: -1, props: [], text: { parts, memo: id }, focusable: false, events: [], children: [], loc });
const view = (id: number, style: number, children: AotNode[] = []): Extract<AotNode, { kind: "element" }> => ({ kind: "element", id, tag: "View", style, props: [], focusable: false, events: [], children, loc });
function component(name: string, nodes: AotNode[], extra: Partial<AotComponent> = {}): AotComponent {
  return { name, root: name === "App", file: loc.file, props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 100, memoCount: 100, handlerCount: 0, ...extra };
}
function program(nodes: AotNode[], styles: StyleRecord[] = [], extra: AotComponent[] = []): AotProgram {
  return { version: 1, root: "App", components: [component("App", nodes), ...extra], types: [], diagnostics: [], styles: { records: styles, anims: [], ids: {}, bytes: [], usedFontSlots: [] } };
}
const nodes = (report: AotSpecializationReport) => report.components.flatMap(c => c.nodes);
const node = (report: AotSpecializationReport, id: number): SpecializationNode => nodes(report).find(n => n.id === id)!;
const property = (node: SpecializationNode, name: string) => node.properties.find(p => p.name === name)!;
const fixed = (shrink = 0): StyleRecord => ({ base: [{ prop: PROP.width, value: f32Bits(100) }, { prop: PROP.height, value: f32Bits(50) }, { prop: PROP.shrink, value: f32Bits(shrink) }] });
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  Object.freeze(value);
}

test.each(["solid-aot-lab", "vue-sfc-lab", "settings"])("%s report is read-only and every Frame conclusion has a reason", app => {
  const p = analyzeAot(resolve(`apps/${app}/app.${app === "vue-sfc-lab" ? "vue" : "tsx"}`), { strict: true });
  const before = JSON.stringify(p), modelBefore = JSON.stringify(p.model);
  freeze(p);
  const report = analyzeAotSpecialization(p);
  expect(report.summary.nodes).toBeGreaterThan(0);
  expect(report.summary.bindings.Build).toBeGreaterThan(0);
  expect(report.summary.bindings.Frame).toBeGreaterThan(0);
  expect(new Set(nodes(report).map(n => n.path)).size).toBe(nodes(report).length);
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("stage" in value && value.stage === "Frame" && "reasons" in value) expect((value.reasons as string[]).length).toBeGreaterThan(0);
    Object.values(value).forEach(inspect);
  };
  inspect(report);
  expect(JSON.stringify(p)).toBe(before);
  expect(JSON.stringify(p.model)).toBe(modelBefore);
  expect(JSON.stringify(analyzeAotSpecialization(p))).toBe(JSON.stringify(report));
  expect(formatAotSpecializationReport(report)).toContain("deps=");
  expect(report.diagnostics.every(d => d.severity === "warning")).toBe(true);
  if (app === "settings") {
    expect(nodes(report).some(n => n.debugName === "SettingsScreen")).toBe(true);
    expect(nodes(report).some(n => n.bindings.some(b => b.name === "text" && b.stage === "Frame"))).toBe(true);
  }
});

test("text nonemptiness, instance existence, and display are separate facts", () => {
  const p = program([
    text(1, ["Build text"]), text(2, [""]), text(3, [vm("label", STRING)]),
    { kind: "if", id: 4, loc, branches: [{ condition: literal(false), children: [text(5, ["dead"])] }, { children: [text(6, ["live"])] }] },
    view(7, 0, [text(8, ["still instantiated"])]),
  ], [{ base: [{ prop: PROP.display, value: ENUMS.Display.None }] }]);
  const report = analyzeAotSpecialization(p);
  expect(node(report, 1).bindings.find(b => b.name === "text")).toMatchObject({ stage: "Build", nonEmpty: "Yes" });
  expect(node(report, 2).bindings.find(b => b.name === "text")!.nonEmpty).toBe("No");
  expect(node(report, 3).bindings.find(b => b.name === "text")).toMatchObject({ stage: "Frame", deps: "top", nonEmpty: "Unknown" });
  expect(node(report, 5).exists.value).toBe("Never");
  expect(node(report, 6).exists.value).toBe("Always");
  expect(node(report, 8).exists.value).toBe("Always");
  expect(node(report, 8).inLayout.value).toBe("No");
  expect(property(node(report, 1), "gradDir").value).toEqual({ kind: "Known", value: 0xffffffff });
});

test("reads, not subscriptions, drive model dependencies; private field reads use top", () => {
  const model = analyzeModel(loc.file.replace(/tsx$/, "ts"), { source: 'import {createSignal} from "solid-js";export const [count,setCount]=createSignal(0);let privateCount=0;export function read(){return count();}export function privateRead(){return privateCount;}export function change(){privateCount+=1;}' });
  const p = program([text(1, [call("read")]), text(2, [call("privateRead")])]);
  attachAotModel(p, model);
  const fn = model.modules[0]!.functions.find(f => f.name === "read")!;
  // Exercise the read-only consumer's Ledger contract independently of which
  // source contexts currently admit untrack.
  fn.ledger = { ...fn.ledger, subscriptions: [], maySubscribe: [], mustSubscribe: [] };
  expect(fn.ledger.subscriptions).toEqual([]);
  expect(fn.ledger.reads).toHaveLength(1);
  const report = analyzeAotSpecialization(p);
  expect(node(report, 1).bindings.find(b => b.name === "text")).toMatchObject({ stage: "Frame", deps: [{ kind: "signal", name: "count" }] });
  const privateText = node(report, 2).bindings.find(b => b.name === "text")!;
  expect(privateText.deps).toBe("top");
  expect(privateText.reasons.join(" ")).toContain("private field");
});

test("style candidates split paint from layout and include focus, transition, and timeline writes", () => {
  const first = fixed(), second = fixed();
  first.base!.push({ prop: PROP.bgColor, value: 0xff000000 });
  second.base!.push({ prop: PROP.bgColor, value: 0xffffffff });
  const dynamic = view(1, 0);
  dynamic.dynamicStyle = { id: 1, expression: { kind: "conditional", condition: vm("flag", BOOL), consequent: literal(0, { kind: "style" }), alternate: literal(1, { kind: "style" }), type: { kind: "style" }, loc } };
  const transition = { ...fixed(), transition: { mask: 1 << ANIMATABLE.indexOf("width"), durMs: 200, delayMs: 20, easing: 0 } };
  const timeline = { ...fixed(), animation: { anims: [0], loopFrames: 60 } };
  const focus = { ...fixed(), focus: [{ prop: PROP.opacity, value: f32Bits(0.5) }] };
  const p = program([dynamic, view(2, 2), view(3, 3), view(4, 4)], [first, second, transition, timeline, focus]);
  p.styles.anims.push({ delayFrames: 0, periodFrames: 60, iterations: 0, fill: 2, tracks: [{ prop: PROP.opacity, segments: [{ t0: 0, t1: 60, from: f32Bits(0), to: f32Bits(1), easing: 0 }] }] });
  const report = analyzeAotSpecialization(p);
  expect(property(node(report, 1), "width")).toMatchObject({ stage: "Build", value: { kind: "Known", value: 100 } });
  expect(property(node(report, 1), "bgColor")).toMatchObject({ stage: "Frame", domain: "paint", value: { kind: "Candidates", values: [0xff000000, 0xffffffff] } });
  expect(property(node(report, 2), "width")).toMatchObject({ stage: "Frame", animated: [{ kind: "Transition", durationMs: 200, delayMs: 20 }] });
  expect(node(report, 2).region!.eligible).toBe(false);
  expect(property(node(report, 3), "opacity")).toMatchObject({ stage: "Frame", animated: [{ kind: "Timeline", periodFrames: 60 }] });
  expect(node(report, 3).region!.eligible).toBe(true);
  expect(property(node(report, 4), "opacity")).toMatchObject({ stage: "Frame", env: ["styles.bin", "input.focus", "input.active"] });
});

test("animate ref targets invalidate only the written property", () => {
  const model = analyzeModel(loc.file.replace(/tsx$/, "ts"), { source: 'import {createNodeRef,animate,jump} from "@pocketjs/framework/animation";export const bar=createNodeRef();export function change(){animate(bar,"width",120,{dur:200});jump(bar,"opacity",0.5);}' });
  const bar = { ...view(1, 0), ref: "renamed" };
  const p = program([bar], [fixed()]);
  p.components[0]!.refs = [{ name: "renamed", sourceName: "bar" }];
  attachAotModel(p, model);
  const report = analyzeAotSpecialization(p);
  expect(property(node(report, 1), "width")).toMatchObject({ stage: "Frame", modelWrites: ["animate"] });
  expect(property(node(report, 1), "opacity")).toMatchObject({ stage: "Frame", modelWrites: ["jump"] });
  expect(property(node(report, 1), "height").stage).toBe("Build");
  expect(node(report, 1).region!.eligible).toBe(false);
});

test("region proof rejects auto width, default shrink, grow, and conflicting min/max", () => {
  const defaultShrink = fixed(); defaultShrink.base!.pop();
  const grow = fixed(); grow.base!.push({ prop: PROP.grow, value: f32Bits(1) });
  const min = fixed(); min.base!.push({ prop: PROP.minW, value: f32Bits(110) });
  const p = program([text(1, ["auto"]), view(2, 0), view(3, 1), view(4, 2), view(5, 3)], [defaultShrink, grow, min, fixed()]);
  const report = analyzeAotSpecialization(p);
  expect(node(report, 1).region!.criteria.find(c => c.name === "definite-width")!.passed).toBe(false);
  expect(node(report, 2).region!.criteria.find(c => c.name === "no-shrink")!.passed).toBe(false);
  expect(node(report, 3).region!.criteria.find(c => c.name === "no-grow")!.passed).toBe(false);
  expect(node(report, 4).region!.criteria.find(c => c.name === "compatible-min-max")!.passed).toBe(false);
  expect(node(report, 5).region).toMatchObject({ eligible: true, baking: { eligible: false, status: "NeedsEnvironment" } });
  expect(report.diagnostics.map(d => d.code)).toContain("VS101");
  expect(report.diagnostics.map(d => d.code)).toContain("VS102");
});

test("call-site props stay distinct and keyed row keys are Mount while items remain Frame", () => {
  const child = component("Label", [text(10, [{ kind: "binding", scope: "prop", name: "label", type: STRING, loc }])], { props: [{ name: "label", type: STRING }], root: false });
  const invocation = (id: number, value: AotExpr): AotNode => ({ kind: "component", id, component: "Label", props: [{ name: "label", value }], events: [], slots: [], loc });
  const rowKey: AotExpr = { kind: "field", object: local("row", { kind: "named", name: "Row" }), name: "id", optional: false, type: I32, loc };
  const p = program([invocation(1, literal("static")), invocation(2, vm("label", STRING)), { kind: "for", id: 3, source: vm("rows", { kind: "array", element: { kind: "named", name: "Row" } }), item: "row", index: "index", key: rowKey, itemType: { kind: "named", name: "Row" }, loc, children: [text(4, [rowKey]), text(5, [{ ...rowKey, name: "value" }]), text(6, [local("index")])] }], [], [child]);
  const report = analyzeAotSpecialization(p);
  const childText = report.components.filter(c => c.component === "Label").map(c => c.nodes[0]!.bindings.find(b => b.name === "text")!);
  expect(childText.map(b => b.stage)).toEqual(["Build", "Frame"]);
  expect(node(report, 4).bindings.find(b => b.name === "text")!.stage).toBe("Mount");
  expect(node(report, 5).bindings.find(b => b.name === "text")!.stage).toBe("Frame");
  expect(node(report, 6).bindings.find(b => b.name === "text")!.stage).toBe("Frame");
  expect(node(report, 4).exists.value).toBe("Conditional");
});

test("factory parameter reads require immutability instead of treating empty Ledger reads as Build", () => {
  const factoryFile = loc.file.replace(/tsx$/, "ts"), rootFile = resolve(factoryFile, "../Root.ts");
  const model = analyzeModel(rootFile, { name: "Root", sources: new Map([[rootFile, ""], [factoryFile, 'import type {i32} from "@pocketjs/framework/solid/std";export function createApp(seed:i32){function read():i32{return seed;}return {read};}']]), factories: [factoryFile] });
  const p = program([text(1, [call("read")])]);
  p.components[0]!.factory = { name: "createApp", sourceName: "createApp", module: "./App" };
  attachAotModel(p, model);
  const report = analyzeAotSpecialization(p);
  expect(node(report, 1).bindings.find(b => b.name === "text")!.stage).toBe("Mount");
  const module = model.modules.find(m => m.params.length)!;
  const fn = module.functions.find(f => f.name === "read")!;
  fn.body.stmts.unshift({ kind: "assign", target: { kind: "local", id: module.params[0]!.id }, value: { kind: "literal", value: 2, type: I32, loc, ledger: { reads: [], writes: [], subscriptions: [], external: false } } });
  const changed = analyzeAotSpecialization(p);
  expect(node(changed, 1).bindings.find(b => b.name === "text")).toMatchObject({ stage: "Frame", deps: "top" });
});

test("typed constant conditions preserve integer widths and the shared IR", () => {
  const sum: AotExpr = { kind: "binary", operator: "+", left: literal(255, { kind: "number", name: "u8" }), right: literal(1, { kind: "number", name: "u8" }), type: { kind: "number", name: "u8" }, loc };
  const condition: AotExpr = { kind: "binary", operator: "===", left: sum, right: literal(0, { kind: "number", name: "u8" }), type: BOOL, loc };
  const p = program([{ kind: "if", id: 1, loc, branches: [{ condition, children: [text(2, ["wrapped"])] }, { children: [text(3, ["wrong"])] }] }]);
  freeze(p);
  const report = analyzeAotSpecialization(p);
  expect(node(report, 2).exists.value).toBe("Always");
  expect(node(report, 3).exists.value).toBe("Never");
  expect(condition.kind).toBe("binary");
});

test("unreachable conditional inputs do not make Build bindings dynamic", () => {
  const expression: AotExpr = { kind: "conditional", condition: literal(false), consequent: vm("unreachable", STRING), alternate: literal("constant"), type: STRING, loc };
  const p = program([text(1, [expression])]);
  expect(node(analyzeAotSpecialization(p), 1).bindings.find(b => b.name === "text")).toMatchObject({ stage: "Build", deps: [], nonEmpty: "Yes" });
});

test("unproven direct decimal-to-f32 values do not establish region dimensions", () => {
  const root = view(1, 0);
  root.props.push({ name: "width", prop: PROP.width, memo: 1, value: { ...literal(1.0000000596046448, { kind: "number", name: "f32" }), rawNumber: "1.0000000596046447753906250000000001" } as AotExpr });
  const report = analyzeAotSpecialization(program([root], [fixed()]));
  expect(property(node(report, 1), "width")).toMatchObject({ stage: "Build", value: { kind: "Unknown" } });
  expect(node(report, 1).region!.eligible).toBe(false);
});
