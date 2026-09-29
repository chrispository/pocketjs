// Build-stage folding and specialized Rust generation. The native tests
// compile the reference (off) and specialized (on) output side by side.
import { expect, test } from "bun:test";
import { PROP } from "../contracts/spec/spec.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { BOOL, I32, STRING, type AotExpr, type AotNode, type AotType } from "../microts/compiler/aot-ir.ts";
import { buildText, foldAotExpression } from "../microts/compiler/aot-specialize-expr.ts";
import { binary, builtin, call, component, emitPair, freeze, handler, instance, lit, loc, local, num, program, raw, runCrate, text, vm } from "./helpers/microts-specialization.ts";

const [u32, u64, f32] = [num("u32"), num("u64"), num("f32")];
const fold = (expression: AotExpr) => foldAotExpression(expression, { types: [], promoteF32Text: true });
const U64_MAX = raw("18446744073709551615", u64);
const F32_TEXT: AotExpr = { kind: "template", parts: ["f=", lit(0.1, f32)], type: STRING, loc };
/** Decimal that rounds to an f32 tie when parsed as f64, but not when Rust parses it directly. */
const F32_MIDPOINT = raw("1.0000000596046447753906250001");

/** Scalar expressions and the text the native runtime displays for each. */
const NUMERIC: [AotExpr, string][] = [
  [binary("+", lit(2147483647), lit(1)), "-2147483648"], // i32 wraps
  [binary("*", lit(4294967295, u32), lit(4294967295, u32)), "1"], // u32 wraps
  [binary("-", binary("+", lit(16777216, f32), lit(1, f32)), lit(16777216, f32)), "0"], // each f32 step rounds
  [binary("-", U64_MAX, lit(2, u64)), "18446744073709551613"], // u64 stays exact
  [builtin("imod", I32, lit(-7), lit(3)), "-1"],
  [builtin("round", I32, lit(1e20, f32)), "2147483647"], // saturates
];

/** Rust helper: the text of every root child. */
const TEXTS = `mod off; mod on;
fn texts(ui: &microts::Ui) -> Vec<String> {
  ui.core().node_children(microts::NodeId::ROOT.0).iter().map(|n| ui.core().node_text(*n).unwrap_or("").to_owned()).collect()
}`;

test("Build folding uses integer widths, f32 rounding and the runtime builtins", () => {
  expect(NUMERIC.map(([expression]) => buildText(fold(expression), { types: [] }))).toEqual(NUMERIC.map(([, text]) => text));
  expect(fold(binary("+", U64_MAX, lit(1, u64)))).toMatchObject({ kind: "literal", value: 0, rawNumber: "0" });
  // Compiled models display an f32 after promotion to f64.
  expect(fold(F32_TEXT)).toMatchObject({ kind: "literal", value: "f=0.10000000149011612" });
  const color: AotType = { kind: "named", name: "Color" };
  const types = [{ kind: "newtype" as const, name: "Color", base: u32, unit: "Color" as const }];
  expect(foldAotExpression(binary("===", lit("#fff", color), lit("#ffffffff", color), BOOL), { types })).toMatchObject({ kind: "literal", value: true });
});

test("unknown calls, trapping arithmetic and f32 midpoints stay on the runtime path", () => {
  expect(fold(call("read")).kind).toBe("call");
  expect(fold(builtin("futureBuiltin", I32, lit(1))).kind).toBe("call");
  expect(fold(binary("/", lit(1), lit(0))).kind).toBe("binary"); // traps at runtime
  expect(fold(F32_MIDPOINT)).toEqual(F32_MIDPOINT);
  expect(fold(binary("+", F32_MIDPOINT, lit(0, f32))).kind).toBe("binary");
  expect(buildText(F32_MIDPOINT, { types: [], promoteF32Text: true })).toBeUndefined();
});

test("a default prop folds into a first-update write; IR and reference output are unchanged", () => {
  const label = component("Label", [text([{ kind: "binding", scope: "prop", name: "label", type: STRING, loc }])], { props: [{ name: "label", type: STRING, default: "default label" }] });
  const input = freeze(program(component("App", [instance("Label")], { children: ["Label"] }), { components: [label] }));
  const { "off.rs": off, "on.rs": on } = emitPair(input);
  expect(emitAot(input, { specialize: false }).files["app.rs"]).toBe(off);
  // The instance keeps no text memo, and writes the constant in its first update rather than at mount.
  const app = on.slice(on.indexOf("pub struct AppProps"));
  expect(app).not.toContain("text_inputs:");
  expect(app).toContain('ui.set_text(self.node, "default label")');
  expect(app).not.toContain('ui.set_text(node, "default label")');
});

test("folded text equals the text the native runtime computes", () => {
  const values = [...NUMERIC.map(([expression]) => expression), builtin("fixed", STRING, lit(1.125, f32), lit(2)), F32_TEXT, F32_MIDPOINT];
  const expected = [...NUMERIC.map(([, text]) => text), "1.13", "f=0.1", "1.0000001"];
  runCrate("specialization-numeric-text", { ...emitPair(program(values.map(value => text([value])))), "lib.rs": `${TEXTS}
struct Model; impl off::AppViewModel for Model {} impl on::AppViewModel for Model {}
macro_rules! run { ($m:ident) => {{
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model);
  app.frame(&microts::Input::default());
  texts(app.ui())
}}; }
#[test] fn same_text() { assert_eq!(run!(off), ${JSON.stringify(expected)}); assert_eq!(run!(on), run!(off)); }` });
}, 120_000);

test("Build writes keep first-update timing and leave no per-update memo work", () => {
  const press = handler("press");
  const hidden = text([lit("deferred")]);
  hidden.focusable = true;
  hidden.props = [{ prop: PROP.display, name: "display", value: lit(1), memo: 0 }]; // display: none
  hidden.events = [{ name: "press", handler: press.call }];
  const app = component("App", [hidden, text([{ kind: "template", parts: ["at mount"], type: STRING, loc }])], { functions: [press.method] });
  runCrate("specialization-first-update", { ...emitPair(program(app)), "lib.rs": `${TEXTS}
#[derive(Default)] struct Model { presses: usize }
macro_rules! run { ($m:ident) => {{
  impl $m::AppViewModel for Model { fn press(&mut self) { self.presses += 1; } }
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model::default());
  assert_eq!(texts(app.ui()), ["", "at mount"]); // direct text waits for the first update
  // Input in the first frame reaches the model before that update runs.
  app.frame(&microts::Input::buttons(microts::spec::btn::DOWN | microts::spec::btn::CIRCLE));
  assert_eq!(app.model.presses, 1);
  assert_eq!(texts(app.ui()), ["deferred", "at mount"]);
  app.ui_mut().reset_counters(); app.invalidate(); app.frame(&microts::Input::default());
  app.ui().counters()
}}; }
#[test] fn same_first_frame() {
  let (off, on) = (run!(off), run!(on));
  assert_eq!((off.memo_evaluations, on.memo_evaluations, on.memo_writes), (2, 0, 0));
  assert!(on.update_at < off.update_at);
}` });
}, 120_000);

test("an Always branch mounts in the first update and a Never branch emits no code", () => {
  const load = handler("load");
  const child = (name: string) => component(name, [text([name])], {
    factory: { name: `create${name}`, sourceName: `create${name}`, module: `./${name}` }, hooks: { mount: load.call }, functions: [load.method],
  });
  const dead = text(["unreachable branch"]);
  const branches = { kind: "if" as const, id: 0, loc, branches: [{ condition: lit(false), children: [dead] }, { condition: lit(true), children: [instance("A")] }, { children: [dead] }] };
  const pair = emitPair(program(component("App", [branches, instance("B")], { children: ["A", "B"] }), { components: [child("A"), child("B")] }));
  expect(pair["on.rs"]).not.toContain("unreachable branch");
  runCrate("specialization-deferred-branch", { ...pair, "lib.rs": `${TEXTS}
use std::cell::RefCell;
thread_local! { static TRACE: RefCell<Vec<&'static str>> = RefCell::new(Vec::new()); }
fn log(entry: &'static str) { TRACE.with(|t| t.borrow_mut().push(entry)); }
fn take() -> Vec<&'static str> { TRACE.with(|t| t.take()) }
struct A; impl Default for A { fn default() -> Self { log("create A"); Self } }
struct B; impl Default for B { fn default() -> Self { log("create B"); Self } }
struct Model;
macro_rules! run { ($m:ident) => {{
  impl $m::AViewModel for A { fn load(&mut self) { log("mount A"); } }
  impl $m::BViewModel for B { fn load(&mut self) { log("mount B"); } }
  impl $m::AppViewModel for Model { type A = A; type B = B; }
  take();
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model);
  assert_eq!(take(), ["create B"], "the Always branch waits for the first update");
  app.frame(&microts::Input::default());
  assert_eq!(texts(app.ui()), ["A", "B"]);
  take()
}}; }
#[test] fn same_lifecycle_order() { assert_eq!(run!(off), run!(on)); }` });
}, 120_000);

test("keyed rows with only Build content skip updates; rows reading the item still compare", () => {
  const rows: AotType = { kind: "array", element: I32 };
  const each = (id: number, row: AotNode): AotNode => ({ kind: "for", id, source: vm("rows", rows), item: "item", itemType: I32, key: local("item"), children: [row], loc });
  // A literal expression is a memo in the reference build and a Build constant when specialized.
  const app = component("App", [each(0, text([lit("constant row")])), each(1, text([local("item")]))], { values: [{ name: "rows", sourceName: "rows", type: rows, writable: false }] });
  runCrate("specialization-build-rows", { ...emitPair(program(app)), "lib.rs": `${TEXTS}
struct Model { rows: Vec<i32> }
macro_rules! run { ($m:ident) => {{
  impl $m::AppViewModel for Model { fn rows(&self) -> &[i32] { &self.rows } }
  let mut app = $m::AppApp::new(microts::CoreHost::new(), $m::AppProps {}, Model { rows: vec![1, 2] });
  app.frame(&microts::Input::default());
  app.ui_mut().reset_counters();
  app.model.rows = vec![2, 1]; app.invalidate(); app.frame(&microts::Input::default());
  let work = app.ui().counters();
  assert_eq!(work.memo_writes, 0, "a keyed move rewrites no text");
  assert_eq!(texts(app.ui()), ["constant row", "constant row", "2", "1"]);
  app.model.rows = vec![2, 3, 1]; app.invalidate(); app.frame(&microts::Input::default());
  assert_eq!(texts(app.ui()).len(), 6);
  work
}}; }
#[test] fn row_work() {
  let (off, on) = (run!(off), run!(on));
  assert_eq!((off.memo_evaluations, on.memo_evaluations), (4, 2));
  assert!(on.update_at < off.update_at);
}` });
}, 120_000);
