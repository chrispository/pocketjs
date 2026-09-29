// Harness builds register a logical identity for every generated node, so the
// oracle can compare reference and specialized runs node by node.
import { expect, test } from "bun:test";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { BOOL, STRING, type AotExpr, type AotNode, type AotType } from "../microts/compiler/aot-ir.ts";
import { component, emitPair, handler, instance, lit, loc, local, program, runCrate, show, text, vm } from "./helpers/microts-specialization.ts";

/** Pruned branches, keyed rows that nest a component, deferred branches, and a slot rendered twice. */
function fixture(mountHook: boolean) {
  const strings: AotType = { kind: "array", element: STRING };
  const label = (value: string | AotExpr) => ({ ...text([value]), focusable: true });
  const body = (): AotNode => ({ kind: "slot", id: 0, name: "body", fallback: [], loc });
  const mounted = handler("mounted");
  const child = component("Child", [show(lit(false), [label("dead")]), show(lit(true), [label("child")]), body(), body()], {
    factory: { name: "createChild", sourceName: "createChild", module: "./Child" }, slots: ["body"], functions: [mounted.method],
    ...(mountHook ? { hooks: { mount: mounted.call } } : {}),
  });
  const withBody = () => instance("Child", { slots: [{ name: "body", children: [show(vm("visible", BOOL), [label("slot")])] }] });
  const key = local("item", STRING);
  const rows: AotNode = { kind: "for", id: 0, source: vm("items", strings), key, item: "item", itemType: STRING, loc,
    children: [label(key), withBody(), show(vm("visible", BOOL), [label("deferred")])] };
  return program(component("App", [show(lit(false), [label("dead before rows")]), rows, withBody(), withBody()], {
    children: ["Child"], values: [{ name: "items", sourceName: "items", type: strings, writable: false }, { name: "visible", sourceName: "visible", type: BOOL, writable: false }],
  }), { components: [child] });
}

test.each([false, true])("identities match across builds and survive keyed moves and new branches (mount hook: %p)", mountHook => {
  runCrate(`aot-logical-identities-${mountHook}`, { ...emitPair(fixture(mountHook), { harness: true }), "lib.rs": `mod off; mod on;
use microts::{CoreHost, Input, NodeId, Ui};
#[derive(Default)] struct ChildModel;
struct Model { items: Vec<String>, visible: bool }
macro_rules! model { ($m:ident) => {
  impl $m::ChildViewModel for ChildModel { fn mounted(&mut self) {} }
  impl $m::AppViewModel for Model { type Child = ChildModel; fn items(&self) -> &[String] { &self.items } fn visible(&self) -> bool { self.visible } }
}; }
model!(off); model!(on);
/// Sorted (identity, text) pairs for every node; identities must be unique.
fn snapshot(ui: &Ui) -> Vec<(String, String)> {
  fn walk(ui: &Ui, parent: i32, rows: &mut Vec<(String, String)>) {
    for &node in ui.core().node_children(parent) {
      let identity = ui.logical_node(NodeId(node)).expect("every generated node is registered");
      rows.push((identity.to_owned(), ui.core().node_text(node).unwrap_or("").to_owned()));
      walk(ui, node, rows);
    }
  }
  let mut rows = Vec::new();
  walk(ui, NodeId::ROOT.0, &mut rows);
  rows.sort();
  assert!(rows.windows(2).all(|pair| pair[0].0 != pair[1].0), "identity collision");
  rows
}
#[test] fn identities() {
  // Keys contain the characters identities use as separators.
  let model = || Model { items: vec!["a".into(), "b/key:[]".into()], visible: false };
  let mut off = off::AppApp::new(CoreHost::new(), off::AppProps {}, model());
  let mut on = on::AppApp::new(CoreHost::new(), on::AppProps {}, model());
  let mut step = |edit: fn(&mut Model)| {
    edit(&mut off.model); edit(&mut on.model);
    off.invalidate(); on.invalidate();
    off.frame(&Input::default()); on.frame(&Input::default());
    let rows = snapshot(off.ui());
    assert_eq!(rows, snapshot(on.ui()));
    rows
  };
  let initial = step(|_| {});
  let expanded = step(|m| { m.items.reverse(); m.visible = true; });
  assert!(initial.iter().all(|row| expanded.contains(row)), "an existing identity changed");
  assert!(expanded.len() > initial.len());
  step(|m| { m.items.remove(0); m.items.push("new:key/[]".into()); });
  assert_eq!((off.ui().logical_scope(), on.ui().logical_scope()), ("", ""));
}` }, ["std", "harness"]);
}, 120_000);

test("builds without the harness carry no identity code", () => {
  const source = emitAot(fixture(false)).files["app.rs"]!;
  expect(source).not.toContain("logical_scope");
  expect(source).not.toContain("register_logical_template");
});
