/** Build-time native seeds, evaluated by the same wasm core used by goldens. */
import { resolve } from "node:path";
import { MICROTS_ELEMENTS, parseMicroTsColor } from "../../contracts/spec/microts.ts";
// The shared browser binding is plain JavaScript and intentionally has no TS dependency.
import { createWasmUi } from "../../hosts/web/wasm-ops.js";
import { aotSpecializationTemplates } from "./aot-codegen.ts";
import type { AotExpr, AotNode, AotProgram } from "./aot-ir.ts";
import { analyzeAotSpecialization, type SpecializationNode } from "./aot-specialization.ts";
import { createSpecializationContract, type SpecializationContractOptions } from "./aot-specialization-contract.ts";
import { ref, rl, rp, rr, rt, type RustExpr, type RustItem } from "./rust-ast.ts";

export interface AotBakeRect { x: number; y: number; width: number; height: number }
export interface AotBakeNode {
  key: string; sourceIdentity: string; tag: "View" | "Text" | "Image"; parentIndex: number;
  style: number; props: { prop: number; value: number }[]; text?: string; rect: AotBakeRect;
}
export interface AotBakedRegion {
  sourceKey: string; target: string;
  guard: { unroundedSize: [number, number]; unroundedOrigin: [number, number] };
  nodes: AotBakeNode[]; words: number[];
}
export interface AotBakedTextSize { slot: number; text: string; tracking: number; lineHeight: number | null; width: number; height: number }
export interface AotSpecializationBake {
  target: string | null; regions: AotBakedRegion[]; textSizes: AotBakedTextSize[];
  diagnostics: string[];
}
export interface AotBakeOptions { target?: string; environment: SpecializationContractOptions }

export function bakedSpecializationAst(bake?: AotSpecializationBake): { items: RustItem[]; names: Map<string, string> } {
  const items: RustItem[] = [], names = new Map<string, string>();
  const tuple = (values: readonly number[]): RustExpr => ({ kind: "tuple", elements: values.map(value => rl(value, "f32")) });
  for (const [index, region] of (bake?.regions ?? []).entries()) {
    const name = `SPECIALIZATION_LAYOUT_${index}`; names.set(region.sourceKey, name);
    items.push({ kind: "const", name, type: rt("microts::specialization::BakedRegionLayout"), value: {
      kind: "struct", path: ["microts", "specialization", "BakedRegionLayout"], fields: [
        { name: "target", value: rl(region.target) },
        { name: "guard", value: { kind: "struct", path: ["microts", "pocketjs_core", "RegionLayoutGuard"], fields: [
          { name: "unrounded_size", value: tuple(region.guard.unroundedSize) }, { name: "unrounded_origin", value: tuple(region.guard.unroundedOrigin) },
        ] } },
        { name: "nodes", value: ref({ kind: "array", elements: region.nodes.map(node => ({ kind: "struct", path: ["microts", "specialization", "BakedLayoutNode"], fields: [
          { name: "parent", value: rl(node.parentIndex, "i32") },
          { name: "rect", value: { kind: "struct", path: ["microts", "pocketjs_core", "tree", "LayoutRect"], fields: [
            { name: "x", value: rl(node.rect.x, "f32") }, { name: "y", value: rl(node.rect.y, "f32") },
            { name: "w", value: rl(node.rect.width, "f32") }, { name: "h", value: rl(node.rect.height, "f32") },
          ] } },
        ] })) }) },
      ],
    } });
  }
  if (bake?.textSizes.length) items.push({ kind: "const", name: "SPECIALIZATION_TEXT_SIZES", type: rr({ kind: "slice", element: rt("microts::specialization::BakedTextSize") }, false, "static"), value: ref({ kind: "array", elements: bake.textSizes.map(size => ({
    kind: "struct", path: ["microts", "specialization", "BakedTextSize"], fields: [
      { name: "slot", value: rl(size.slot, "u8") }, { name: "text", value: rl(size.text) }, { name: "tracking", value: rl(size.tracking, "f32") },
      { name: "line_height", value: size.lineHeight === null ? rp("f32", "NAN") : rl(size.lineHeight, "f32") }, { name: "size", value: tuple([size.width, size.height]) },
    ],
  })) }) });
  return { items, names };
}

/** Only this target has the maintained native/wasm rounding and text golden. */
export function specializationBakeTarget(request?: string): string | null {
  if (request !== "host" && request !== "aarch64-apple-darwin" && request !== "aarch64-apple-darwin-std") return null;
  return process.platform === "darwin" && process.arch === "arm64" ? "aarch64-apple-darwin-std" : null;
}

let binary: Promise<ArrayBuffer> | undefined;
async function bakingWasm(): Promise<ArrayBuffer> {
  binary ??= (async () => {
    const manifest = resolve(import.meta.dir, "../../engine/wasm/Cargo.toml");
    const target = resolve(import.meta.dir, "../../.pocket-build/validation/microts-specialization/baking-wasm-target");
    const child = Bun.spawn(["cargo", "build", "--quiet", "--release", "--features", "specialization-host", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest], { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: "pipe", stderr: "pipe" });
    const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    if (status !== 0) throw new Error(`MicroTS baking wasm build failed: ${errors}`);
    return Bun.file(resolve(target, "wasm32-unknown-unknown/release/pocketjs_wasm.wasm")).arrayBuffer();
  })();
  return binary;
}
const identity = (node: Pick<AotNode, "id" | "loc">) => `${node.loc.file}:${node.loc.offset}:${node.id}`;
type TemplateNode = AotNode & { logicalPath?: string; constantText?: string };
interface BakingExports {
  memory: WebAssembly.Memory;
  ui_alloc(length: number): number; ui_free(pointer: number, length: number): void;
  ui_specialization_layout(id: number, component: number): number;
  ui_specialization_region(id: number): number;
  ui_specialization_guard(id: number, component: number): number;
  ui_specialization_words_len(): number; ui_specialization_words_ptr(): number;
  ui_specialization_glyph_misses(): number;
  ui_specialization_shape(pointer: number, length: number, slot: number, tracking: number, lineHeight: number, component: number): number;
}

/** Unknown targets and absent atlas identities preserve the live region solver. */
export async function bakeAotSpecialization(program: AotProgram, options: AotBakeOptions): Promise<AotSpecializationBake> {
  const target = specializationBakeTarget(options.target);
  const result: AotSpecializationBake = { target, regions: [], textSizes: [], diagnostics: [] };
  if (!target) { result.diagnostics.push(`Initial layout and text-size baking disabled for target ${options.target ?? "unspecified"}; no target golden is established`); return result; }
  const contract = createSpecializationContract(program, options.environment);
  if (contract.diagnostics.length) { result.diagnostics.push(...contract.diagnostics.map(d => d.message)); return result; }
  if (!contract.viewport.every(Number.isInteger)) { result.diagnostics.push("Baking requires an integer logical viewport"); return result; }
  const report = analyzeAotSpecialization(program);
  const facts = new Map<string, SpecializationNode[]>();
  for (const component of report.components) for (const node of component.nodes) {
    const key = identity(node); facts.set(key, [...facts.get(key) ?? [], node]);
  }
  const proofs = (node: TemplateNode) => facts.get(identity(node)) ?? [];
  const knownProperty = (node: TemplateNode, name: string): number | string | boolean | undefined => {
    const values = proofs(node).map(fact => fact.properties.find(prop => prop.name === name));
    if (!values.length || values.some(value => value?.stage !== "Build" || value.value.kind !== "Known")) return;
    const candidates = values.map(value => value!.value.kind === "Known" ? value!.value.value : undefined);
    return candidates.every(value => Object.is(value, candidates[0])) ? candidates[0] : undefined;
  };
  const scalar = (expression: AotExpr): number | undefined => {
    if (expression.kind !== "literal") return;
    let carrier = expression.type;
    const seen = new Set<string>();
    while (carrier.kind === "named" && !seen.has(carrier.name)) {
      const name = carrier.name;
      seen.add(name);
      const declaration = program.types.find(type => type.name === name);
      if (declaration?.kind !== "newtype") break;
      carrier = declaration.base;
    }
    // The scalar folder preserves ambiguous decimal-to-f32 midpoint literals
    // verbatim for Rust. Passing their JS f64 value to wasm would double-round.
    if (carrier.kind === "number" && carrier.name === "f32" && (expression.rawNumber || typeof expression.value === "number" && !Object.is(expression.value, Math.fround(expression.value)))) return;
    if (typeof expression.value === "number") return expression.value;
    if (typeof expression.value === "boolean") return +expression.value;
    const type = expression.type;
    if (type.kind === "named" && program.types.some(declaration => declaration.name === type.name && declaration.kind === "newtype" && declaration.unit === "Color")) return parseMicroTsColor(expression.value);
  };
  function materialize(root: TemplateNode): AotBakeNode[] | undefined {
    const nodes: AotBakeNode[] = [];
    function visit(node: TemplateNode, parentIndex: number): boolean {
      if (node.kind === "if") return node.branches.length === 1 && !node.branches[0]!.condition && node.branches[0]!.children.every(child => visit(child, parentIndex));
      if (node.kind === "input") return node.children.every(child => visit(child, parentIndex));
      if (node.kind !== "element") return false;
      const proof = proofs(node);
      if (!proof.length || proof.some(fact => fact.properties.some(prop => prop.domain === "layout" && (prop.stage !== "Build" || prop.value.kind !== "Known")))) return false;
      if (node.text && node.constantText === undefined) return false;
      if (node.tag === "Text") {
        const slot = knownProperty(node, "fontSlot");
        // An explicitly narrowed contract cannot authorize a text layout that
        // depends on an omitted atlas, even when the caller supplies its bytes.
        if (typeof slot !== "number" || !contract.fonts.some(font => font.slot === slot && font.hash !== null)) return false;
      }
      const style = node.dynamicStyle ? scalar(node.dynamicStyle.expression) : node.style;
      if (style === undefined || !Number.isInteger(style)) return false;
      const props = node.props.map(prop => ({ prop: prop.prop, value: scalar(prop.value) }));
      if (props.some(prop => prop.value === undefined)) return false;
      const index = nodes.length;
      nodes.push({ key: node.logicalPath!, sourceIdentity: identity(node), tag: node.tag, parentIndex, style, props: props as { prop: number; value: number }[], ...(node.text ? { text: node.constantText! } : {}), rect: { x: 0, y: 0, width: 0, height: 0 } });
      return node.children.every(child => visit(child, index));
    }
    return visit(root, -1) ? nodes : undefined;
  }
  const wasmBytes = await bakingWasm();
  const textKeys = new Set<string>();
  const measureWasm = await createWasmUi(wasmBytes, { width: contract.viewport[0], height: contract.viewport[1] });
  for (const atlas of options.environment.fontAtlases ?? []) measureWasm.ops.loadFontAtlas!(atlas.bytes);
  const measureExports = measureWasm.exports as unknown as BakingExports;
  function measure(node: TemplateNode): void {
    if (node.kind !== "element" || node.constantText === undefined || !node.constantText.length) return;
    const slot = knownProperty(node, "fontSlot"), tracking = knownProperty(node, "tracking"), lineHeight = knownProperty(node, "lineHeight");
    if (typeof slot !== "number" || typeof tracking !== "number" || typeof lineHeight !== "number" && lineHeight !== "auto" || !contract.fonts.some(font => font.slot === slot && font.hash !== null)) return;
    const key = JSON.stringify([slot, tracking, lineHeight, node.constantText]);
    if (textKeys.has(key)) return;
    const bytes = new TextEncoder().encode(node.constantText), pointer = measureExports.ui_alloc(bytes.length);
    new Uint8Array(measureExports.memory.buffer, pointer, bytes.length).set(bytes);
    try {
      const heightValue = lineHeight === "auto" ? NaN : lineHeight;
      const width = measureExports.ui_specialization_shape(pointer, bytes.length, slot, tracking, heightValue, 0);
      const height = measureExports.ui_specialization_shape(pointer, bytes.length, slot, tracking, heightValue, 1);
      if (Number.isFinite(width) && Number.isFinite(height)) { result.textSizes.push({ slot, text: node.constantText, tracking, lineHeight: lineHeight === "auto" ? null : lineHeight, width, height }); textKeys.add(key); }
    } finally { measureExports.ui_free(pointer, bytes.length); }
  }
  async function evaluate(root: TemplateNode): Promise<void> {
    const proof = proofs(root);
    if (root.kind !== "element" || root.tag === "Text" || !proof.length || proof.some(fact => !fact.region?.eligible || fact.region.localGeometry.stage !== "Build")) return;
    const nodes = materialize(root); if (!nodes) return;
    const wasm = await createWasmUi(wasmBytes, { width: contract.viewport[0], height: contract.viewport[1] });
    const ex = wasm.exports as unknown as BakingExports;
    wasm.ops.loadStyles!(Uint8Array.from(program.styles.bytes));
    for (const atlas of options.environment.fontAtlases ?? []) wasm.ops.loadFontAtlas!(atlas.bytes);
    const ids: number[] = [];
    for (const node of nodes) {
      const id = wasm.ops.createNode(MICROTS_ELEMENTS[node.tag].nodeType); ids.push(id);
      wasm.ops.insertBefore(node.parentIndex < 0 ? 1 : ids[node.parentIndex]!, id, 0);
      wasm.ops.setStyle(id, node.style);
      for (const prop of node.props) wasm.ops.setProp(id, prop.prop, prop.value);
      if (node.text !== undefined) wasm.ops.setText(id, node.text);
    }
    if (!ex.ui_specialization_region(ids[0])) return;
    wasm.tick();
    const missingGlyphs = () => {
      if (!ex.ui_specialization_glyph_misses()) return false;
      result.diagnostics.push(`${root.logicalPath}: layout and static draw seeds declined because missing glyphs require runtime miss-count effects`);
      return true;
    };
    if (missingGlyphs()) return;
    const guard = { unroundedOrigin: [ex.ui_specialization_guard(ids[0], 0), ex.ui_specialization_guard(ids[0], 1)] as [number, number], unroundedSize: [ex.ui_specialization_guard(ids[0], 2), ex.ui_specialization_guard(ids[0], 3)] as [number, number] };
    if (!guard.unroundedOrigin.every(Number.isInteger) || !guard.unroundedSize.every(Number.isFinite)) return;
    nodes.forEach((node, index) => { node.rect = { x: ex.ui_specialization_layout(ids[index], 0), y: ex.ui_specialization_layout(ids[index], 1), width: ex.ui_specialization_layout(ids[index], 2), height: ex.ui_specialization_layout(ids[index], 3) }; });
    if (nodes.some(node => Object.values(node.rect).some(value => !Number.isFinite(value)))) return;
    const length = ex.ui_specialization_words_len(), pointer = ex.ui_specialization_words_ptr();
    if (missingGlyphs()) return;
    const words = Array.from(new Uint32Array(ex.memory.buffer, pointer, length));
    result.regions.push({ sourceKey: root.logicalPath!, target: target!, guard, nodes, words });
  }
  async function visit(nodes: TemplateNode[]): Promise<void> {
    for (const node of nodes) {
      measure(node);
      await evaluate(node);
      if (node.kind === "element" || node.kind === "input" || node.kind === "for") await visit(node.children);
      else if (node.kind === "if") for (const branch of node.branches) await visit(branch.children);
      else if (node.kind === "slot") await visit(node.fallback);
      else for (const slot of node.slots) await visit(slot.children);
    }
  }
  for (const template of aotSpecializationTemplates(program)) await visit(template.nodes);
  return result;
}
