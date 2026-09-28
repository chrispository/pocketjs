import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import type { AotComponent, AotExpr, AotNode, AotProgram, AotType } from "../microts/compiler/aot-ir.ts";

const loc = { file: "identity-fixture.tsx", line: 1, column: 1, offset: 0 };
const boolean: AotType = { kind: "boolean" }, string: AotType = { kind: "string" };
const strings: AotType = { kind: "array", element: string };
const literal = (value: boolean): AotExpr => ({ kind: "literal", value, type: boolean, loc });
const read = (name: string, type: AotType): AotExpr => ({ kind: "binding", scope: "vm", name, type, loc });
const text = (value: string | AotExpr): AotNode => ({ kind: "element", id: 0, tag: "Text", style: -1, props: [], focusable: true, events: [], children: [], text: { memo: 0, parts: [value] }, loc });
const show = (condition: AotExpr, children: AotNode[]): AotNode => ({ kind: "if", id: 0, branches: [{ condition, children }], loc });
const component = (name: string, nodes: AotNode[]): AotComponent => ({ name, file: `${name}.tsx`, root: name === "App", props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 0, memoCount: 0, handlerCount: 0 });

function fixture(lifecycle = false): AotProgram {
  const outlet = (): AotNode => ({ kind: "slot", id: 0, name: "body", fallback: [], loc });
  const child = component("Child", [show(literal(false), [text("dead")]), show(literal(true), [text("child")]), outlet(), outlet()]);
  child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" };
  child.slots = ["body"];
  child.functions = [{ name: "mounted", sourceName: "mounted", parameters: [], returns: { kind: "void" }, binding: false, handler: true }];
  if (lifecycle) child.hooks = { mount: { kind: "call", expression: { kind: "call", target: "vm", name: "mounted", arguments: [], type: { kind: "void" }, loc }, id: 0, loc } };
  const childNode = (): AotNode => ({ kind: "component", id: 0, component: "Child", props: [], events: [], slots: [{ name: "body", children: [show(read("visible", boolean), [text("slot")])] }], loc });
  const rowKey: AotExpr = { kind: "binding", scope: "local", name: "item", type: string, loc };
  const rows: AotNode = { kind: "for", id: 0, source: read("items", strings), key: rowKey, item: "item", itemType: string, children: [text(rowKey), childNode(), show(read("visible", boolean), [text("deferred")])], loc };
  const app = component("App", [show(literal(false), [text("dead before rows")]), rows, childNode(), childNode()]);
  app.children = ["Child"];
  app.values = [{ name: "items", sourceName: "items", type: strings, writable: false }, { name: "visible", sourceName: "visible", type: boolean, writable: false }];
  return { version: 1, root: "App", components: [child, app], types: [], styles: { records: [], anims: [], ids: {}, bytes: [], usedFontSlots: [] }, diagnostics: [] };
}

test.each([false, true])("harness identities survive pruning, keyed moves, deferred branches, and repeated slots (lifecycle %s)", lifecycle => {
  const directory = resolve(`.pocket-build/validation/microts-specialization/logical-identities-${lifecycle}`);
  mkdirSync(`${directory}/src`, { recursive: true });
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "aot-logical-identities"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "harness"] }\n`);
  for (const specialize of [false, true]) {
    const generated = emitAot(fixture(lifecycle), { specialize, harness: true }).files["app.rs"]!;
    writeFileSync(`${directory}/src/${specialize ? "on" : "off"}.rs`, generated);
  }
  writeFileSync(`${directory}/src/lib.rs`, `
mod off;
mod on;
#[derive(Default)] struct ChildModel;
struct Model { items: Vec<String>, visible: bool }
macro_rules! model {
    ($module:ident) => {
        impl $module::ChildViewModel for ChildModel { fn mounted(&mut self) {} }
        impl $module::AppViewModel for Model {
            type Child = ChildModel;
            fn items(&self) -> &[String] { &self.items }
            fn visible(&self) -> bool { self.visible }
        }
    }
}
model!(off); model!(on);
fn snapshot(ui: &microts::Ui) -> Vec<(String, String)> {
    fn walk(ui: &microts::Ui, parent: i32, rows: &mut Vec<(String, String)>) {
        for &node in ui.core().node_children(parent) {
            let identity = ui.logical_node(microts::NodeId(node)).expect("every generated node registered");
            rows.push((identity.to_owned(), ui.core().node_text(node).unwrap_or("").to_owned()));
            walk(ui, node, rows);
        }
    }
    let mut rows = Vec::new(); walk(ui, microts::NodeId::ROOT.0, &mut rows);
    rows.sort();
    for pair in rows.windows(2) { assert_ne!(pair[0].0, pair[1].0, "identity collision"); }
    rows
}
#[test] fn stable_under_specialization_and_reorder() {
    let initial_model = || Model { items: vec!["a".into(), "b/key:[]".into()], visible: false };
    let mut a = off::AppApp::new(microts::CoreHost::new(), off::AppProps {}, initial_model());
    let mut b = on::AppApp::new(microts::CoreHost::new(), on::AppProps {}, initial_model());
    a.frame(&microts::Input::default()); b.frame(&microts::Input::default());
    let initial = snapshot(a.ui()); assert_eq!(initial, snapshot(b.ui()));
    a.model.items.reverse(); a.model.visible = true;
    b.model.items.reverse(); b.model.visible = true; a.invalidate(); b.invalidate();
    a.frame(&microts::Input::default()); b.frame(&microts::Input::default());
    let expanded = snapshot(a.ui()); assert_eq!(expanded, snapshot(b.ui()));
    for row in &initial { assert!(expanded.contains(row), "existing logical identity changed"); }
    assert!(expanded.len() > initial.len());
    a.model.items.remove(0); a.model.items.push("new:key/[]".into());
    b.model.items.remove(0); b.model.items.push("new:key/[]".into()); a.invalidate(); b.invalidate();
    a.frame(&microts::Input::default()); b.frame(&microts::Input::default());
    assert_eq!(snapshot(a.ui()), snapshot(b.ui()));
    assert_eq!(a.ui().logical_scope(), ""); assert_eq!(b.ui().logical_scope(), "");
}
`);
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", `${directory}/Cargo.toml`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/identity-target") } });
  writeFileSync(`${directory}/cargo.log`, result.stdout.toString() + result.stderr.toString());
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 120_000);

test("ordinary generated Rust has no identity instrumentation", () => {
  const source = emitAot(fixture()).files["app.rs"]!;
  expect(source).not.toContain("logical_scope");
  expect(source).not.toContain("register_logical_template");
});
