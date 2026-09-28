/** Native-only environment facts. This module reads shared IR without annotating it. */
import { createHash } from "node:crypto";
import { MAX_FONT_SLOTS, PROP } from "../../contracts/spec/spec.ts";
import { checkAotVersion, type AotNode, type AotProgram } from "./aot-ir.ts";
import { rc, ref, rl, rp, rt, type RustExpr, type RustItem } from "./rust-ast.ts";
import { printRust } from "./rust-printer.ts";

export interface SpecializationContractOptions {
  viewport: readonly [number, number];
  tickRate: number;
  fontAtlases?: readonly { slot: number; bytes: Uint8Array }[];
  /** Slots on which the generated proof depends. Omission includes all potential view slots. */
  fontSlots?: readonly number[];
}
export interface AotSpecializationContract {
  version: 1;
  viewport: [number, number];
  tickRate: number;
  textProvider: "baked";
  stylesHash: string;
  fonts: { slot: number; hash: string | null }[];
  diagnostics: { code: "VS205"; slot: number; message: string }[];
}

export function specializationContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Includes inherited slots and all slots if an arbitrary binding can select a font. */
function potentialFontSlots(program: AotProgram): number[] {
  let hasText = false;
  let unknown = false;
  const slots = new Set(program.styles.usedFontSlots);
  function visit(nodes: readonly AotNode[]): void {
    for (const node of nodes) {
      if (node.kind === "element") {
        hasText ||= node.tag === "Text";
        for (const property of node.props) {
          if (property.prop !== PROP.fontSlot) continue;
          const value = property.value;
          if (value.kind === "literal" && typeof value.value === "number" && Number.isInteger(value.value) && value.value >= 0 && value.value < MAX_FONT_SLOTS) slots.add(value.value);
          else unknown = true;
        }
        visit(node.children);
      } else if (node.kind === "if") for (const branch of node.branches) visit(branch.children);
      else if (node.kind === "component") for (const slot of node.slots) visit(slot.children);
      else if (node.kind === "slot") visit(node.fallback);
      else visit(node.children);
    }
  }
  for (const component of program.components) visit(component.nodes);
  if (!hasText) return [];
  if (unknown) return Array.from({ length: MAX_FONT_SLOTS }, (_, slot) => slot);
  slots.add(0);
  return [...slots];
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_FONT_SLOTS) throw new Error(`Invalid specialization font slot ${slot}; expected 0..${MAX_FONT_SLOTS - 1}`);
}

/** Missing atlas bytes produce a guard that deoptimizes; revision counters are not identities. */
export function createSpecializationContract(program: AotProgram, options: SpecializationContractOptions): AotSpecializationContract {
  checkAotVersion(program);
  if (options.viewport.some(value => !Number.isFinite(value) || value < 1 || value > 32000)) throw new Error("Specialization viewport dimensions must be finite and between 1 and 32000");
  if (!Number.isInteger(options.tickRate) || options.tickRate < 1 || options.tickRate > 240) throw new Error("Specialization tick rate must be an integer between 1 and 240");
  const atlases = new Map<number, Uint8Array>();
  for (const atlas of options.fontAtlases ?? []) {
    checkSlot(atlas.slot);
    if (atlases.has(atlas.slot)) throw new Error(`Duplicate specialization atlas for font slot ${atlas.slot}`);
    // Core binds an atlas to the slot encoded at offset 12. A mislabeled input
    // cannot establish the declared slot even when its bytes hash correctly.
    if (atlas.bytes.length < 16 || atlas.bytes[12] !== atlas.slot) throw new Error(`Specialization atlas header does not match font slot ${atlas.slot}`);
    atlases.set(atlas.slot, atlas.bytes);
  }
  const required = [...new Set(options.fontSlots ?? potentialFontSlots(program))].sort((a, b) => a - b);
  const diagnostics: AotSpecializationContract["diagnostics"] = [];
  const fonts = required.map(slot => {
    checkSlot(slot);
    const bytes = atlases.get(slot);
    if (!bytes) diagnostics.push({ code: "VS205", slot, message: `No build-time atlas bytes for required font slot ${slot}; dependent specialization uses the generic path` });
    return { slot, hash: bytes ? specializationContentHash(bytes) : null };
  });
  return {
    version: 1,
    viewport: [Math.fround(options.viewport[0]), Math.fround(options.viewport[1])],
    tickRate: options.tickRate,
    textProvider: "baked",
    stylesHash: specializationContentHash(Uint8Array.from(program.styles.bytes)),
    fonts,
    diagnostics,
  };
}

const namespace = ["microts", "pocketjs_core", "specialization"];
function hashExpression(hash: string): RustExpr {
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error("Specialization content identity must be a lowercase SHA-256 hash");
  return rc(rp(...namespace, "ContentHash"), { kind: "array", elements: Array.from({ length: 32 }, (_, index) => rl(parseInt(hash.slice(index * 2, index * 2 + 2), 16), "u8")) });
}

/** A structured Rust constant that can be added to the generated app module. */
export function specializationContractAst(contract: AotSpecializationContract, name = "SPECIALIZATION_CONTRACT"): RustItem {
  if (contract.version !== 1) throw new Error(`Unsupported specialization contract version ${contract.version}; expected 1`);
  return {
    kind: "const", name, public: true,
    type: rt([...namespace, "SpecializationContract"].join("::"), { kind: "lifetime", name: "static" }),
    value: {
      kind: "struct", path: [...namespace, "SpecializationContract"], fields: [
        { name: "viewport", value: { kind: "tuple", elements: contract.viewport.map(value => rl(value, "f32")) } },
        { name: "tick_hz", value: rl(contract.tickRate, "u32") },
        { name: "text_provider", value: rp(...namespace, "TextProvider", "Baked") },
        { name: "styles", value: hashExpression(contract.stylesHash) },
        { name: "fonts", value: ref({ kind: "array", elements: contract.fonts.map(font => ({
          kind: "struct", path: [...namespace, "FontIdentity"], fields: [
            { name: "slot", value: rl(font.slot, "u8") },
            { name: "hash", value: font.hash === null ? rp("None") : rc(rp("Some"), hashExpression(font.hash)) },
          ],
        })) }) },
      ],
    },
  };
}

export function emitSpecializationContract(contract: AotSpecializationContract, name = "SPECIALIZATION_CONTRACT"): string {
  return printRust({ items: [specializationContractAst(contract, name)] });
}
