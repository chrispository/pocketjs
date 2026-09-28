import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROP, encodeStyleTable, f32Bits, type StyleRecord } from "../contracts/spec/spec.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { bakeAotSpecialization, specializationBakeTarget } from "../microts/compiler/aot-specialization-bake.ts";
import { createSpecializationContract } from "../microts/compiler/aot-specialization-contract.ts";
import { I32, type AotNode, type AotProgram } from "../microts/compiler/aot-ir.ts";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { executeSpecialization } from "../microts/compiler/specialization-harness.ts";
import { createStaticDrawPlans } from "../microts/compiler/aot-static-draw-plan.ts";

const loc = { file: "baking.tsx", line: 1, column: 1, offset: 0 };
const font = Uint8Array.from([68, 67, 70, 65, 3, 0, 3, 0, 1, 1, 1, 3, 0, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 2, 0, 65, 0, 0, 0, 1, 0, 3, 0, 66, 0, 0, 0, 2, 0, 4, 0, 255, 255, 255]);
const environment = { viewport: [480, 272] as const, tickRate: 60, fontAtlases: [{ slot: 0, bytes: font }] };
function fixture(width: number, padding: number): AotProgram {
  const records: StyleRecord[] = [
    { base: [
      { prop: PROP.width, value: f32Bits(width) }, { prop: PROP.height, value: f32Bits(80.5) },
      { prop: PROP.shrink, value: f32Bits(0) }, { prop: PROP.bgColor, value: 0xff0000ff },
      { prop: PROP.paddingL, value: f32Bits(padding) }, { prop: PROP.paddingT, value: f32Bits(padding) },
    ] },
    { base: [{ prop: PROP.width, value: f32Bits(33.5) }, { prop: PROP.height, value: f32Bits(8.5) }, { prop: PROP.bgColor, value: 0xff00ff00 }] },
    { base: [{ prop: PROP.tracking, value: f32Bits(0.5) }] },
  ];
  const element = (id: number, style: number, children: AotNode[] = [], text?: string): AotNode => ({ kind: "element", id, tag: text ? "Text" : "View", style, props: [], focusable: false, events: [], children, ...(text ? { text: { parts: [text], memo: id } } : {}), loc });
  const nodes = [element(1, 0, [element(2, 1), element(3, 2, [], "AB\nA")])];
  return { version: 1, root: "App", types: [], diagnostics: [], styles: { records, anims: [], ids: {}, usedFontSlots: [0], bytes: [...encodeStyleTable(records, [])] },
    components: [{ name: "App", file: loc.file, root: true, props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 3, memoCount: 0, handlerCount: 0 }],
  };
}

test("baking is disabled for unknown and device targets without a target golden", async () => {
  for (const target of [undefined, "psp", "esp32", "unknown"]) {
    const bake = await bakeAotSpecialization(fixture(100, 0), { target, environment });
    expect(bake.target).toBeNull(); expect(bake.regions).toEqual([]); expect(bake.textSizes).toEqual([]);
    expect(bake.diagnostics[0]).toContain("no target golden");
  }
});

test.skipIf(specializationBakeTarget("host") === null)("guest no_std rounding is not admitted as a host std seed", async () => {
  const input = fixture(100.499992, 0.49999997);
  const target = resolve(".pocket-build/validation/microts-specialization/guest-inspect-target");
  const cargo = Bun.spawn(["cargo", "build", "--quiet", "--release", "--features", "specialization-inspect", "--target", "wasm32-unknown-unknown", "--manifest-path", resolve("engine/wasm/Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: "pipe", stderr: "pipe" });
  const [status, errors] = await Promise.all([cargo.exited, new Response(cargo.stderr).text(), new Response(cargo.stdout).text()]);
  expect(status, errors).toBe(0);
  const guest = await createWasmUi(await Bun.file(resolve(target, "wasm32-unknown-unknown/release/pocketjs_wasm.wasm")).arrayBuffer());
  guest.ops.loadStyles!(Uint8Array.from(input.styles.bytes)); guest.ops.loadFontAtlas!(font);
  const root = guest.ops.createNode(0), child = guest.ops.createNode(0), text = guest.ops.createNode(1);
  guest.ops.insertBefore(1, root, 0); guest.ops.insertBefore(root, child, 0); guest.ops.insertBefore(root, text, 0);
  guest.ops.setStyle(root, 0); guest.ops.setStyle(child, 1); guest.ops.setStyle(text, 2); guest.ops.setText(text, "AB\nA");
  guest.tick();
  const layout = guest.exports.ui_specialization_layout as (id: number, component: number) => number;
  const host = await bakeAotSpecialization(input, { target: "host", environment });
  expect(layout(child, 0)).toBe(0);
  expect(host.regions[0]!.nodes[1]!.rect.x).toBe(1);
  expect(host.target).toBe("aarch64-apple-darwin-std");
}, 120_000);

test.skipIf(specializationBakeTarget("host") === null)("Build text sizes are budgeted even when their enclosing layout stays live", async () => {
  const input = fixture(100, 0), root = input.components[0]!.nodes[0]!;
  if (root.kind !== "element") throw new Error("expected view fixture");
  root.props.push({ prop: PROP.width, name: "width", memo: 0, value: { kind: "binding", scope: "vm", name: "width", type: I32, loc } });
  input.components[0]!.values.push({ name: "width", sourceName: "width", type: I32, writable: false });
  const bake = await bakeAotSpecialization(input, { target: "aarch64-apple-darwin-std", environment });
  expect(bake.regions).toEqual([]);
  expect(bake.textSizes).toHaveLength(1);
  const narrowed = await bakeAotSpecialization(fixture(100, 0), { target: "host", environment: { ...environment, fontSlots: [] } });
  expect(narrowed.regions).toEqual([]);
  expect(narrowed.textSizes).toEqual([]);
}, 120_000);

test.skipIf(specializationBakeTarget("host") === null)("unproven raw f32 and newtype literals never enter layout or shape seeds", async () => {
  const rawNumber = "1.4999999403953552";
  for (const name of ["f32", "Px"] as const) {
    const input = fixture(20, 0);
    if (name === "Px") input.types.push({ kind: "newtype", name: "Px", base: { kind: "number", name: "f32" }, unit: "Px" });
    const type = name === "Px" ? { kind: "named" as const, name } : { kind: "number" as const, name };
    const root = input.components[0]!.nodes[0]!;
    if (root.kind !== "element" || root.children[0]!.kind !== "element" || root.children[1]!.kind !== "element") throw new Error("expected element fixture");
    root.children[0]!.props.push({ prop: PROP.width, name: "width", memo: 1, value: { kind: "literal", value: Number(rawNumber), rawNumber, type, loc } });
    root.children[1]!.props.push({ prop: PROP.tracking, name: "tracking", memo: 2, value: { kind: "literal", value: Number(rawNumber), rawNumber, type, loc } });
    let bake = await bakeAotSpecialization(input, { target: "host", environment });
    expect(bake.regions).toEqual([]); expect(bake.textSizes).toEqual([]);
    root.children[1]!.props[0]!.prop = PROP.lineHeight; root.children[1]!.props[0]!.name = "lineHeight";
    bake = await bakeAotSpecialization(input, { target: "host", environment });
    expect(bake.regions).toEqual([]); expect(bake.textSizes).toEqual([]);
  }
}, 120_000);

test.skipIf(specializationBakeTarget("host") === null)("raw f32 midpoint fixture retains native words and pixels with host baking enabled", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization", `bake-midpoint-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, entry: "App.tsx" } }));
  writeFileSync(resolve(directory, "App.tsx"), `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View style={{width:20,height:10,shrink:0}}><View style={{width:1.4999999403953552,height:8,shrink:0}} class="bg-red-500"/></View>;}`);
  const result = await executeSpecialization(directory, { specializationTarget: "host", modelSource: "struct Model; impl AppViewModel for Model {}", modelExpression: "Model", tape: [{}, { invalidate: true }] });
  expect(result.specialized.frames[0]!.words).toEqual(result.reference.frames[0]!.words);
  expect(result.specialized.frames[1]!.words).toEqual(result.reference.frames[1]!.words);
}, 180_000);

test.skipIf(specializationBakeTarget("host") === null)("missing glyphs preserve measurement and painting miss counts with text-size seeds", async () => {
  const input = fixture(100, 0), root = input.components[0]!.nodes[0]!;
  if (root.kind !== "element" || root.children[1]!.kind !== "element") throw new Error("expected text fixture");
  root.children[1]!.text!.parts = ["Z\nZ"];
  const bake = await bakeAotSpecialization(input, { target: "host", environment });
  const plans = createStaticDrawPlans(input, bake.regions, environment).plans;
  expect(bake.regions).toEqual([]); expect(plans).toEqual([]);
  expect(bake.diagnostics).toEqual([expect.stringContaining("missing glyphs require runtime miss-count effects")]);
  expect(bake.textSizes).toHaveLength(1);
  const directory = resolve(".pocket-build/validation/microts-specialization", `bake-missing-${process.pid}-${Date.now()}`);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname = "specialization-missing-glyphs"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "counters"] }\n`);
  writeFileSync(resolve(directory, "src/on.rs"), emitAot(input, { specialize: true, specializationContract: createSpecializationContract(input, environment), specializationBake: bake, staticDrawPlans: plans }).files["app.rs"]!);
  writeFileSync(resolve(directory, "src/off.rs"), emitAot(input).files["app.rs"]!);
  writeFileSync(resolve(directory, "src/main.rs"), `use microts::{Ui, Input};
mod on; mod off;
struct Model; impl on::AppViewModel for Model {} impl off::AppViewModel for Model {}
const FONT: &[u8] = &[${[...font].join(",")}]; const STYLES: &[u8] = &[${input.styles.bytes.join(",")}];
fn host(specialized: bool) -> Ui {
  let mut ui = Ui::new(); if specialized { on::prepare_specialization(&mut ui); }
  assert!(ui.load_styles(STYLES)); assert!(ui.core_mut().load_font_atlas(FONT)); ui
}
fn main() {
  let mut app = on::AppApp::new(host(true), on::AppProps {}, Model);
  let mut reference = off::AppApp::new(host(false), off::AppProps {}, Model);
  assert!(app.specialization_enabled()); assert!(app.ui().core().shaped_size_cache_bytes() > 0);
  assert_eq!(app.ui().core().glyph_misses(), 0);
  for _ in 0..3 {
    app.invalidate(); reference.invalidate();
    app.frame(&Input::default()); reference.frame(&Input::default());
    assert_eq!(app.ui().core().glyph_misses(), reference.ui().core().glyph_misses());
    assert!(app.ui().core().glyph_misses() > 0);
    for _ in 0..2 {
      let before = app.ui().core().glyph_misses();
      assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
      assert_eq!(app.ui().core().glyph_misses(), reference.ui().core().glyph_misses());
      assert!(app.ui().core().glyph_misses() > before);
    }
  }
  assert_eq!(app.ui().core().counters().draw.static_plan_hits, 0);
  assert_eq!(app.ui().core().counters().layout.shaping_calls, 0);
  assert!(app.ui().core().counters().layout.shaping_cache_hits > 0);
  assert!(reference.ui().core().counters().layout.shaping_calls > 0);
}
`);
  const child = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") }, stdout: "pipe", stderr: "pipe" });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(resolve(directory, "cargo.log"), output + errors);
  expect(status, output + errors).toBe(0);
}, 120_000);

test.skipIf(specializationBakeTarget("host") === null)("aarch64-apple-darwin golden matches wasm layouts at rounding edges and guards baked seeds", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization", `bake-${process.pid}-${Date.now()}`);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname = "specialization-bake-golden"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nmicrots = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "counters"] }\n`);
  const declarations: string[] = [], cases: string[] = [];
  for (const [index, [width, padding]] of [[100.5, 0.5], [100.499992, 0.49999997], [101.500008, 1.5]].entries()) {
    const input = fixture(width!, padding!), before = JSON.stringify(input);
    const bake = await bakeAotSpecialization(input, { target: "host", environment });
    expect(JSON.stringify(input)).toBe(before);
    expect(bake.target).toBe("aarch64-apple-darwin-std");
    expect(bake.regions).toHaveLength(1); expect(bake.textSizes).toHaveLength(1);
    expect(bake.regions[0]!.guard.unroundedOrigin).toEqual([0, 0]);
    expect(bake.textSizes[0]).toMatchObject({ slot: 0, text: "AB\nA", tracking: 0.5, lineHeight: null });
    const name = `case${index}`, contract = createSpecializationContract(input, environment);
    writeFileSync(resolve(directory, `src/${name}on.rs`), emitAot(input, { specialize: true, specializationContract: contract, specializationBake: bake }).files["app.rs"]!);
    writeFileSync(resolve(directory, `src/${name}off.rs`), emitAot(input).files["app.rs"]!);
    const missingFonts = await bakeAotSpecialization(input, { target: "host", environment: { ...environment, fontAtlases: [] } });
    expect(missingFonts.regions).toEqual([]); expect(missingFonts.diagnostics[0]).toContain("atlas bytes");
    const roundedBits = bake.regions[0]!.nodes.map(node => [node.rect.x, node.rect.y, node.rect.width, node.rect.height].map(f32Bits));
    declarations.push(`mod ${name}on; mod ${name}off;
impl ${name}on::AppViewModel for Model {} impl ${name}off::AppViewModel for Model {}`);
    cases.push(`{
      const STYLES: &[u8] = &[${input.styles.bytes.join(",")}];
      let mut native_host = host(STYLES); ${name}on::prepare_specialization(&mut native_host);
      // Exact content identities must be captured before asset loading.
      assert!(native_host.load_styles(STYLES)); assert!(native_host.core_mut().load_font_atlas(FONT));
      let mut app = ${name}on::AppApp::new(native_host, ${name}on::AppProps {}, Model);
      let mut reference = ${name}off::AppApp::new(host(STYLES), ${name}off::AppProps {}, Model);
      assert!(app.specialization_enabled()); assert!(app.ui().core().shaped_size_cache_bytes() > 0);
      app.frame(&Input::default()); reference.frame(&Input::default());
      assert_eq!(rects(app.ui()), vec!${JSON.stringify(roundedBits)});
      assert_eq!(rects(reference.ui()), rects(app.ui()));
      assert_eq!(app.ui_mut().core_mut().draw().words, reference.ui_mut().core_mut().draw().words);
      assert_eq!(app.ui().core().counters().layout.shaping_calls, 0);
      assert!(reference.ui().core().counters().layout.shaping_calls > 0);
      // A host root override is not an environment identity. The raw placement
      // guard must fall back, while the independent shaped-size seed stays valid.
      let mut shifted = host(STYLES); ${name}on::prepare_specialization(&mut shifted);
      assert!(shifted.load_styles(STYLES)); assert!(shifted.core_mut().load_font_atlas(FONT));
      shifted.core_mut().set_prop(1, ${PROP.paddingL}, 0.5);
      let mut shifted = ${name}on::AppApp::new(shifted, ${name}on::AppProps {}, Model);
      let mut off = host(STYLES); off.core_mut().set_prop(1, ${PROP.paddingL}, 0.5);
      let mut off = ${name}off::AppApp::new(off, ${name}off::AppProps {}, Model);
      shifted.frame(&Input::default()); off.frame(&Input::default());
      assert_eq!(rects(shifted.ui()), rects(off.ui()));
      assert_eq!(shifted.ui_mut().core_mut().draw().words, off.ui_mut().core_mut().draw().words);
      assert!(shifted.ui().core().counters().layout.shaping_cache_hits > 0);
      assert!(shifted.ui().core().shaped_size_cache_bytes() <= 32768);
      app.ui_mut().reset_counters(); reference.ui_mut().reset_counters();
      assert!(app.ui_mut().core_mut().load_font_atlas(FONT)); assert!(reference.ui_mut().core_mut().load_font_atlas(FONT));
      app.frame(&Input::default()); reference.frame(&Input::default());
      assert!(app.specialization_enabled());
      assert!(app.ui().core().counters().layout.shaping_calls > 0);
      assert_eq!(rects(app.ui()), rects(reference.ui()));
    }`);
  }
  writeFileSync(resolve(directory, "src/main.rs"), `use microts::{Ui, Input};
${declarations.join("\n")}
struct Model;
const FONT:&[u8]=&[${[...font].join(",")}];
fn host(styles:&[u8])->Ui { let mut ui=Ui::new(); assert!(ui.load_styles(styles)); assert!(ui.core_mut().load_font_atlas(FONT)); ui }
fn rects(ui:&Ui)->Vec<[u32;4]> {
  fn visit(ui:&Ui,id:i32,result:&mut Vec<[u32;4]>) { let (x,y,w,h)=ui.core().layout_of(id).unwrap(); result.push([x.to_bits(),y.to_bits(),w.to_bits(),h.to_bits()]); for child in ui.core().node_children(id) { visit(ui,*child,result); } }
  let mut result=Vec::new(); for child in ui.core().node_children(1) {visit(ui,*child,&mut result);} result
}
fn main(){
  assert!(!microts::specialization::baking_target_matches("aarch64-apple-darwin"));
  assert!(microts::specialization::baking_target_matches("aarch64-apple-darwin-std"));
  ${cases.join("\n")}
}
`);
  const child = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") }, stdout: "pipe", stderr: "pipe" });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(resolve(directory, "cargo.log"), output + errors);
  expect(status, output + errors).toBe(0);
}, 120_000);
