// Baked layout and text-size seeds. The compiler runs the host's own layout
// ahead of time and ships the rects only for a target whose floating-point
// results it has verified; each seed is guarded again at runtime.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { PROP, f32Bits } from "../contracts/spec/spec.ts";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { I32, type AotProgram } from "../microts/compiler/aot-ir.ts";
import { bakeAotSpecialization, specializationBakeTarget } from "../microts/compiler/aot-specialization-bake.ts";
import { createSpecializationContract } from "../microts/compiler/aot-specialization-contract.ts";
import { createStaticDrawPlans } from "../microts/compiler/aot-static-draw-plan.ts";
import { OUT, emitPair, fontAtlas, freeze, num, program, raw, runApp, runCrate, rustBytes, text, view, vm, type Element } from "./helpers/microts-specialization.ts";

const font = fontAtlas({ lineHeight: 3, tofu: 2, glyphs: { A: 3, B: 4 } });
const environment = { viewport: [480, 272] as const, tickRate: 60, fontAtlases: [{ slot: 0, bytes: font }] };
const onHost = test.skipIf(specializationBakeTarget("host") === null);

/** root (width x 80.5, padding) -> [33.5x8.5 box, text "AB\nA" with 0.5 tracking]. */
function scene(width: number, padding: number): AotProgram {
  const px = (prop: number, value: number) => ({ prop, value: f32Bits(value) });
  const styles = [
    { base: [px(PROP.width, width), px(PROP.height, 80.5), px(PROP.shrink, 0), px(PROP.paddingL, padding), px(PROP.paddingT, padding), { prop: PROP.bgColor, value: 0xff0000ff }] },
    { base: [px(PROP.width, 33.5), px(PROP.height, 8.5), { prop: PROP.bgColor, value: 0xff00ff00 }] },
    { base: [px(PROP.tracking, 0.5)] },
  ];
  const label = { ...text(["AB\nA"], 3), style: 2 };
  return program([view(0, [view(1, [], 2), label], 1)], { styles, fontSlots: [0] });
}
const children = (input: AotProgram) => (input.components[0]!.nodes[0] as Element).children as Element[];

/** Rust helpers shared by the native bake tests. */
const PRELUDE = `use microts::{Input, Ui};
struct Model;
const FONT: &[u8] = ${rustBytes(font)};
/// Every rect below the root, as f32 bits.
fn rects(ui: &Ui) -> Vec<[u32; 4]> {
  fn visit(ui: &Ui, id: i32, out: &mut Vec<[u32; 4]>) {
    let (x, y, w, h) = ui.core().layout_of(id).unwrap();
    out.push([x, y, w, h].map(f32::to_bits));
    for child in ui.core().node_children(id) { visit(ui, *child, out); }
  }
  let mut out = Vec::new();
  for child in ui.core().node_children(microts::NodeId::ROOT.0) { visit(ui, *child, &mut out); }
  out
}`;

test("baking needs a target with a verified golden", async () => {
  for (const target of [undefined, "psp", "esp32", "unknown"]) {
    const bake = await bakeAotSpecialization(scene(100, 0), { target, environment });
    expect(bake).toMatchObject({ target: null, regions: [], textSizes: [] });
    expect(bake.diagnostics[0]).toContain("no target golden");
  }
});

onHost("the wasm guest rounds differently, so guest layouts are never host seeds", async () => {
  const input = scene(100.499992, 0.49999997);
  const target = resolve(OUT, "guest-inspect-target");
  const cargo = Bun.spawnSync(["cargo", "build", "--quiet", "--release", "--features", "specialization-inspect", "--target", "wasm32-unknown-unknown", "--manifest-path", resolve("engine/wasm/Cargo.toml")],
    { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: "pipe", stderr: "pipe" });
  expect(cargo.exitCode, cargo.stderr.toString()).toBe(0);
  const guest = await createWasmUi(await Bun.file(resolve(target, "wasm32-unknown-unknown/release/pocketjs_wasm.wasm")).arrayBuffer());
  const { ops } = guest;
  ops.loadStyles!(Uint8Array.from(input.styles.bytes));
  ops.loadFontAtlas!(font);
  const [root, box, label] = [ops.createNode(0), ops.createNode(0), ops.createNode(1)];
  ops.insertBefore(1, root, 0); ops.insertBefore(root, box, 0); ops.insertBefore(root, label, 0);
  ops.setStyle(root, 0); ops.setStyle(box, 1); ops.setStyle(label, 2); ops.setText(label, "AB\nA");
  guest.tick();
  const guestX = guest.exports.ui_specialization_layout as (id: number, component: number) => number;
  const host = await bakeAotSpecialization(input, { target: "host", environment });
  expect(host.target).toBe("aarch64-apple-darwin-std");
  expect([guestX(box, 0), host.regions[0]!.nodes[1]!.rect.x]).toEqual([0, 1]); // the same box
}, 120_000);

onHost("Build text sizes are baked even when the enclosing layout stays live", async () => {
  const input = scene(100, 0);
  const root = input.components[0]!.nodes[0] as Element;
  root.props.push({ prop: PROP.width, name: "width", memo: 0, value: vm("width") });
  input.components[0]!.values.push({ name: "width", sourceName: "width", type: I32, writable: false });
  expect(await bakeAotSpecialization(input, { target: "aarch64-apple-darwin-std", environment })).toMatchObject({ regions: [], textSizes: [{ text: "AB\nA" }] });
  // A contract without font slots cannot seed any text size.
  const noFonts = await bakeAotSpecialization(scene(100, 0), { target: "host", environment: { ...environment, fontSlots: [] } });
  expect(noFonts).toMatchObject({ regions: [], textSizes: [] });
}, 120_000);

onHost("f32 and newtype literals without a proven f32 value never seed layout or shaping", async () => {
  for (const type of [num("f32"), { kind: "named" as const, name: "Px" }]) {
    const input = scene(20, 0);
    input.types.push({ kind: "newtype", name: "Px", base: num("f32"), unit: "Px" });
    const [box, label] = children(input);
    const value = raw("1.4999999403953552", type); // a decimal next to the f32 just below 1.5
    box!.props.push({ prop: PROP.width, name: "width", memo: 1, value });
    for (const [prop, name] of [[PROP.tracking, "tracking"], [PROP.lineHeight, "lineHeight"]] as const) {
      label!.props = [{ prop, name, memo: 2, value }];
      expect(await bakeAotSpecialization(input, { target: "host", environment })).toMatchObject({ regions: [], textSizes: [] });
    }
  }
}, 120_000);

onHost("a raw f32 midpoint width renders like the reference with host baking", async () => {
  // The harness throws on any observable difference between the two builds.
  await runApp("bake-midpoint", { "App.tsx": `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View style={{width:20,height:10,shrink:0}}><View style={{width:1.4999999403953552,height:8,shrink:0}} class="bg-red-500"/></View>;}` },
  { specializationTarget: "host", tape: [{}, { invalidate: true }] });
}, 180_000);

onHost("text-size seeds keep the glyph-miss counts of missing glyphs", async () => {
  const input = scene(100, 0);
  children(input)[1]!.text!.parts = ["Z\nZ"]; // 'Z' is not in the atlas
  const bake = await bakeAotSpecialization(input, { target: "host", environment });
  const plans = createStaticDrawPlans(input, bake.regions, environment).plans;
  expect(bake).toMatchObject({ regions: [], textSizes: [{ text: "Z\nZ" }], diagnostics: [expect.stringContaining("missing glyphs require runtime miss-count effects")] });
  expect(plans).toEqual([]);
  const sources = emitPair(input, { specializationContract: createSpecializationContract(input, environment), specializationBake: bake, staticDrawPlans: plans });
  runCrate("specialization-missing-glyphs", { ...sources, "main.rs": `mod on; mod off;
${PRELUDE}
impl on::AppViewModel for Model {} impl off::AppViewModel for Model {}
fn host(prepare: bool) -> Ui {
  let mut ui = Ui::new();
  if prepare { on::prepare_specialization(&mut ui); }
  assert!(ui.load_styles(${rustBytes(input.styles.bytes)}) && ui.core_mut().load_font_atlas(FONT));
  ui
}
fn main() {
  let mut app = on::AppApp::new(host(true), on::AppProps {}, Model);
  let mut reference = off::AppApp::new(host(false), off::AppProps {}, Model);
  assert!(app.specialization_enabled() && app.ui().core().shaped_size_cache_bytes() > 0);
  let misses = |ui: &Ui| ui.core().glyph_misses();
  assert_eq!(misses(app.ui()), 0);
  for _ in 0..3 {
    app.invalidate(); reference.invalidate();
    app.frame(&Input::default()); reference.frame(&Input::default());
    assert!(misses(app.ui()) > 0);
    assert_eq!(misses(app.ui()), misses(reference.ui()));
    for _ in 0..2 { // each draw counts its misses again
      let before = misses(app.ui());
      assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
      assert!(misses(app.ui()) > before);
      assert_eq!(misses(app.ui()), misses(reference.ui()));
    }
  }
  let (app, reference) = (app.ui().core().counters(), reference.ui().core().counters());
  assert_eq!((app.draw.static_plan_hits, app.layout.shaping_calls), (0, 0));
  assert!(app.layout.shaping_cache_hits > 0 && reference.layout.shaping_calls > 0);
}` });
}, 120_000);

onHost("host baking matches live layout at f32 rounding edges and guards its seeds", async () => {
  const modules: Record<string, string> = {}, checks: string[] = [];
  // Widths and paddings at, just below and just above a .5 rounding boundary in f32.
  for (const [index, [width, padding]] of [[100.5, 0.5], [100.499992, 0.49999997], [101.500008, 1.5]].entries()) {
    const input = freeze(scene(width!, padding!));
    const bake = await bakeAotSpecialization(input, { target: "host", environment });
    expect(bake).toMatchObject({
      target: "aarch64-apple-darwin-std", regions: [{ guard: { unroundedOrigin: [0, 0] } }],
      textSizes: [{ slot: 0, text: "AB\nA", tracking: 0.5, lineHeight: null }],
    });
    const withoutAtlas = await bakeAotSpecialization(input, { target: "host", environment: { ...environment, fontAtlases: [] } });
    expect(withoutAtlas.regions).toEqual([]);
    expect(withoutAtlas.diagnostics[0]).toContain("atlas bytes");
    const sources = emitPair(input, { specializationContract: createSpecializationContract(input, environment), specializationBake: bake });
    Object.assign(modules, { [`case${index}_on.rs`]: sources["on.rs"], [`case${index}_off.rs`]: sources["off.rs"] });
    const baked = bake.regions[0]!.nodes.map(({ rect }) => [rect.x, rect.y, rect.width, rect.height].map(f32Bits));
    checks.push(`check!(case${index}_on, case${index}_off, ${rustBytes(input.styles.bytes)}, vec!${JSON.stringify(baked)});`);
  }
  runCrate("specialization-bake-golden", { ...modules, "main.rs": `${Object.keys(modules).map(file => `mod ${file.slice(0, -3)};`).join(" ")}
${PRELUDE}
use microts::pocketjs_core::spec::{prop::PADDING_L, ROOT_ID};
macro_rules! check { ($on:ident, $off:ident, $styles:expr, $baked:expr) => {{
  impl $on::AppViewModel for Model {} impl $off::AppViewModel for Model {}
  let host = |prepare: bool, root_padding: bool| -> Ui {
    let mut ui = Ui::new();
    if prepare { $on::prepare_specialization(&mut ui); } // records identities, so before loading
    assert!(ui.load_styles($styles) && ui.core_mut().load_font_atlas(FONT));
    if root_padding { ui.core_mut().set_prop(ROOT_ID, PADDING_L, 0.5); }
    ui
  };
  let mut app = $on::AppApp::new(host(true, false), $on::AppProps {}, Model);
  let mut reference = $off::AppApp::new(host(false, false), $off::AppProps {}, Model);
  assert!(app.specialization_enabled() && app.ui().core().shaped_size_cache_bytes() > 0);
  app.frame(&Input::default()); reference.frame(&Input::default());
  assert_eq!(rects(app.ui()), $baked);
  assert_eq!(rects(reference.ui()), $baked);
  assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
  assert_eq!(app.ui().core().counters().layout.shaping_calls, 0);
  assert!(reference.ui().core().counters().layout.shaping_calls > 0);
  // Host root padding moves the region: its layout guard fails, but the text-size seed still applies.
  let mut shifted = $on::AppApp::new(host(true, true), $on::AppProps {}, Model);
  let mut shifted_reference = $off::AppApp::new(host(false, true), $off::AppProps {}, Model);
  shifted.frame(&Input::default()); shifted_reference.frame(&Input::default());
  assert_eq!(rects(shifted.ui()), rects(shifted_reference.ui()));
  assert_eq!(shifted.ui_mut().core_mut().draw().words, shifted_reference.ui_mut().core_mut().draw().words);
  assert!(shifted.ui().core().counters().layout.shaping_cache_hits > 0);
  assert!(shifted.ui().core().shaped_size_cache_bytes() <= 32768);
  // Reloading identical atlas bytes keeps the contract; the new revision invalidates cached sizes.
  app.ui_mut().reset_counters(); reference.ui_mut().reset_counters();
  assert!(app.ui_mut().core_mut().load_font_atlas(FONT) && reference.ui_mut().core_mut().load_font_atlas(FONT));
  app.frame(&Input::default()); reference.frame(&Input::default());
  assert!(app.specialization_enabled());
  assert!(app.ui().core().counters().layout.shaping_calls > 0);
  assert_eq!(rects(app.ui()), rects(reference.ui()));
}}; }
fn main() {
  assert!(!microts::specialization::baking_target_matches("aarch64-apple-darwin"));
  assert!(microts::specialization::baking_target_matches("aarch64-apple-darwin-std"));
  ${checks.join("\n  ")}
}` });
}, 120_000);
