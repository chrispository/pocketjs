import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_FONT_SLOTS, PROP, encodeStyleTable } from "../contracts/spec/spec.ts";
import { I32, type AotNode, type AotProgram } from "../microts/compiler/aot-ir.ts";
import { createSpecializationContract, emitSpecializationContract, specializationContentHash } from "../microts/compiler/aot-specialization-contract.ts";

const loc = { file: "contract.tsx", line: 1, column: 1, offset: 0 };
const text = (props: Extract<AotNode, { kind: "element" }>["props"] = []): AotNode => ({ kind: "element", id: 1, tag: "Text", style: -1, props, focusable: false, events: [], children: [], loc });
const program = (nodes: AotNode[] = [text()]): AotProgram => ({
  version: 1, root: "App", types: [], diagnostics: [],
  components: [{ name: "App", file: loc.file, root: true, props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 1, memoCount: 0, handlerCount: 0 }],
  styles: { records: [], anims: [], ids: {}, bytes: [...encodeStyleTable([], [])], usedFontSlots: [0] },
});
function atlas(slot: number, advance = 1): Uint8Array {
  return Uint8Array.from([68, 67, 70, 65, 3, 0, 1, 0, 1, 1, 1, 1, slot, 0, 1, 0, 0, 0, 0, 0, 0, 0, advance, 0, 255]);
}
const options = { viewport: [480, 272] as const, tickRate: 60 };

test("native contract identities use exact bytes and never annotate the shared IR", () => {
  const input = program();
  const before = JSON.stringify(input);
  Object.freeze(input); Object.freeze(input.styles); Object.freeze(input.styles.bytes);
  const first = createSpecializationContract(input, { ...options, fontAtlases: [{ slot: 0, bytes: atlas(0) }] });
  const same = createSpecializationContract(input, { ...options, fontAtlases: [{ slot: 0, bytes: atlas(0) }] });
  const different = createSpecializationContract(input, { ...options, fontAtlases: [{ slot: 0, bytes: atlas(0, 2) }] });
  expect(first).toEqual(same);
  expect(first.fonts[0]!.hash).not.toBe(different.fonts[0]!.hash);
  expect(first.textProvider).toBe("baked");
  expect(first.diagnostics).toEqual([]);
  expect(first.stylesHash).toBe(specializationContentHash(encodeStyleTable([], [])));
  expect(JSON.stringify(input)).toBe(before);
  expect(specializationContentHash(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("absent atlas bytes are explicit deopt facts, and arbitrary font bindings include all slots", () => {
  const missing = createSpecializationContract(program(), options);
  expect(missing.fonts).toEqual([{ slot: 0, hash: null }]);
  expect(missing.diagnostics).toEqual([{ code: "VS205", slot: 0, message: expect.stringContaining("generic path") }]);
  const dynamic = program([text([{ prop: PROP.fontSlot, name: "fontSlot", memo: 1, value: { kind: "binding", scope: "vm", name: "font", type: I32, loc } }])]);
  expect(createSpecializationContract(dynamic, options).fonts).toHaveLength(MAX_FONT_SLOTS);
  expect(createSpecializationContract(dynamic, { ...options, fontSlots: [4, 1, 4] }).fonts.map(font => font.slot)).toEqual([1, 4]);
  expect(createSpecializationContract(program([]), options).fonts).toEqual([]);
});

test("invalid target facts and mislabeled atlas bytes fail at the compiler boundary", () => {
  for (const viewport of [[NaN, 272], [0, 272], [480, 32001]] as const) expect(() => createSpecializationContract(program(), { ...options, viewport })).toThrow("viewport");
  for (const tickRate of [0, 241, 59.5]) expect(() => createSpecializationContract(program(), { ...options, tickRate })).toThrow("tick rate");
  expect(() => createSpecializationContract(program(), { ...options, fontSlots: [-1] })).toThrow("font slot");
  expect(() => createSpecializationContract(program(), { ...options, fontAtlases: [{ slot: 0, bytes: atlas(1) }] })).toThrow("header");
  expect(() => createSpecializationContract(program(), { ...options, fontAtlases: [{ slot: 0, bytes: atlas(0) }, { slot: 0, bytes: atlas(0) }] })).toThrow("Duplicate");
  const rounded = createSpecializationContract(program([]), { ...options, viewport: [1.0000001, 272] });
  expect(rounded.viewport[0]).toBe(Math.fround(1.0000001));
});

test("generated Rust constant validates identities across revisions, providers, styles and viewport", async () => {
  const input = program();
  const contract = createSpecializationContract(input, { ...options, fontAtlases: [{ slot: 0, bytes: atlas(0) }] });
  const missing = createSpecializationContract(input, options);
  const rust = emitSpecializationContract(contract) + emitSpecializationContract(missing, "MISSING_ATLAS_CONTRACT");
  expect(rust).toContain("SpecializationContract<'static>");
  expect(rust).toContain("text_provider: microts::pocketjs_core::specialization::TextProvider::Baked");
  const directory = resolve(".pocket-build/validation/microts-specialization", `contract-${process.pid}-${Date.now()}`);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname = "microts-specialization-contract-test"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\npocketjs-core = { path = ${JSON.stringify(resolve("engine/core"))}, features = ["std"] }\n`);
  const bytes = (value: Uint8Array | number[]) => `[${[...value].join(",")}]`;
  const hashes = [0, 1, 55, 56, 63, 64, 65, 127, 128].map(length => {
    const data = Uint8Array.from({ length }, (_, index) => index);
    return `assert_eq!(format!("{}", content_hash(&${bytes(data)})), "${specializationContentHash(data)}");`;
  }).join("\n");
  writeFileSync(resolve(directory, "src/main.rs"), `mod microts { pub use pocketjs_core; }
use pocketjs_core::{Ui, specialization::{content_hash, SpecializationDiagnostic}};
${rust}
fn main() {
  ${hashes}
  let mut ui = Ui::new(); ui.enable_font_identity();
  assert!(ui.load_styles(&${bytes(input.styles.bytes)}));
  assert!(ui.load_font_atlas(&${bytes(atlas(0))}));
  assert!(SPECIALIZATION_CONTRACT.matches(&ui));
  let revision = ui.font_atlas_revision(0);
  assert!(ui.load_font_atlas(&${bytes(atlas(0))}));
  assert_ne!(revision, ui.font_atlas_revision(0));
  assert!(SPECIALIZATION_CONTRACT.matches(&ui));
  assert_eq!(MISSING_ATLAS_CONTRACT.validate(&ui).diagnostics, vec![SpecializationDiagnostic::MissingExpectedFontIdentity { slot: 0 }]);
  let mut other = Ui::new(); other.enable_font_identity();
  assert!(other.load_styles(&${bytes(input.styles.bytes)}));
  assert!(other.load_font_atlas(&${bytes(atlas(0, 2))}));
  assert_eq!(revision, other.font_atlas_revision(0));
  assert!(matches!(SPECIALIZATION_CONTRACT.validate(&other).diagnostics.as_slice(), [SpecializationDiagnostic::FontIdentity { slot: 0, .. }]));
  ui.set_viewport(320.0, 240.0);
  assert!(matches!(SPECIALIZATION_CONTRACT.validate(&ui).diagnostics.as_slice(), [SpecializationDiagnostic::Viewport { .. }]));
  ui.set_viewport(480.0, 272.0);
  ui.set_text_measure(Some(Box::new(|_, _, _, _| (1.0, 1.0))));
  assert_eq!(SPECIALIZATION_CONTRACT.validate(&ui).diagnostics, vec![SpecializationDiagnostic::NativeTextProvider]);
  ui.set_text_measure(None);
  assert!(ui.load_styles(&${bytes(encodeStyleTable([{ base: [{ prop: PROP.opacity, value: 0 }] }], []))}));
  assert!(matches!(SPECIALIZATION_CONTRACT.validate(&ui).diagnostics.as_slice(), [SpecializationDiagnostic::StylesIdentity { .. }]));
  assert_eq!(ui.viewport(), (480.0, 272.0)); // validation does not modify the host environment.
}
`);
  const result = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: resolve("engine/core/target") }, stdout: "pipe", stderr: "pipe" });
  const [status, output, errors] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
  writeFileSync(resolve(directory, "cargo.log"), output + errors);
  expect(status, output + errors).toBe(0);
}, 120_000);
