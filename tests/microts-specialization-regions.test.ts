import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROP, encodeStyleTable, f32Bits, type StyleRecord } from "../contracts/spec/spec.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { createSpecializationContract } from "../microts/compiler/aot-specialization-contract.ts";
import { BOOL, I32, type AotNode, type AotProgram } from "../microts/compiler/aot-ir.ts";

const loc = { file: "regions.tsx", line: 1, column: 1, offset: 0 };
function fixture(): AotProgram {
  const records: StyleRecord[] = [{ base: [
    { prop: PROP.width, value: f32Bits(100) }, { prop: PROP.height, value: f32Bits(80) },
    { prop: PROP.shrink, value: f32Bits(0) }, { prop: PROP.bgColor, value: 0xff0000ff },
  ] }];
  const child: AotNode = { kind: "element", id: 3, tag: "View", style: 0, props: [], focusable: false, events: [], children: [], loc };
  const root: AotNode = { kind: "element", id: 1, tag: "View", style: 0,
    props: [{ prop: PROP.width, name: "width", memo: 0, value: { kind: "literal", value: 120, type: I32, loc } }],
    focusable: false, events: [], children: [{ kind: "if", id: 2, branches: [{ condition: { kind: "binding", scope: "vm", name: "show", type: BOOL, loc }, children: [child] }], loc }], loc };
  return { version: 1, root: "App", types: [], diagnostics: [],
    styles: { records, anims: [], ids: {}, usedFontSlots: [], bytes: [...encodeStyleTable(records, [])] },
    components: [{ name: "App", file: loc.file, root: true, props: [], events: [], slots: [], values: [{ name: "show", sourceName: "show", type: BOOL, writable: false }], functions: [], constants: [], children: [], nodes: [root], nodeCount: 3, memoCount: 1, handlerCount: 0 }],
  };
}

test("generated environment guards defer registration, cover later branches, and deopt without changing output", async () => {
  const input = fixture();
  const contract = createSpecializationContract(input, { viewport: [480, 272], tickRate: 60 });
  const options = { specialize: true, specializationContract: contract };
  const source = emitAot(input, options).files["app.rs"]!;
  expect(source).toContain("queue_layout_region");
  expect(source).toContain("pub fn prepare_specialization");
  expect(source).toContain("pub fn specialization_diagnostics");
  expect(emitAot(input, { ...options, specialize: false }).files["app.rs"]).not.toContain("SPECIALIZATION_CONTRACT");
  const directory = resolve(".pocket-build/validation/microts-specialization", `region-app-${process.pid}-${Date.now()}`);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname = "specialization-region-app"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "counters"] }\n`);
  writeFileSync(resolve(directory, "src/on.rs"), source);
  writeFileSync(resolve(directory, "src/off.rs"), emitAot(input).files["app.rs"]!);
  writeFileSync(resolve(directory, "src/main.rs"), `mod on; mod off;
use microts::{Ui, Input, NodeId};
#[derive(Default)] struct Model { show: bool }
impl on::AppViewModel for Model { fn show(&self) -> bool { self.show } }
impl off::AppViewModel for Model { fn show(&self) -> bool { self.show } }
const STYLES: &[u8] = &[${input.styles.bytes.join(",")}];
fn host(prepare: bool) -> Ui {
  let mut ui = Ui::new();
  if prepare { on::prepare_specialization(&mut ui); }
  assert!(ui.load_styles(STYLES)); ui
}
fn main() {
  let mut app = on::AppApp::new(host(true), on::AppProps {}, Model::default());
  let mut reference = off::AppApp::new(host(false), off::AppProps {}, Model::default());
  assert!(app.specialization_enabled());
  assert!(app.specialization_diagnostics().is_empty());
  let root = app.ui().core().node_children(NodeId::ROOT.0)[0];
  assert!(!app.ui().core().is_layout_region(root)); // width=120 first writes during update.
  for show in [false, true, false, true] {
    app.model.show = show; reference.model.show = show;
    app.invalidate(); reference.invalidate();
    app.frame(&Input::default()); reference.frame(&Input::default());
    assert!(app.ui().core().is_layout_region(root));
    assert_eq!(app.ui().core().layout_of(root).unwrap().2, 120.0);
    let children = app.ui().core().node_children(root);
    assert_eq!(children.len(), show as usize);
    for child in children { assert!(app.ui().core().is_layout_region(*child)); }
    assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
  }
  app.ui_mut().core_mut().set_viewport(320.0, 240.0);
  reference.ui_mut().core_mut().set_viewport(320.0, 240.0);
  app.frame(&Input::default()); reference.frame(&Input::default());
  assert!(!app.specialization_enabled());
  assert_eq!(app.specialization_diagnostics()[0].code(), "VS201");
  assert!(!app.ui().core().is_layout_region(root));
  assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
  app.ui_mut().core_mut().set_viewport(480.0, 272.0);
  app.frame(&Input::default()); assert!(!app.specialization_enabled());
  let missing = on::AppApp::new(host(false), on::AppProps {}, Model::default());
  assert!(!missing.specialization_enabled()); assert_eq!(missing.specialization_diagnostics()[0].code(), "VS204");
  let mut resized = host(true); resized.core_mut().set_viewport(100.0, 100.0);
  let resized = on::AppApp::new(resized, on::AppProps {}, Model::default());
  assert!(!resized.specialization_enabled()); assert_eq!(resized.specialization_diagnostics()[0].code(), "VS201");
  let mut native = host(true); native.core_mut().set_text_measure(Some(Box::new(|_,_,_,_|(1.0,1.0))));
  let native = on::AppApp::new(native, on::AppProps {}, Model::default());
  assert!(!native.specialization_enabled()); assert_eq!(native.specialization_diagnostics()[0].code(), "VS203");
}
`);
  const child = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") }, stdout: "pipe", stderr: "pipe" });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(resolve(directory, "cargo.log"), output + errors);
  expect(status, output + errors).toBe(0);
}, 120_000);
