/** Read-only binding-time facts for the native AOT path. Never annotate shared IR. */
import { ANIMATABLE, ENUMS, LAYOUT_DIRTYING, PROP, PROP_VALUE_KIND, VALUE_KIND, type PropName } from "../../contracts/spec/spec.ts";
import { checkAotVersion, type AotComponent, type AotDiagnostic, type AotExpr, type AotNode, type AotProgram, type AotType, type SourceLocation } from "./aot-ir.ts";
import type { Ledger, ModelFunction, ModelModule } from "./aot-model-ir.ts";
import { viewModelModule } from "./aot-model-view.ts";
import { foldAotExpression } from "./aot-specialize-expr.ts";

export type SpecializationStage = "Build" | "Mount" | "Frame";
export interface SpecializationDependency { kind: "signal" | "memo" | "prop"; id: number | string; name: string; module: string }
export interface SpecializationFact {
  stage: SpecializationStage;
  deps: SpecializationDependency[] | "top";
  env: string[];
  reasons: string[];
}
export interface SpecializationBinding extends SpecializationFact {
  name: string;
  memo?: number;
  loc: SourceLocation;
  nonEmpty?: "Yes" | "No" | "Unknown";
}
export type SpecializationValue = number | string | boolean;
export interface SpecializationProperty extends SpecializationFact {
  name: PropName;
  prop: number;
  domain: "layout" | "paint";
  value: { kind: "Known"; value: SpecializationValue } | { kind: "Candidates"; values: SpecializationValue[] } | { kind: "Unknown" };
  animated: ({ kind: "Transition"; durationMs: number; delayMs: number } | { kind: "Timeline"; periodFrames: number; iterations: number; fill: number; loopFrames: number })[];
  modelWrites: ("animate" | "jump" | "unknown")[];
}
export interface SpecializationExistence extends SpecializationFact { value: "Always" | "Never" | "Conditional" }
export interface SpecializationParticipation extends SpecializationFact { value: "Yes" | "No" | "Conditional" }
export interface SpecializationCriterion { name: string; passed: boolean; reasons: string[] }
export interface SpecializationRegion {
  eligible: boolean;
  criteria: SpecializationCriterion[];
  localGeometry: SpecializationFact;
  baking: { eligible: boolean; status: "NeedsEnvironment" | "Ineligible"; reasons: string[] };
}
export interface SpecializationNode {
  path: string;
  parentPath?: string;
  id: number;
  kind: AotNode["kind"];
  tag?: "View" | "Text" | "Image";
  debugName?: string;
  loc: SourceLocation;
  exists: SpecializationExistence;
  inLayout: SpecializationParticipation;
  painted: SpecializationParticipation;
  bindings: SpecializationBinding[];
  properties: SpecializationProperty[];
  region?: SpecializationRegion;
}
export interface SpecializationComponent {
  path: string;
  component: string;
  factory: boolean;
  parameters: SpecializationBinding[];
  nodes: SpecializationNode[];
}
export interface AotSpecializationReport {
  version: 1;
  root: string;
  mode: "analysis";
  components: SpecializationComponent[];
  diagnostics: (AotDiagnostic & { code: "VS101" | "VS102" })[];
  summary: { components: number; nodes: number; bindings: Record<SpecializationStage, number>; regions: number; eligibleRegions: number };
  limitations: string[];
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const build = (reason: string, env: string[] = []): SpecializationFact => ({ stage: "Build", deps: [], env, reasons: [reason] });
const top = (reason: string, env: string[] = []): SpecializationFact => ({ stage: "Frame", deps: "top", env, reasons: [reason] });
function join(...facts: SpecializationFact[]): SpecializationFact {
  const stage = facts.some(f => f.stage === "Frame") ? "Frame" : facts.some(f => f.stage === "Mount") ? "Mount" : "Build";
  const deps = facts.some(f => f.deps === "top") ? "top" : [...new Map(facts.flatMap(f => f.deps as SpecializationDependency[]).map(d => [`${d.module}:${d.kind}:${d.id}`, d])).values()];
  return { stage, deps: stage === "Frame" ? deps : [], env: unique(facts.flatMap(f => f.env)), reasons: unique(facts.flatMap(f => f.reasons)) };
}
interface BoundExpression { expression: AotExpr; context: Context }
interface Context {
  component: AotComponent;
  path: string;
  props: Map<string, BoundExpression>;
  locals: Map<string, SpecializationFact>;
  localValues: Map<string, BoundExpression>;
  rowKey?: string;
  slots: Map<string, { slot: Extract<AotNode, { kind: "component" }>["slots"][number]; context: Context }>;
}
// Locations do not participate in the identity of a row's key expression.
function expressionKey(expression: AotExpr): string { return JSON.stringify(expression, (key, value) => key === "loc" ? undefined : value); }
function objects(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => objects(item, visit)); return; }
  const object = value as Record<string, unknown>; visit(object);
  for (const [key, child] of Object.entries(object)) if (key !== "loc" && key !== "ledger" && key !== "type") objects(child, visit);
}
const defaults: Partial<Record<PropName, SpecializationValue>> = {
  width: "auto", height: "auto", minW: "auto", minH: "auto", maxW: "auto", maxH: "auto", basis: "auto",
  insetT: "auto", insetR: "auto", insetB: "auto", insetL: "auto", lineHeight: "auto", gradViaPos: "auto",
  shrink: 1, align: ENUMS.Align.Stretch, opacity: 1, scale: 1, scaleX: 1, scaleY: 1, bevelWidth: 1,
  textColor: 0xffffffff, gradDir: 0xffffffff,
};
function decode(name: PropName, bits: number): SpecializationValue {
  if (PROP_VALUE_KIND[name] !== VALUE_KIND.f32) return name === "zIndex" ? bits | 0 : bits >>> 0;
  const data = new DataView(new ArrayBuffer(4)); data.setUint32(0, bits, true);
  const value = data.getFloat32(0, true);
  return Number.isNaN(value) ? "auto" : Number.isFinite(value) ? value : String(value);
}
const layout = new Set<PropName>(LAYOUT_DIRTYING);

export function analyzeAotSpecialization(program: AotProgram): AotSpecializationReport {
  checkAotVersion(program);
  const components = new Map(program.components.map(c => [c.name, c]));
  const modules = program.model?.modules ?? [];
  const functions = new Map(modules.flatMap(m => m.functions.map(f => [f.id, f] as const)));
  const states = new Map<number, SpecializationDependency>(modules.flatMap(m => [
    ...m.signals.map(s => [s.id, { kind: "signal" as const, id: s.id, name: s.name, module: m.name }] as const),
    ...m.memos.map(s => [s.id, { kind: "memo" as const, id: s.id, name: s.name, module: m.name }] as const),
  ]));
  const fields = new Map(modules.flatMap(m => m.fields.map(f => [f.id, `${m.name}.${f.name}`] as const)));
  const moduleFor = (component: AotComponent) => viewModelModule(program.model, component.file) ?? modules.find(m => m.name === component.name && m.kind !== "pure");
  const report: AotSpecializationReport = {
    version: 1, root: program.root, mode: "analysis", components: [], diagnostics: [],
    summary: { components: 0, nodes: 0, bindings: { Build: 0, Mount: 0, Frame: 0 }, regions: 0, eligibleRegions: 0 },
    limitations: ["Analysis does not enable regions, bake geometry, or change generated code.", "Geometry and clipping are not evaluated; paint visibility remains conditional unless absence is proven.", "Font provider and atlas identities are not available in View IR; text geometry requires an environment contract.", "Non-scalar factory parameters remain Frame until alias escape and mutation are proven absent."],
  };

  function parameter(module: ModelModule, id: number): SpecializationFact {
    const param = module.params.find(p => p.id === id)!;
    let written = false;
    objects(module, value => {
      if (value.kind !== "assign") return;
      const target = value.target as { id?: number; owner?: number };
      if (target.id === id || target.owner === id) written = true;
    });
    // Scalar copies cannot share a mutable owner. Aggregates require an alias proof
    // that the existing signal writeBack analysis does not expose for parameters.
    const scalar = (type: AotType): boolean => {
      if (["number", "boolean", "string", "undefined"].includes(type.kind)) return true;
      const declaration = type.kind === "named" ? program.types.find(t => t.name === type.name) : undefined;
      return declaration?.kind === "enum" || declaration?.kind === "newtype" && scalar(declaration.base);
    };
    if (written || !scalar(param.type)) return top(`factory parameter ${module.name}.${param.name} ${written ? "has a write path" : "has no aggregate alias-escape proof"}`);
    return { stage: "Mount", deps: [], env: [], reasons: [`factory parameter ${module.name}.${param.name} is a scalar copy with no module write path`] };
  }
  function ledger(ledger: Ledger, label: string): SpecializationFact {
    if (ledger.external || ledger.writes.length) return top(`${label} contains external behavior or writes`);
    const privateReads = ledger.reads.filter(id => fields.has(id));
    if (privateReads.length) return top(`${label} reads private field ${privateReads.map(id => fields.get(id)).join(", ")}; private fields have no changed bit`);
    if (ledger.reads.some(id => !states.has(id))) return top(`${label} reads an unclassified model value`);
    if (!ledger.reads.length) return build(`${label} has no state reads or external behavior`);
    return { stage: "Frame", deps: ledger.reads.map(id => states.get(id)!), env: [], reasons: ledger.reads.map(id => `${label} reads ${states.get(id)!.kind} ${states.get(id)!.module}.${states.get(id)!.name}`) };
  }
  function factoryReads(fn: ModelFunction, seen = new Set<number>()): SpecializationFact[] {
    if (seen.has(fn.id)) return []; seen.add(fn.id);
    const result: SpecializationFact[] = [];
    objects(fn.body, value => {
      if (value.kind === "local") {
        const module = modules.find(m => m.params.some(p => p.id === value.id));
        if (module) result.push(parameter(module, value.id as number));
      }
      if (value.kind === "invoke" || value.kind === "call") {
        const called = functions.get(value.callee as number); if (called) result.push(...factoryReads(called, seen));
      }
    });
    return result;
  }
  function expression(value: AotExpr, context: Context): SpecializationFact {
    if (context.rowKey === expressionKey(value)) return { stage: "Mount", deps: [], env: [], reasons: ["key is fixed for the lifetime of this keyed row"] };
    switch (value.kind) {
      case "literal": case "undefined": return build("source literal");
      case "constant": return context.component.constants.some(c => c.name === value.name) ? build(`source constant ${value.name}`) : top(`constant ${value.name} is unresolved`);
      case "binding": {
        if (value.scope === "prop") {
          const bound = context.props.get(value.name);
          return bound ? expression(bound.expression, bound.context) : { stage: "Frame", deps: [{ kind: "prop", id: `${context.path}.${value.name}`, name: value.name, module: context.path }], env: [], reasons: [`prop ${value.name} can be replaced by set_props()`] };
        }
        if (value.scope === "local") {
          const bound = context.localValues.get(value.name);
          return bound ? expression(bound.expression, bound.context) : context.locals.get(value.name) ?? top(`local ${value.name} has no lifetime proof`);
        }
        if (value.scope !== "vm") return top(`${value.scope} binding ${value.name} depends on runtime context`);
        const module = moduleFor(context.component);
        if (!module) return top(`vm binding ${value.name} has no model Ledger (handwritten or unavailable model)`);
        const name = context.component.values.find(v => v.name === value.name)?.sourceName ?? value.name;
        const state = [...module.signals, ...module.memos].find(s => s.name === name);
        if (state) return ledger({ reads: [state.id], writes: [], subscriptions: [], external: false }, `vm binding ${name}`);
        const param = module.params.find(p => p.name === name); if (param) return parameter(module, param.id);
        return top(`vm binding ${name} is not a signal, memo, or proven factory parameter`);
      }
      case "call": {
        const args = value.arguments.map(v => expression(v, context));
        if (value.target === "builtin") return join(build(`pure builtin ${value.name}`), ...args);
        const module = moduleFor(context.component);
        const name = context.component.functions.find(f => f.name === value.name)?.sourceName ?? value.name;
        const fn = module?.functions.find(f => f.name === name);
        if (!fn) return join(top(`vm call ${name} has no model Ledger (handwritten or unavailable model)`), ...args);
        return join(ledger(fn.ledger, `vm call ${name}`), ...factoryReads(fn), ...args);
      }
      case "field": return expression(value.object, context);
      case "index": return join(expression(value.object, context), expression(value.index, context));
      case "unary": return expression(value.operand, context);
      case "cast": case "narrow": return expression(value.value, context);
      case "binary": {
        const left = literal(value.left, context);
        if (value.operator === "&&" && left === false || value.operator === "||" && left === true) return expression(value.left, context);
        return join(expression(value.left, context), expression(value.right, context));
      }
      case "conditional": {
        const condition = literal(value.condition, context);
        return typeof condition === "boolean" ? join(expression(value.condition, context), expression(condition ? value.consequent : value.alternate, context)) : join(expression(value.condition, context), expression(value.consequent, context), expression(value.alternate, context));
      }
      case "template": return join(build("template text"), ...value.parts.filter(p => typeof p !== "string").map(p => expression(p as AotExpr, context)));
    }
  }
  // Substitute call-site props before using the same typed evaluator as codegen.
  function resolved(value: AotExpr, context: Context): AotExpr {
    if (value.kind === "binding") {
      const bound = value.scope === "prop" ? context.props.get(value.name) : value.scope === "local" ? context.localValues.get(value.name) : undefined;
      return bound ? resolved(bound.expression, bound.context) : value;
    }
    if (value.kind === "constant") {
      const constant = context.component.constants.find(c => c.name === value.name);
      return constant && !Array.isArray(constant.value) ? { kind: "literal", value: constant.value, rawNumber: constant.rawNumber, type: value.type, loc: value.loc } : value;
    }
    if (value.kind === "binary") return { ...value, left: resolved(value.left, context), right: resolved(value.right, context) };
    if (value.kind === "conditional") return { ...value, condition: resolved(value.condition, context), consequent: resolved(value.consequent, context), alternate: resolved(value.alternate, context) };
    if (value.kind === "unary") return { ...value, operand: resolved(value.operand, context) };
    if (value.kind === "cast" || value.kind === "narrow") return { ...value, value: resolved(value.value, context) };
    if (value.kind === "field") return { ...value, object: resolved(value.object, context) };
    if (value.kind === "index") return { ...value, object: resolved(value.object, context), index: resolved(value.index, context) };
    if (value.kind === "call") return { ...value, arguments: value.arguments.map(v => resolved(v, context)) };
    if (value.kind === "template") return { ...value, parts: value.parts.map(p => typeof p === "string" ? p : resolved(p, context)) };
    return value;
  }
  function literal(value: AotExpr, context: Context): SpecializationValue | undefined {
    const folded = foldAotExpression(resolved(value, context), { types: program.types, promoteF32Text: !!program.modelProtocol });
    if (folded.kind !== "literal") return undefined;
    let scalarType = folded.type;
    while (scalarType.kind === "named") {
      const name = scalarType.name, declaration = program.types.find(t => t.name === name);
      if (declaration?.kind !== "newtype") break;
      scalarType = declaration.base;
    }
    // The evaluator retains raw spelling for an ambiguous decimal-to-f32
    // midpoint. Its host number is not a proven device value.
    if (folded.rawNumber && scalarType.kind === "number" && scalarType.name === "f32") return undefined;
    // A report must not present a rounded JS number as an exact wide integer.
    return typeof folded.value === "number" && !Number.isFinite(folded.value) ? String(folded.value) : typeof folded.value === "number" && folded.rawNumber && !Number.isSafeInteger(folded.value) ? folded.rawNumber : folded.value;
  }
  function styleIds(value: AotExpr, context: Context): number[] | undefined {
    const known = literal(value, context); if (typeof known === "number") return [known];
    if (value.kind === "binding" && value.scope === "prop") { const bound = context.props.get(value.name); return bound ? styleIds(bound.expression, bound.context) : undefined; }
    if (value.kind === "conditional") { const a = styleIds(value.consequent, context), b = styleIds(value.alternate, context); return a && b ? unique([...a, ...b]) : undefined; }
    return undefined;
  }
  function writes(module: ModelModule | undefined, reference: string | undefined): Map<PropName, ("animate" | "jump" | "unknown")[]> {
    const result = new Map<PropName, ("animate" | "jump" | "unknown")[]>();
    if (!reference) return result;
    if (!module) { for (const p of ANIMATABLE) result.set(p, ["unknown"]); return result; }
    objects(module, value => {
      const op = value.kind === "external" && (value.op === "animate" || value.op === "jump") ? value.op : value.kind === "animate" ? "animate" : undefined;
      if (!op) return;
      const [target, property] = value.args as { kind: string; value?: unknown }[];
      if (target?.kind === "literal" && target.value !== reference) return;
      const properties = property?.kind === "literal" && typeof property.value === "string" && property.value in PROP ? [property.value as PropName] : ANIMATABLE;
      for (const p of properties) result.set(p, unique([...(result.get(p) ?? []), op]));
    });
    return result;
  }
  function properties(node: Extract<AotNode, { kind: "element" }>, context: Context): SpecializationProperty[] {
    const ids = node.dynamicStyle ? styleIds(node.dynamicStyle.expression, context) : [node.style];
    const records = (ids ?? []).map(id => id === -1 ? {} : program.styles.records[id]);
    // Include mount style for transitions between mount and first update.
    const animationRecords = unique([node.style, ...(ids ?? [])]).map(id => id === -1 ? {} : program.styles.records[id]);
    const valid = ids !== undefined && records.every(record => record !== undefined);
    const styleFact = node.dynamicStyle ? expression(node.dynamicStyle.expression, context) : build("static style id");
    const ref = context.component.refs?.find(r => r.name === node.ref)?.sourceName ?? node.ref;
    const modelWrites = writes(moduleFor(context.component), ref);
    return (Object.keys(PROP) as PropName[]).map(name => {
      const id = PROP[name], candidates: SpecializationValue[] = [];
      let variants = false;
      for (const record of records) if (record) {
        const base = record.base?.filter(p => p.prop === id).at(-1)?.value;
        const normal = base === undefined ? defaults[name] ?? 0 : decode(name, base);
        candidates.push(normal);
        const focus = record.focus?.filter(p => p.prop === id).at(-1)?.value, active = record.active?.filter(p => p.prop === id).at(-1)?.value;
        if (focus !== undefined) { candidates.push(decode(name, focus)); variants = true; }
        if (active !== undefined) { candidates.push(decode(name, active)); variants = true; }
      }
      const values = unique(candidates);
      const animated: SpecializationProperty["animated"] = [];
      for (const record of animationRecords) if (record) {
        const bit = ANIMATABLE.indexOf(name);
        if (record.transition && bit >= 0 && bit < 32 && (record.transition.mask & (1 << bit)) !== 0 && record.transition.durMs > 0) animated.push({ kind: "Transition", durationMs: record.transition.durMs, delayMs: record.transition.delayMs });
        for (const index of record.animation?.anims ?? []) {
          const timeline = program.styles.anims[index];
          if (timeline?.tracks.some(track => track.prop === id)) animated.push({ kind: "Timeline", periodFrames: timeline.periodFrames, iterations: timeline.iterations, fill: timeline.fill, loopFrames: record.animation!.loopFrames });
        }
      }
      let fact = valid && values.length === 1 ? build("same resolved value in every style candidate", ["styles.bin"]) : join(valid ? styleFact : top("style candidates are unresolved"), build("style table candidates", ["styles.bin"]));
      let value: SpecializationProperty["value"] = valid ? values.length === 1 ? { kind: "Known", value: values[0]! } : { kind: "Candidates", values } : { kind: "Unknown" };
      if (variants && values.length > 1) fact = join(fact, top("focus or active variant changes this property", ["input.focus", "input.active"]));
      const binding = node.props.filter(p => p.prop === id).at(-1);
      if (binding) {
        fact = expression(binding.value, context);
        const known = literal(binding.value, context);
        value = known === undefined ? { kind: "Unknown" } : { kind: "Known", value: known };
      }
      if (animated.length) { fact = join(fact, top("style transition or timeline writes this property", ["clock.tick"])); value = { kind: "Unknown" }; }
      const commands = modelWrites.get(name) ?? [];
      if (commands.length) { fact = join(fact, top(`ref ${ref} may receive model ${commands.join("/")} for ${name}`, commands.includes("animate") ? ["clock.tick"] : [])); value = { kind: "Unknown" }; }
      return { ...fact, name, prop: id, domain: layout.has(name) ? "layout" : "paint", value, animated, modelWrites: commands };
    });
  }
  function nonEmpty(parts: (string | AotExpr)[], context: Context): "Yes" | "No" | "Unknown" {
    let unknown = false;
    for (const part of parts) {
      if (typeof part !== "string" && (part.type.kind === "number" || part.type.kind === "boolean")) return "Yes";
      if (typeof part !== "string" && resolved(part, context).kind === "undefined") continue;
      const value = typeof part === "string" ? part : literal(part, context);
      if (value !== undefined && String(value).length) return "Yes";
      if (value === undefined) unknown = true;
    }
    return unknown ? "Unknown" : "No";
  }
  function existence(parent: SpecializationExistence, value: "Always" | "Never" | "Conditional", fact: SpecializationFact): SpecializationExistence {
    if (parent.value === "Never" || value === "Never") return { ...build("branch is absent"), value: "Never" };
    return { ...join(parent, fact), value: parent.value === "Conditional" || value === "Conditional" ? "Conditional" : "Always" };
  }
  function region(node: SpecializationNode, parent: SpecializationNode | undefined, descendants: SpecializationNode[]): SpecializationRegion {
    const prop = (name: PropName) => node.properties.find(p => p.name === name)!;
    const known = (name: PropName): SpecializationValue | undefined => { const p = prop(name); return p.stage !== "Frame" && p.value.kind === "Known" ? p.value.value : undefined; };
    const width = known("width"), height = known("height"), shrink = known("shrink"), grow = known("grow"), basis = known("basis");
    const pixels = (v: SpecializationValue | undefined) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    const criteria: SpecializationCriterion[] = [];
    const criterion = (name: string, passed: boolean, success: string, failure: string) => criteria.push({ name, passed, reasons: [passed ? success : failure] });
    criterion("definite-width", pixels(width), "width is a fixed pixel value", width === "auto" ? `${node.tag} node ${node.id} has auto width` : "width is dynamic, percentage-based, or unresolved");
    criterion("definite-height", pixels(height), "height is a fixed pixel value", height === "auto" ? `${node.tag} node ${node.id} has auto height` : "height is dynamic, percentage-based, or unresolved");
    criterion("no-grow", grow === 0, "grow = 0", "grow is nonzero or unresolved; siblings can change the box size");
    criterion("no-shrink", shrink === 0, "shrink = 0", shrink === 1 ? "shrink = 1 (the core default unless overridden) allows sibling overflow to shrink the box" : "shrink is nonzero or unresolved");
    const direction = parent?.properties.find(p => p.name === "flexDir");
    const main = direction?.value.kind === "Known" && direction.stage !== "Frame" ? direction.value.value === ENUMS.FlexDir.Col ? height : width : undefined;
    criterion("compatible-basis", basis === "auto" || pixels(basis) && (basis === main || width === height && basis === width), "basis is auto or matches the fixed main-axis dimension", "basis does not match a proven main-axis dimension");
    const limits = (["minW", "maxW", "minH", "maxH"] as const).every(name => {
      const v = known(name), size = name.endsWith("W") ? width : height;
      return v === "auto" || pixels(v) && pixels(size) && (name.startsWith("min") ? (v as number) <= (size as number) : (v as number) >= (size as number));
    });
    criterion("compatible-min-max", limits, "min/max do not constrain the fixed dimensions", "min/max are dynamic or conflict with the fixed dimensions");
    const local = [node, ...descendants];
    const text = local.some(n => n.tag === "Text" && n.bindings.some(b => b.name === "text" && b.nonEmpty !== "No"));
    const geometry = join(build("local layout inputs", text ? ["text.provider", "font.atlas-content", "font.revisions"] : []), ...local.flatMap(n => [n.exists, ...n.properties.filter(p => p.domain === "layout"), ...n.bindings.filter(b => b.name === "text" || b.name === "source")]));
    const eligible = criteria.every(c => c.passed);
    const bakingEligible = eligible && geometry.stage === "Build";
    return { eligible, criteria, localGeometry: geometry, baking: { eligible: false, status: bakingEligible ? "NeedsEnvironment" : "Ineligible", reasons: bakingEligible ? ["Build layout inputs require the target viewport and style contract before evaluation", ...(text ? ["text also requires a baked font provider, fixed slot identities, tracking, and line height"] : []), "no layout has been baked by this report"] : [...criteria.filter(c => !c.passed).flatMap(c => c.reasons), ...(geometry.stage !== "Build" ? [`local geometry has ${geometry.stage} inputs`, ...geometry.reasons] : [])] } };
  }
  function visitComponent(context: Context, exists: SpecializationExistence, parent: SpecializationNode | undefined, active: Set<string>): void {
    if (active.has(context.component.name)) return;
    const next = new Set(active); next.add(context.component.name);
    const module = moduleFor(context.component);
    const component: SpecializationComponent = { path: context.path, component: context.component.name, factory: !!context.component.factory, parameters: (module?.params ?? []).map(p => ({ ...parameter(module!, p.id), name: p.name, loc: p.loc ?? context.component.nodes[0]?.loc ?? { file: context.component.file, line: 1, column: 1, offset: 0 } })), nodes: [] };
    report.components.push(component);
    visit(context.component.nodes, context, component, exists, parent, next);
  }
  function visit(nodes: AotNode[], context: Context, component: SpecializationComponent, exists: SpecializationExistence, parent: SpecializationNode | undefined, active: Set<string>): void {
    for (const node of nodes) {
      const path = `${context.path}/node:${node.id}`;
      const item: SpecializationNode = { path, ...(parent ? { parentPath: parent.path } : {}), id: node.id, kind: node.kind, loc: { ...node.loc }, exists: { ...exists }, inLayout: { ...top("layout participation requires the runtime node and ancestor state"), value: "Conditional" }, painted: { ...top("paint visibility requires layout, clipping, and ancestor opacity", ["viewport"]), value: "Conditional" }, bindings: [], properties: [] };
      component.nodes.push(item);
      const bind = (name: string, value: AotExpr, memo?: number) => item.bindings.push({ ...expression(value, context), name, ...(memo === undefined ? {} : { memo }), loc: { ...value.loc } });
      if (node.kind === "element") {
        item.tag = node.tag; if (node.debugName) item.debugName = node.debugName;
        item.properties = properties(node, context);
        item.bindings.push({ ...build("focusable is a template flag"), name: "focusable", loc: { ...node.loc } });
        if (node.dynamicStyle) bind("style", node.dynamicStyle.expression, node.dynamicStyle.id);
        for (const prop of node.props) bind(prop.name, prop.value, prop.memo);
        if (node.text) item.bindings.push({ ...join(build("text parts"), ...node.text.parts.filter(p => typeof p !== "string").map(p => expression(p as AotExpr, context))), name: "text", memo: node.text.memo, loc: { ...node.loc }, nonEmpty: nonEmpty(node.text.parts, context) });
        const display = item.properties.find(p => p.name === "display")!, text = item.bindings.find(b => b.name === "text");
        const hidden = display.value.kind === "Known" && display.value.value === ENUMS.Display.None;
        if (exists.value === "Never" || hidden || node.tag === "Text" && text?.nonEmpty === "No" || parent?.inLayout.value === "No") item.inLayout = { ...join(exists, display), value: "No" };
        else if (exists.value === "Always" && display.value.kind === "Known" && display.stage === "Build" && (!parent || parent.inLayout.value === "Yes") && (node.tag !== "Text" || text?.nonEmpty === "Yes")) item.inLayout = { ...join(exists, display), value: "Yes" };
        else item.inLayout = { ...join(exists, display, ...(text ? [text] : []), ...(parent ? [parent.inLayout] : [])), value: "Conditional" };
        const opacity = item.properties.find(p => p.name === "opacity")!;
        if (item.inLayout.value === "No" || opacity.value.kind === "Known" && opacity.value.value === 0 || parent?.painted.value === "No") item.painted = { ...join(item.inLayout, opacity), value: "No" };
        const before = new Set(report.components.flatMap(c => c.nodes));
        visit(node.children, context, component, exists, item, active);
        const interior = report.components.flatMap(c => c.nodes).filter(n => !before.has(n));
        item.region = region(item, parent, interior);
        for (const c of item.region.criteria) if (!c.passed && (c.name === "definite-width" && item.properties.find(p => p.name === "width")?.value.kind === "Known" && c.reasons[0]!.includes("auto width") || c.name === "no-shrink" && c.reasons[0]!.startsWith("shrink = 1"))) report.diagnostics.push({ ...node.loc, code: c.name === "no-shrink" ? "VS102" : "VS101", severity: "warning", message: `${path}: ${c.reasons[0]}` });
      } else if (node.kind === "if") {
        let preceding = build("branch order"), selected = false, uncertain = false;
        node.branches.forEach((branch, index) => {
          if (branch.condition) bind(`condition:${index}`, branch.condition);
          const fact = branch.condition ? expression(branch.condition, context) : build("fallback branch");
          const value = branch.condition ? literal(branch.condition, context) : true;
          const state = selected || value === false ? "Never" : value === true && !uncertain ? "Always" : "Conditional";
          const branchExists = existence(exists, state, join(preceding, fact));
          visit(branch.children, { ...context, path: `${path}/branch:${index}` }, component, branchExists, parent, active);
          if (value === true) selected = true;
          else if (value !== false) uncertain = true;
          preceding = join(preceding, fact);
        });
      } else if (node.kind === "for") {
        bind("source", node.source);
        const source = expression(node.source, context);
        const rowContext = { ...context, path: `${path}/row:*`, locals: new Map(context.locals), rowKey: expressionKey(node.key) };
        const rowFact = (reason: string): SpecializationFact => ({ ...source, stage: source.stage === "Frame" ? "Frame" : "Mount", reasons: [...source.reasons, reason] });
        rowContext.locals.set(node.item, rowFact("a keyed row item can be replaced while retaining its key"));
        if (node.index) rowContext.locals.set(node.index, rowFact("row index changes when the list is reordered"));
        item.bindings.push({ ...expression(node.key, rowContext), name: "key", loc: { ...node.key.loc } });
        visit(node.children, rowContext, component, existence(exists, "Conditional", source), parent, active);
      } else if (node.kind === "input") {
        bind("active", node.active); visit(node.children, context, component, exists, parent, active);
      } else if (node.kind === "component") {
        node.props.forEach(p => bind(`prop:${p.name}`, p.value));
        const child = components.get(node.component); if (!child) continue;
        const props = new Map<string, BoundExpression>();
        for (const prop of child.props) {
          const supplied = node.props.find(p => p.name === prop.name);
          props.set(prop.name, { expression: supplied?.value ?? (prop.default === undefined ? { kind: "undefined", type: prop.type, loc: node.loc } : { kind: "literal", value: prop.default, rawNumber: prop.defaultRawNumber, type: prop.type, loc: node.loc }), context });
        }
        visitComponent({ component: child, path: `${path}/${child.name}`, props, locals: new Map(), localValues: new Map(), slots: new Map(node.slots.map(slot => [slot.name, { slot, context }])) }, exists, parent, active);
      } else {
        const supplied = context.slots.get(node.name);
        if (supplied) {
          const localValues = new Map(supplied.context.localValues);
          for (const binding of supplied.slot.bindings ?? []) { const value = node.props?.find(p => p.name === binding.prop)?.value; if (value) localValues.set(binding.name, { expression: value, context }); }
          visit(supplied.slot.children, { ...supplied.context, path: `${path}/slot:${node.name}`, localValues }, component, exists, parent, active);
        } else visit(node.fallback, { ...context, path: `${path}/fallback` }, component, exists, parent, active);
      }
      if (exists.value === "Never") { item.inLayout = { ...build("node does not exist"), value: "No" }; item.painted = { ...build("node does not exist"), value: "No" }; }
    }
  }
  const root = components.get(program.root);
  if (!root) throw new Error(`Missing AOT root component ${program.root}`);
  visitComponent({ component: root, path: root.name, props: new Map(), locals: new Map(), localValues: new Map(), slots: new Map() }, { ...build("root instance"), value: "Always" }, undefined, new Set());
  report.summary.components = report.components.length;
  for (const component of report.components) for (const node of component.nodes) {
    report.summary.nodes++;
    for (const binding of node.bindings) report.summary.bindings[binding.stage]++;
    if (node.region) { report.summary.regions++; if (node.region.eligible) report.summary.eligibleRegions++; }
  }
  return report;
}

/** Human-readable counterpart to the JSON report; diagnostics stay in the report. */
export function formatAotSpecializationReport(report: AotSpecializationReport): string {
  const lines = [`MicroTS specialization analysis: ${report.root}`, `${report.summary.nodes} nodes; bindings Build=${report.summary.bindings.Build}, Mount=${report.summary.bindings.Mount}, Frame=${report.summary.bindings.Frame}; ${report.summary.eligibleRegions}/${report.summary.regions} eligible region boundaries`];
  const fact = (value: SpecializationFact) => `${value.stage}; deps=${value.deps === "top" ? "top" : value.deps.map(d => `${d.kind}:${d.module}.${d.name}`).join(",") || "none"}; env=${value.env.join(",") || "none"}; ${value.reasons.join("; ")}`;
  for (const component of report.components) {
    lines.push(`\nComponent ${component.path}${component.factory ? " (factory)" : ""}`);
    for (const parameter of component.parameters) lines.push(`  parameter ${parameter.name}: ${fact(parameter)}`);
    for (const node of component.nodes) {
      lines.push(`  ${node.path} ${node.tag ?? node.kind}: exists=${node.exists.value}; inLayout=${node.inLayout.value}; painted=${node.painted.value}`);
      lines.push(`    existence: ${fact(node.exists)}`, `    layout participation: ${fact(node.inLayout)}`, `    paint visibility: ${fact(node.painted)}`);
      for (const binding of node.bindings) lines.push(`    ${binding.name}: ${fact(binding)}${binding.nonEmpty ? `; nonEmpty=${binding.nonEmpty}` : ""}`);
      for (const property of node.properties) lines.push(`    ${property.name} [${property.domain}]: ${fact(property)}; value=${JSON.stringify(property.value)}; animated=${JSON.stringify(property.animated)}; modelWrites=${property.modelWrites.join(",") || "none"}`);
      if (node.region) { for (const criterion of node.region.criteria) lines.push(`    region ${criterion.name}: ${criterion.passed ? "pass" : "fail"}; ${criterion.reasons.join("; ")}`); lines.push(`    baking ${node.region.baking.status}: ${node.region.baking.reasons.join("; ")}`); }
    }
  }
  return lines.join("\n") + "\n";
}
