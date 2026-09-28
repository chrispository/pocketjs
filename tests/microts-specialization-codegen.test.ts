import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { buildText, foldAotExpression } from "../microts/compiler/aot-specialize-expr.ts";
import type { AotComponent, AotExpr, AotHandler, AotNode, AotProgram, AotType } from "../microts/compiler/aot-ir.ts";

const loc = { file: "specialization.tsx", line: 1, column: 1, offset: 0 };
const i32: AotType = { kind: "number", name: "i32" }, bool: AotType = { kind: "boolean" }, string: AotType = { kind: "string" };
const lit = (value: number | string | boolean, type: AotType = typeof value === "boolean" ? bool : typeof value === "string" ? string : i32): AotExpr => ({ kind: "literal", value, type, loc });
const read = (name: string, type: AotType = i32): AotExpr => ({ kind: "binding", scope: "vm", name, type, loc });
const calc = (operator: string, left: AotExpr, right: AotExpr, type = left.type): AotExpr => ({ kind: "binary", operator, left, right, type, loc });
const element = (parts?: (string | AotExpr)[]): Extract<AotNode, { kind: "element" }> => ({ kind: "element", id: 0, tag: parts ? "Text" : "View", style: -1, focusable: false, props: [], events: [], children: [], ...(parts ? { text: { parts, memo: 0 } } : {}), loc });
const component = (name: string, nodes: AotNode[] = []): AotComponent => ({ name, file: `${name}.tsx`, root: name === "App", props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 0, memoCount: 0, handlerCount: 0 });
const program = (components: AotComponent[]): AotProgram => ({ version: 1, root: "App", components, types: [], styles: { records: [], anims: [], ids: {}, bytes: [], usedFontSlots: [] }, diagnostics: [] });
const call = (name: string): AotHandler => ({ kind: "call", expression: { kind: "call", name, target: "vm", arguments: [], type: { kind: "void" }, loc }, id: 0, loc });
const method = (name: string) => ({ name, sourceName: name, parameters: [], returns: { kind: "void" } as AotType, binding: false, handler: true });
const child = (name: string): Extract<AotNode, { kind: "component" }> => ({ kind: "component", id: 0, component: name, props: [], events: [], slots: [], loc });
const fold = (expression: AotExpr) => foldAotExpression(expression, { types: [], promoteF32Text: true });

test("Build evaluation uses integer widths and rounds every f32 intermediate", () => {
  const f32: AotType = { kind: "number", name: "f32" }, u32: AotType = { kind: "number", name: "u32" }, u64: AotType = { kind: "number", name: "u64" };
  expect(fold(calc("+", lit(2147483647), lit(1)))).toMatchObject({ kind: "literal", value: -2147483648 });
  expect(fold(calc("*", lit(4294967295, u32), lit(4294967295, u32)))).toMatchObject({ kind: "literal", value: 1 });
  expect(fold(calc("-", calc("+", lit(16777216, f32), lit(1, f32)), lit(16777216, f32)))).toMatchObject({ kind: "literal", value: 0 });
  const wide = { ...lit(Number("18446744073709551615"), u64), rawNumber: "18446744073709551615" } as AotExpr;
  expect(fold(calc("+", wide, lit(1, u64)))).toMatchObject({ kind: "literal", value: 0, rawNumber: "0" });
  expect(fold({ kind: "call", target: "builtin", name: "imod", arguments: [lit(-7), lit(3)], type: i32, loc })).toMatchObject({ kind: "literal", value: -1 });
  expect(fold({ kind: "call", target: "builtin", name: "round", arguments: [lit(1e20, f32)], type: i32, loc })).toMatchObject({ kind: "literal", value: 2147483647 });
  expect(buildText(fold({ kind: "template", parts: ["f=", lit(0.1, f32)], type: string, loc }), { types: [] })).toBe("f=0.10000000149011612");
  const color: AotType = { kind: "named", name: "Color" };
  expect(foldAotExpression(calc("===", lit("#fff", color), lit("#ffffffff", color), bool), { types: [{ kind: "newtype", name: "Color", base: u32, unit: "Color" }] })).toMatchObject({ kind: "literal", value: true });
});

test("unknown calls and trapping arithmetic stay on the runtime path", () => {
  const opaque: AotExpr = { kind: "call", target: "vm", name: "read", arguments: [lit(1)], type: i32, loc };
  expect(fold(opaque).kind).toBe("call");
  expect(fold(calc("/", lit(1), lit(0))).kind).toBe("binary");
  expect(fold({ kind: "call", target: "builtin", name: "futureBuiltin", arguments: [lit(1)], type: i32, loc }).kind).toBe("call");
  const raw = "1.0000000596046447753906250001";
  const midpoint = { ...lit(Number(raw), { kind: "number", name: "f32" }), rawNumber: raw } as AotExpr;
  expect(fold(midpoint)).toEqual(midpoint);
  expect(fold(calc("+", midpoint, lit(0, midpoint.type))).kind).toBe("binary");
  expect(buildText(midpoint, { types: [], promoteF32Text: true })).toBeUndefined();
});

test("specialization follows prop inlining and leaves the shared IR and off output unchanged", () => {
  const label = element([{ kind: "binding", scope: "prop", name: "label", type: string, loc }]);
  const childComponent = component("Label", [label]); childComponent.props = [{ name: "label", type: string, default: "default label" }];
  const app = component("App", [child("Label")]); app.children = ["Label"];
  const input = program([childComponent, app]), before = JSON.stringify(input);
  const off = emitAot(input).files["app.rs"]!, on = emitAot(input, { specialize: true }).files["app.rs"]!;
  expect(JSON.stringify(input)).toBe(before);
  expect(emitAot(input, { specialize: false }).files["app.rs"]).toBe(off);
  const rootOn = on.slice(on.indexOf("pub struct AppProps"));
  expect(rootOn).not.toContain("text_inputs:");
  expect(rootOn).toContain('ui.set_text(self.node, "default label")');
  expect(rootOn).not.toContain('ui.set_text(node, "default label")');
});

function cargoParity(name: string, input: AotProgram, rust: string) {
  const directory = resolve(".pocket-build/validation/microts-specialization", name);
  mkdirSync(`${directory}/src`, { recursive: true });
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "specialization-${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "counters"] }\n`);
  writeFileSync(`${directory}/src/off.rs`, emitAot(input).files["app.rs"]!);
  writeFileSync(`${directory}/src/on.rs`, emitAot(input, { specialize: true }).files["app.rs"]!);
  writeFileSync(`${directory}/src/lib.rs`, `mod off; mod on;\n${rust}`);
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", `${directory}/Cargo.toml`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") } });
  writeFileSync(`${directory}/cargo.log`, result.stdout.toString() + result.stderr.toString());
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test("folded scalar text matches native arithmetic, builtins and wide integer display", () => {
  const f32: AotType = { kind: "number", name: "f32" }, u32: AotType = { kind: "number", name: "u32" }, u64: AotType = { kind: "number", name: "u64" };
  const wide = { ...lit(Number("18446744073709551615"), u64), rawNumber: "18446744073709551615" } as AotExpr;
  const values: AotExpr[] = [
    calc("+", lit(2147483647), lit(1)),
    calc("*", lit(4294967295, u32), lit(4294967295, u32)),
    calc("-", calc("+", lit(16777216, f32), lit(1, f32)), lit(16777216, f32)),
    calc("-", wide, lit(2, u64)),
    { kind: "call", target: "builtin", name: "imod", arguments: [lit(-7), lit(3)], type: i32, loc },
    { kind: "call", target: "builtin", name: "round", arguments: [lit(1e20, f32)], type: i32, loc },
    { kind: "template", parts: ["f=", lit(0.1, f32)], type: string, loc },
    { kind: "call", target: "builtin", name: "fixed", arguments: [lit(1.125, f32), lit(2)], type: string, loc },
    { ...lit(Number("1.0000000596046447753906250001"), f32), rawNumber: "1.0000000596046447753906250001" } as AotExpr,
  ];
  cargoParity("numeric-text", program([component("App", values.map(value => element([value])))]), `
struct Model; impl off::AppViewModel for Model {} impl on::AppViewModel for Model {}
macro_rules! run { ($m:ident) => {{
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model);
  app.frame(&microts::Input::default());
  app.ui().core().node_children(microts::NodeId::ROOT.0).iter().map(|n| app.ui().core().node_text(*n).unwrap().to_owned()).collect::<Vec<_>>()
}}; }
#[test] fn text_matches() {
  let off = run!(off); assert_eq!(off, run!(on));
  assert_eq!(off, ["-2147483648", "1", "0", "18446744073709551613", "-1", "2147483647", "f=0.1", "1.13", "1.0000001"]);
}
`);
}, 120_000);

test("Build writes preserve first-frame input, first-update timing and remove repeated memo work", () => {
  const hidden = element([lit("deferred")]); hidden.focusable = true;
  hidden.props = [{ prop: 29, name: "display", value: lit(1), memo: 0 }];
  hidden.events = [{ name: "press", handler: call("press") }];
  const app = component("App", [hidden, element([{ kind: "template", parts: ["at mount"], type: string, loc }])]); app.functions = [method("press")];
  cargoParity("first-update", program([app]), `
#[derive(Default)] struct Model { presses: usize }
macro_rules! model { ($m:ident) => { impl $m::AppViewModel for Model { fn press(&mut self) { self.presses += 1; } } }; }
model!(off); model!(on);
macro_rules! run { ($m:ident) => {{
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model::default());
  let nodes = app.ui().core().node_children(microts::NodeId::ROOT.0).to_vec();
  assert_eq!(app.ui().core().node_text(nodes[0]), Some(""));
  assert_eq!(app.ui().core().node_text(nodes[1]), Some("at mount"));
  app.frame(&microts::Input::buttons(microts::spec::btn::DOWN | microts::spec::btn::CIRCLE));
  assert_eq!(app.model.presses, 1);
  assert_eq!(app.ui().core().node_text(nodes[0]), Some("deferred"));
  app.ui_mut().reset_counters(); app.invalidate(); app.frame(&microts::Input::default());
  app.ui().counters()
}}; }
#[test] fn same_first_frame() {
  let off = run!(off); let on = run!(on);
  assert_eq!(off.memo_evaluations, 2); assert_eq!(on.memo_evaluations, 0);
  assert_eq!(on.memo_writes, 0); assert!(on.update_at < off.update_at);
}
`);
}, 120_000);

test("Always branches mount during the first update and Never branches generate no node code", () => {
  const a = component("A", [element(["A"])]), b = component("B", [element(["B"])]);
  for (const c of [a, b]) { c.factory = { name: `create${c.name}`, sourceName: `create${c.name}`, module: c.file }; c.hooks = { mount: call("load") }; c.functions = [method("load")]; }
  const dead = element(["unreachable branch"]);
  const app = component("App", [{ kind: "if", id: 0, branches: [{ condition: lit(false), children: [dead] }, { condition: lit(true), children: [child("A")] }, { children: [dead] }], loc }, child("B")]); app.children = ["A", "B"];
  const input = program([a, b, app]), on = emitAot(input, { specialize: true }).files["app.rs"]!;
  expect(on).not.toContain("unreachable branch"); expect(on).not.toContain("let selected =");
  cargoParity("deferred-branch", input, `
use std::cell::RefCell;
thread_local! { static TRACE: RefCell<Vec<&'static str>> = RefCell::new(Vec::new()); }
fn log(s: &'static str) { TRACE.with(|t| t.borrow_mut().push(s)); }
struct A; impl Default for A { fn default() -> Self { log("create A"); Self } }
struct B; impl Default for B { fn default() -> Self { log("create B"); Self } }
struct Model;
macro_rules! model { ($m:ident) => {
  impl $m::AViewModel for A { fn load(&mut self) { log("mount A"); } }
  impl $m::BViewModel for B { fn load(&mut self) { log("mount B"); } }
  impl $m::AppViewModel for Model { type A = A; type B = B; }
}; }
model!(off); model!(on);
macro_rules! run { ($m:ident) => {{
  TRACE.with(|t| t.borrow_mut().clear());
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model);
  TRACE.with(|t| assert_eq!(*t.borrow(), ["create B"]));
  app.frame(&microts::Input::default());
  let texts: Vec<_> = app.ui().core().node_children(microts::NodeId::ROOT.0).iter().map(|n| app.ui().core().node_text(*n).unwrap().to_owned()).collect();
  assert_eq!(texts, ["A", "B"]);
  TRACE.with(|t| t.borrow().clone())
}}; }
#[test] fn order_is_unchanged() { assert_eq!(run!(off), run!(on)); }
`);
}, 120_000);

test("all-Build keyed rows skip updates while retained local bindings still compare", () => {
  const rows: AotType = { kind: "array", element: i32 };
  const local: AotExpr = { kind: "binding", scope: "local", name: "item", type: i32, loc };
  const list: AotNode = { kind: "for", id: 0, source: read("rows", rows), item: "item", itemType: i32, key: local, children: [element([lit("constant row")])], loc };
  const dynamic: AotNode = { ...list, id: 1, children: [element([local])] };
  const app = component("App", [list, dynamic]); app.values = [{ name: "rows", sourceName: "rows", type: rows, writable: false }];
  cargoParity("build-rows", program([app]), `
struct Model { rows: Vec<i32> }
impl off::AppViewModel for Model { fn rows(&self) -> &[i32] { &self.rows } }
impl on::AppViewModel for Model { fn rows(&self) -> &[i32] { &self.rows } }
macro_rules! run { ($m:ident) => {{
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model { rows: vec![1, 2] });
  app.frame(&microts::Input::default()); app.ui_mut().reset_counters();
  app.model.rows = vec![2, 1]; app.invalidate(); app.frame(&microts::Input::default());
  let c = app.ui().counters();
  assert_eq!(c.memo_writes, 0);
  let labels: Vec<_> = app.ui().core().node_children(microts::NodeId::ROOT.0).iter().map(|n| app.ui().core().node_text(*n).unwrap().to_owned()).collect();
  assert_eq!(labels, ["constant row", "constant row", "2", "1"]);
  app.model.rows = vec![2, 3, 1]; app.invalidate(); app.frame(&microts::Input::default());
  assert_eq!(app.ui().core().node_children(microts::NodeId::ROOT.0).len(), 6);
  c
}}; }
#[test] fn row_work_is_bounded() { let off = run!(off); let on = run!(on); assert_eq!(off.memo_evaluations, 4); assert_eq!(on.memo_evaluations, 2); assert!(on.update_at < off.update_at); }
`);
}, 120_000);
