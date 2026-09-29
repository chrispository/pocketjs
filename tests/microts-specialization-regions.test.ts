// Generated environment guards. A specialized app registers layout regions
// only while the host matches its compiled contract; otherwise it reports a
// diagnostic and draws exactly like the reference build.
import { expect, test } from "bun:test";
import { PROP, f32Bits } from "../contracts/spec/spec.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { BOOL } from "../microts/compiler/aot-ir.ts";
import { createSpecializationContract } from "../microts/compiler/aot-specialization-contract.ts";
import { component, emitPair, lit, program, runCrate, rustBytes, show, view, vm } from "./helpers/microts-specialization.ts";

test("layout regions follow the environment guard, and a failed guard draws like the reference", () => {
  const box = { base: [
    { prop: PROP.width, value: f32Bits(100) }, { prop: PROP.height, value: f32Bits(80) },
    { prop: PROP.shrink, value: f32Bits(0) }, { prop: PROP.bgColor, value: 0xff0000ff },
  ] };
  const root = view(0, [show(vm("show", BOOL), [view(0)])]);
  root.props.push({ prop: PROP.width, name: "width", memo: 0, value: lit(120) });
  const input = program(component("App", [root], { values: [{ name: "show", sourceName: "show", type: BOOL, writable: false }] }), { styles: [box] });
  const specializationContract = createSpecializationContract(input, { viewport: [480, 272], tickRate: 60 });
  expect(emitAot(input, { specializationContract }).files["app.rs"]).not.toContain("SPECIALIZATION_CONTRACT");
  runCrate("specialization-region-guard", { ...emitPair(input, { specializationContract }), "main.rs": `mod on; mod off;
use microts::{Input, NodeId, Ui};
#[derive(Default)] struct Model { show: bool }
impl on::AppViewModel for Model { fn show(&self) -> bool { self.show } }
impl off::AppViewModel for Model { fn show(&self) -> bool { self.show } }
/// \`prepare\` records content identities, so it runs before assets load.
fn host(prepare: bool) -> Ui {
  let mut ui = Ui::new();
  if prepare { on::prepare_specialization(&mut ui); }
  assert!(ui.load_styles(${rustBytes(input.styles.bytes)}));
  ui
}
macro_rules! frame { ($app:ident, $reference:ident) => {{
  $app.invalidate(); $reference.invalidate();
  $app.frame(&Input::default()); $reference.frame(&Input::default());
  assert_eq!($app.ui_mut().core_mut().draw().words, $reference.ui_mut().core_mut().draw().words);
}}; }
fn main() {
  let mut app = on::AppApp::new(host(true), on::AppProps {}, Model::default());
  let mut reference = off::AppApp::new(host(false), off::AppProps {}, Model::default());
  assert!(app.specialization_enabled() && app.specialization_diagnostics().is_empty());
  let root = app.ui().core().node_children(NodeId::ROOT.0)[0];
  assert!(!app.ui().core().is_layout_region(root), "registration waits for the first update, which writes width=120");
  for show in [false, true, false, true] {
    app.model.show = show; reference.model.show = show;
    frame!(app, reference);
    let core = app.ui().core();
    assert!(core.is_layout_region(root));
    assert_eq!(core.layout_of(root).unwrap().2, 120.0);
    assert_eq!(core.node_children(root).len(), show as usize);
    assert!(core.node_children(root).iter().all(|child| core.is_layout_region(*child)), "a later branch is a region too");
  }
  // VS201: the viewport no longer matches. Regions are dropped for good.
  app.ui_mut().core_mut().set_viewport(320.0, 240.0);
  reference.ui_mut().core_mut().set_viewport(320.0, 240.0);
  frame!(app, reference);
  assert!(!app.specialization_enabled() && !app.ui().core().is_layout_region(root));
  assert_eq!(app.specialization_diagnostics()[0].code(), "VS201");
  app.ui_mut().core_mut().set_viewport(480.0, 272.0);
  app.frame(&Input::default());
  assert!(!app.specialization_enabled());
  // Guards that fail at startup: VS204 no identities, VS201 viewport, VS203 native text.
  let mut resized = host(true);
  resized.core_mut().set_viewport(100.0, 100.0);
  let mut native_text = host(true);
  native_text.core_mut().set_text_measure(Some(Box::new(|_, _, _, _| (1.0, 1.0))));
  for (ui, code) in [(host(false), "VS204"), (resized, "VS201"), (native_text, "VS203")] {
    let app = on::AppApp::new(ui, on::AppProps {}, Model::default());
    assert!(!app.specialization_enabled());
    assert_eq!(app.specialization_diagnostics()[0].code(), code);
  }
}` });
}, 120_000);
