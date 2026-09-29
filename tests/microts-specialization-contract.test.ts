// Environment contracts record the viewport, tick rate and the exact bytes of
// the styles and font atlases a specialized build assumes. The runtime side
// (engine/core/src/specialization.rs) has its own unit tests.
import { expect, test } from "bun:test";
import { MAX_FONT_SLOTS, PROP, encodeStyleTable } from "../contracts/spec/spec.ts";
import { createSpecializationContract, emitSpecializationContract, specializationContentHash, type SpecializationContractOptions } from "../microts/compiler/aot-specialization-contract.ts";
import { fontAtlas, freeze, program, runCrate, rustBytes, text, vm } from "./helpers/microts-specialization.ts";

const environment = { viewport: [480, 272] as const, tickRate: 60 };
const withText = () => program([text([])], { fontSlots: [0] });
const contract = (options: Partial<SpecializationContractOptions> = {}, input = withText()) =>
  createSpecializationContract(input, { ...environment, ...options });
const atlases = (...bytes: Uint8Array[]) => ({ fontAtlases: bytes.map(atlas => ({ slot: 0, bytes: atlas })) });

test("contracts hash exact atlas and style bytes and leave the IR unchanged", () => {
  const input = freeze(withText());
  const first = contract(atlases(fontAtlas()), input);
  expect(contract(atlases(fontAtlas()), input)).toEqual(first);
  expect(contract(atlases(fontAtlas({ tofu: 2 })), input).fonts[0]!.hash).not.toBe(first.fonts[0]!.hash);
  expect(first).toMatchObject({ textProvider: "baked", diagnostics: [], stylesHash: specializationContentHash(Uint8Array.from(input.styles.bytes)) });
});

test("a missing atlas is diagnosed, and a dynamic font slot requires every slot", () => {
  const missing = contract();
  expect(missing.fonts).toEqual([{ slot: 0, hash: null }]);
  expect(missing.diagnostics).toEqual([{ code: "VS205", slot: 0, message: expect.stringContaining("generic path") }]);
  const dynamicFont = text([]);
  dynamicFont.props = [{ prop: PROP.fontSlot, name: "fontSlot", memo: 1, value: vm("font") }];
  const dynamic = program([dynamicFont], { fontSlots: [0] });
  expect(contract({}, dynamic).fonts).toHaveLength(MAX_FONT_SLOTS);
  expect(contract({ fontSlots: [4, 1, 4] }, dynamic).fonts.map(font => font.slot)).toEqual([1, 4]);
  expect(contract({}, program([], { fontSlots: [0] })).fonts).toEqual([]); // no Text, no font
});

test("invalid environments and mislabeled atlases are rejected", () => {
  const create = (options: Partial<SpecializationContractOptions>) => () => contract(options);
  for (const viewport of [[NaN, 272], [0, 272], [480, 32001]] as const) expect(create({ viewport })).toThrow("viewport");
  for (const tickRate of [0, 241, 59.5]) expect(create({ tickRate })).toThrow("tick rate");
  expect(create({ fontSlots: [-1] })).toThrow("font slot");
  expect(create(atlases(fontAtlas({ slot: 1 })))).toThrow("header");
  expect(create(atlases(fontAtlas(), fontAtlas()))).toThrow("Duplicate");
  expect(contract({ viewport: [1.0000001, 272] }).viewport[0]).toBe(Math.fround(1.0000001)); // stored as f32
});

test("the emitted Rust contract checks the same identities as the runtime", () => {
  const input = withText();
  const expected = emitSpecializationContract(contract(atlases(fontAtlas())));
  const missing = emitSpecializationContract(contract(), "MISSING_ATLAS_CONTRACT");
  // Rust's SHA-256 against node:crypto around the 56- and 64-byte padding boundaries.
  const hashes = [0, 1, 55, 56, 63, 64, 65, 127, 128].map(length => {
    const data = Uint8Array.from({ length }, (_, index) => index);
    return `assert_eq!(content_hash(${rustBytes(data)}).to_string(), "${specializationContentHash(data)}");`;
  });
  const otherStyles = encodeStyleTable([{ base: [{ prop: PROP.opacity, value: 0 }] }]);
  runCrate("specialization-contract", { "main.rs": `use microts::pocketjs_core::specialization::{content_hash, SpecializationDiagnostic as D};
use microts::pocketjs_core::Ui;
${expected}
${missing}
fn host(atlas: &[u8]) -> Ui {
  let mut ui = Ui::new();
  ui.enable_font_identity();
  assert!(ui.load_styles(${rustBytes(input.styles.bytes)}) && ui.load_font_atlas(atlas));
  ui
}
fn main() {
  ${hashes.join("\n  ")}
  let mut ui = host(${rustBytes(fontAtlas())});
  assert!(SPECIALIZATION_CONTRACT.matches(&ui));
  assert_eq!(MISSING_ATLAS_CONTRACT.validate(&ui).diagnostics, vec![D::MissingExpectedFontIdentity { slot: 0 }]);
  let other = host(${rustBytes(fontAtlas({ tofu: 2 }))});
  assert!(matches!(SPECIALIZATION_CONTRACT.validate(&other).diagnostics.as_slice(), [D::FontIdentity { slot: 0, .. }]));
  assert!(ui.load_styles(${rustBytes(otherStyles)}));
  assert!(matches!(SPECIALIZATION_CONTRACT.validate(&ui).diagnostics.as_slice(), [D::StylesIdentity { .. }]));
}` }, ["std"]);
}, 120_000);
