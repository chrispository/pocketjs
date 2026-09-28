/** Build-time draw words with exact environment/placement guards. No renderer is
 * reimplemented here: core produces words; this pass validates and relocates them. */
import { DRAW_OP, ENUMS, PROP, type PropName } from "../../contracts/spec/spec.ts";
import type { AotProgram } from "./aot-ir.ts";
import { analyzeAotSpecialization, type SpecializationNode, type SpecializationProperty } from "./aot-specialization.ts";
import { rc, ref, rl, rp, rt, type RustExpr, type RustItem } from "./rust-ast.ts";

export interface StaticDrawSnapshot {
  sourceKey: string;
  target: string;
  nodes: { sourceIdentity: string; tag: string; parentIndex: number; rect: { x: number; y: number; width: number; height: number } }[];
  words: number[];
}
export interface AotStaticDrawPlan {
  sourceKey: string;
  target: string;
  words: number[];
  coordinates: number[];
  patches: { word: number; prop: number; candidates: number[] }[];
  origin: [number, number];
  size: [number, number];
  viewport: [number, number];
  clip: [number, number, number, number];
  opacity: number;
  /** Conservative actual-op bounds, relative to origin; glyphs use atlas cells. */
  bounds: [number, number, number, number];
}
export interface StaticDrawOptions {
  viewport: readonly [number, number];
  fontAtlases?: readonly { slot: number; bytes: Uint8Array }[];
}
export interface StaticDrawPlanResult {
  plans: AotStaticDrawPlan[];
  rejected: { sourceKey: string; reasons: string[] }[];
}

/** Branch inputs in draw::Walker::paint_uncached and its decoration emitters.
 * Same high-level branch alone is insufficient for patches: rounded spans,
 * alpha coverage, and gradient clipping may also change op count or values. */
export const STATIC_DRAW_BRANCH_INPUTS = {
  opacity: "effective opacity > 0 and every emitted color's quantized alpha > 0",
  colors: "background, border and text alpha after opacity multiplication",
  radius: "radius > 0; clamped radius and span/texture thresholds",
  border: "borderWidth > 0; border alpha > 0; rounded ring and inner bounds",
  shadow: "shadow > 0 and visible background or enabled gradient",
  gradient: "gradDir in 0..3; finite gradViaPos; clipping and rounded span grouping",
  bevel: "nonzero bevel colors, bevelWidth and radius <= 0",
  arc: "arcWidth > 0 and arcSweep != 0; sample/span count",
} as const;

/** Frame candidates are reported, but receive no numeric slot until both the
 * branch proof and the exact owning-node word mapping have been established. */
export function staticPaintFallback(properties: readonly SpecializationProperty[]): string[] {
  return properties.filter(property => property.stage !== "Build").map(property => {
    const candidates = property.value.kind === "Candidates" ? property.value.values : undefined;
    if (property.name === "opacity") return "Frame opacity can cross subtree/quantized-alpha draw predicates; regenerate the segment";
    if (["bgColor", "borderColor", "textColor", "gradFrom", "gradTo", "gradVia"].includes(property.name)) {
      const alphas = candidates?.map(value => typeof value === "number" ? (value >>> 24) : undefined);
      return alphas?.length && alphas.every(alpha => alpha !== undefined && alpha > 0)
        ? `Frame ${property.name} has nonzero candidate alpha, but no owning-node word-slot proof; regenerate the segment`
        : `Frame ${property.name} has unknown or zero alpha candidates; regenerate the segment`;
    }
    return `Frame ${property.name} can change draw geometry, order or generation branches; regenerate the segment`;
  });
}

const identity = (node: SpecializationNode) => `${node.loc.file}:${node.loc.offset}:${node.id}`;
const known = (node: SpecializationNode, name: PropName): number | string | boolean | undefined => {
  const property = node.properties.find(property => property.name === name);
  return property?.stage === "Build" && property.value.kind === "Known" ? property.value.value : undefined;
};
const noTransform = (node: SpecializationNode) => (["rotate", "rotateX", "rotateY", "perspective"] as const).every(name => known(node, name) === 0)
  && (["scale", "scaleX", "scaleY"] as const).every(name => known(node, name) === 1);
const unpackXY = (word: number): [number, number] => [word << 16 >> 16, word >> 16];
const packXY = (x: number, y: number) => (((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0);

/** Validate closed supported ops, relocate known XY words, and compute bounds
 * once. Runtime copies words, applies the listed slots, and uses these bounds. */
export function normalizeStaticDrawWords(words: readonly number[], origin: readonly [number, number], options: StaticDrawOptions): Pick<AotStaticDrawPlan, "words" | "coordinates" | "bounds"> {
  if (origin.some(value => !Number.isInteger(value) || Math.abs(value) > 32000)) throw new Error("static draw origin must be an i16-safe integer");
  if (words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)) throw new Error("static draw words must be u32 integers");
  const output = [...words], coordinates: number[] = [], screen = [0, 0, ...options.viewport] as [number, number, number, number];
  const clips = [screen];
  let bounds: number[] | undefined;
  const include = (x: number, y: number, width: number, height: number) => {
    const clip = clips.at(-1)!;
    const rect = [Math.max(x, clip[0]), Math.max(y, clip[1]), Math.min(x + width, clip[2]), Math.min(y + height, clip[3])];
    if (rect[2]! <= rect[0]! || rect[3]! <= rect[1]!) return;
    bounds = bounds ? [Math.min(bounds[0]!, rect[0]!), Math.min(bounds[1]!, rect[1]!), Math.max(bounds[2]!, rect[2]!), Math.max(bounds[3]!, rect[3]!)] : rect;
  };
  const coordinate = (index: number) => {
    const [x, y] = unpackXY(output[index]!);
    const localX = x - origin[0], localY = y - origin[1];
    if (localX < -32768 || localX > 32767 || localY < -32768 || localY > 32767) throw new Error("static draw relative coordinate exceeds i16");
    output[index] = packXY(localX, localY); coordinates.push(index);
    return [x, y] as const;
  };
  for (let offset = 0; offset < words.length;) {
    const op = words[offset];
    const count = op === DRAW_OP.rect ? 4 : op === DRAW_OP.gradRect ? 6 : op === DRAW_OP.scissor ? 3 : op === DRAW_OP.scissorPop ? 1 : op === DRAW_OP.glyphRun ? 3 + 2 * ((words[offset + 1] ?? 0) >>> 16) : 0;
    if (!count || offset + count > words.length) throw new Error(`static draw op ${op} is unsupported or truncated (runtime textures, transforms and native text remain generic)`);
    if (op === DRAW_OP.scissorPop) {
      if (clips.length === 1) throw new Error("unbalanced static draw scissor pop");
      clips.pop();
    } else if (op === DRAW_OP.glyphRun) {
      const slot = words[offset + 1]! & 0xff, atlas = options.fontAtlases?.find(atlas => atlas.slot === slot)?.bytes;
      if (!atlas || atlas.length < 16 || atlas[12] !== slot) throw new Error(`static draw needs font atlas ${slot}`);
      const glyphCount = new DataView(atlas.buffer, atlas.byteOffset, atlas.byteLength).getUint16(6, true);
      for (let index = offset + 3; index < offset + count; index += 2) {
        const [x, y] = coordinate(index);
        if ((words[index + 1]! & 0xffff) < glyphCount && words[offset + 2]! >>> 24) include(x, y, atlas[8]!, atlas[9]!);
      }
    } else {
      const [x, y] = coordinate(offset + 1), wh = words[offset + 2]!, width = wh & 0xffff, height = wh >>> 16;
      if (op === DRAW_OP.scissor) {
        const previous = clips.at(-1)!;
        clips.push([Math.max(previous[0], x), Math.max(previous[1], y), Math.min(previous[2], x + width), Math.min(previous[3], y + height)]);
      } else include(x, y, width, height);
    }
    offset += count;
  }
  if (clips.length !== 1) throw new Error("unbalanced static draw scissor push");
  return { words: output, coordinates, bounds: bounds ? [bounds[0]! - origin[0], bounds[1]! - origin[1], bounds[2]! - origin[0], bounds[3]! - origin[1]] : [0, 0, 0, 0] };
}

export function createStaticDrawPlans(program: AotProgram, snapshots: readonly StaticDrawSnapshot[], options: StaticDrawOptions): StaticDrawPlanResult {
  const report = analyzeAotSpecialization(program), nodes = report.components.flatMap(component => component.nodes);
  const paths = new Map(nodes.map(node => [node.path, node]));
  const facts = new Map<string, SpecializationNode[]>();
  for (const node of nodes) { const key = identity(node); facts.set(key, [...(facts.get(key) ?? []), node]); }
  const result: StaticDrawPlanResult = { plans: [], rejected: [] };
  for (const snapshot of snapshots) {
    const reasons = new Set<string>();
    const root = snapshot.nodes[0];
    if (!root) { result.rejected.push({ sourceKey: snapshot.sourceKey, reasons: ["empty layout snapshot"] }); continue; }
    // The one-RECT subset establishes the owning node without guessing from
    // equal colors or overlapping coordinates. All other properties are Build.
    if (snapshot.nodes.slice(1).some(node => node.tag !== "Text" && facts.get(node.sourceIdentity)?.every(fact => fact.region?.eligible))) reasons.add("nested registered regions retain their own draw segments");
    const rootContexts = facts.get(root.sourceIdentity) ?? [];
    const colorCandidates = rootContexts.flatMap(node => {
      const color = node.properties.find(property => property.name === "bgColor");
      return color?.value.kind === "Candidates" && !color.animated.length && !color.modelWrites.length
        ? color.value.values : [];
    });
    const colorPatch = snapshot.nodes.length === 1 && root.tag === "View"
      && snapshot.words.length === 4 && snapshot.words[0] === DRAW_OP.rect
      && rootContexts.length > 0 && rootContexts.every(node => {
        const color = node.properties.find(property => property.name === "bgColor");
        return color?.stage === "Frame" && color.value.kind === "Candidates" && color.value.values.length > 1
          && !color.animated.length && !color.modelWrites.length
          && node.properties.filter(property => property.name !== "bgColor").every(property => property.stage === "Build")
          && known(node, "opacity") === 1 && known(node, "radius") === 0
          && known(node, "borderWidth") === 0 && known(node, "shadow") === 0
          && known(node, "gradDir") === 0xffffffff && known(node, "arcWidth") === 0
          && (["bevelOuterLight", "bevelOuterDark", "bevelInnerLight", "bevelInnerDark"] as const).every(name => known(node, name) === 0);
      }) && colorCandidates.length > 1 && colorCandidates.every(value => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff && (value >>> 24) > 0)
      && colorCandidates.includes(snapshot.words[3]!);
    const patches: AotStaticDrawPlan["patches"] = colorPatch ? [{ word: 3, prop: PROP.bgColor, candidates: [...new Set(colorCandidates as number[])] }] : [];
    for (const baked of snapshot.nodes) {
      const contexts = facts.get(baked.sourceIdentity);
      if (!contexts?.length) reasons.add("snapshot source has no specialization proof");
      if (baked.tag === "Image") reasons.add("image texture handles require a mount patch proof");
      for (const node of contexts ?? []) {
        if (!noTransform(node)) reasons.add("region or descendant declares a transform or perspective context");
        if (known(node, "radius") !== 0 || known(node, "shadow") !== 0) reasons.add("rounded and shadow texture branches depend on runtime raster density/resources");
        for (const reason of staticPaintFallback(node.properties.filter(property => !colorPatch || property.name !== "bgColor"))) reasons.add(reason);
        if (node.bindings.some(binding => binding.name === "text" && binding.stage !== "Build")) reasons.add("text content is not Build");
      }
    }
    const roots = facts.get(root.sourceIdentity) ?? [];
    for (const node of roots) {
      if (known(node, "translateX") !== 0 || known(node, "translateY") !== 0) reasons.add("region root translation is outside the exact layout-origin guard");
      for (let ancestor = node.parentPath ? paths.get(node.parentPath) : undefined; ancestor; ancestor = ancestor.parentPath ? paths.get(ancestor.parentPath) : undefined) {
        if (!noTransform(ancestor)) reasons.add("ancestor transform/perspective breaks the static draw subset");
        if (known(ancestor, "opacity") !== 1 || known(ancestor, "overflow") !== ENUMS.Overflow.Visible) reasons.add("inherited opacity or clipping requires an ancestor environment proof");
        if (known(ancestor, "translateX") !== 0 || known(ancestor, "translateY") !== 0) reasons.add("ancestor translation is outside the exact layout-origin guard");
      }
    }
    const opacityValues = [...new Set(roots.map(node => known(node, "opacity")))];
    const opacity = opacityValues.length === 1 ? opacityValues[0] : undefined;
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) reasons.add("template contexts do not have one Build opacity");
    const origin: [number, number] = [root.rect.x, root.rect.y];
    if (!reasons.size) try {
      const normalized = normalizeStaticDrawWords(snapshot.words, origin, options);
      if (normalized.bounds[2] <= normalized.bounds[0] || normalized.bounds[3] <= normalized.bounds[1]) throw new Error("empty draw region uses the generic empty path");
      result.plans.push({ sourceKey: snapshot.sourceKey, target: snapshot.target, ...normalized, patches, origin, size: [root.rect.width, root.rect.height], viewport: [...options.viewport], clip: [0, 0, ...options.viewport], opacity: Math.min(1, Math.max(0, opacity as number)) });
    } catch (error) { reasons.add(error instanceof Error ? error.message : String(error)); }
    if (reasons.size) result.rejected.push({ sourceKey: snapshot.sourceKey, reasons: [...reasons] });
  }
  return result;
}

/** Identical templates share one words/slot table even when their placement
 * guards differ. Their plan records only retain the instance guard and bounds. */
export function staticDrawPlanAst(plans: readonly AotStaticDrawPlan[]): { items: RustItem[]; names: Map<string, string> } {
  const items: RustItem[] = [], names = new Map<string, string>(), tables = new Map<string, string>();
  const array = (values: readonly number[], suffix: string): RustExpr => ({ kind: "array", elements: values.map(value => rl(value, suffix)) });
  for (const [index, plan] of plans.entries()) {
    const key = JSON.stringify([plan.words, plan.coordinates]);
    let table = tables.get(key);
    if (!table) {
      table = `STATIC_DRAW_WORDS_${tables.size}`; tables.set(key, table);
      items.push({ kind: "const", storage: "static", name: table, type: { kind: "array", element: rt("u32"), length: plan.words.length }, value: array(plan.words, "u32") });
      items.push({ kind: "const", storage: "static", name: `${table}_COORDINATES`, type: { kind: "array", element: rt("u32"), length: plan.coordinates.length }, value: array(plan.coordinates, "u32") });
    }
    const name = `STATIC_DRAW_PLAN_${index}`; names.set(plan.sourceKey, name);
    items.push({ kind: "const", storage: "static", name, type: rt("microts::pocketjs_core::draw::StaticDrawPlan"), value: { kind: "struct", path: ["microts", "pocketjs_core", "draw", "StaticDrawPlan"], fields: [
      { name: "words", value: ref(rp(table)) }, { name: "coordinates", value: ref(rp(`${table}_COORDINATES`)) },
      { name: "patches", value: ref({ kind: "array", elements: plan.patches.map(patch => ({ kind: "struct", path: ["microts", "pocketjs_core", "draw", "StaticDrawPatch"], fields: [
        { name: "word", value: rl(patch.word, "u32") }, { name: "prop", value: rl(patch.prop, "u8") }, { name: "candidates", value: ref(array(patch.candidates, "u32")) },
      ] })) }) },
      ...(["origin", "size", "viewport", "clip"] as const).map(name => ({ name, value: array(plan[name], "f32") })),
      { name: "opacity", value: rl(plan.opacity, "f32") },
      { name: "bounds", value: rc(rp("microts", "pocketjs_core", "damage", "DamageRect", "new"), ...plan.bounds.map(value => rl(value, "i32"))) },
    ] } });
  }
  return { items, names };
}
