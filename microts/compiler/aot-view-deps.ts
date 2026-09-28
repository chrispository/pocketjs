import type { AotComponent, AotExpr, AotNode, AotProgram } from "./aot-ir.ts";
import { MICROTS_BUILTINS } from "../../contracts/spec/microts.ts";
import type { ModelModule } from "./aot-model-ir.ts";

/** null is unknown; numeric entries are dense per-model signal/memo bit slots. */
export type ViewDependencies = number[] | null;
export function modelViewSources(module: ModelModule): number[] { return [...module.signals, ...module.memos].map(source => source.id); }
export function mergeViewDependencies(values: ViewDependencies[]): ViewDependencies {
  return values.some(value => value === null) ? null : [...new Set(values.flatMap(value => value!))].sort((a, b) => a - b);
}

/** Rendering depends on Ledger reads, never subscriptions. A field read has no
 * changed bit, and unknown/foreign ownership cannot establish a skip proof. */
export function viewExpressionDependencies(program: AotProgram, component: AotComponent, expression: AotExpr): ViewDependencies {
  const module = program.model?.modules.find(module => module.name === component.name);
  const sources = module && modelViewSources(module);
  const reads = (ids: number[]): ViewDependencies => sources && ids.every(id => sources.includes(id)) ? ids.map(id => sources.indexOf(id)) : null;
  const visit = (value: AotExpr): ViewDependencies => {
    switch (value.kind) {
      case "literal": case "undefined": case "constant": return [];
      case "binding": {
        if (value.scope !== "vm" || !module) return null;
        const view = component.values.find(item => item.name === value.name);
        const source = [...module.signals, ...module.memos].find(item => item.name === (view?.sourceName ?? value.name));
        return source ? reads([source.id]) : null;
      }
      case "call": {
        const args = value.arguments.map(visit);
        if (value.target === "builtin") return Object.hasOwn(MICROTS_BUILTINS, value.name) ? mergeViewDependencies(args) : null;
        const name = component.functions.find(fn => fn.name === value.name)?.sourceName ?? value.name;
        const fn = module?.functions.find(fn => fn.name === name);
        return !fn || fn.async || fn.ledger.external || fn.ledger.writes.length ? null : mergeViewDependencies([...args, reads(fn.ledger.reads)]);
      }
      case "field": return visit(value.object);
      case "index": return mergeViewDependencies([visit(value.object), visit(value.index)]);
      case "unary": return visit(value.operand);
      case "binary": return mergeViewDependencies([visit(value.left), visit(value.right)]);
      case "conditional": return mergeViewDependencies([visit(value.condition), visit(value.consequent), visit(value.alternate)]);
      case "template": return mergeViewDependencies(value.parts.filter((part): part is AotExpr => typeof part !== "string").map(visit));
      case "cast": case "narrow": return visit(value.value);
    }
  };
  return visit(expression);
}

export function viewNodeDependencies(program: AotProgram, component: AotComponent, node: AotNode): ViewDependencies {
  const expr = (value: AotExpr) => viewExpressionDependencies(program, component, value);
  const children = (nodes: AotNode[]) => nodes.map(child => viewNodeDependencies(program, component, child));
  switch (node.kind) {
    case "element": return mergeViewDependencies([
      ...(node.dynamicStyle ? [expr(node.dynamicStyle.expression)] : []), ...node.props.map(prop => expr(prop.value)),
      ...(node.text?.parts.filter((part): part is AotExpr => typeof part !== "string").map(expr) ?? []), ...children(node.children),
    ]);
    case "if": return mergeViewDependencies(node.branches.flatMap(branch => [...(branch.condition ? [expr(branch.condition)] : []), ...children(branch.children)]));
    case "input": return mergeViewDependencies(children(node.children));
    case "for": return mergeViewDependencies([expr(node.source), expr(node.key), ...children(node.children)]);
    // Factory models have independent bitsets, while props/slots may change
    // through the parent context. Do not skip across that ownership boundary.
    case "component": case "slot": return null;
  }
}

export function dependencyWords(dependencies: number[]): bigint[] {
  const words = Array.from({ length: dependencies.length ? Math.floor(Math.max(...dependencies) / 64) + 1 : 0 }, () => 0n);
  for (const bit of dependencies) words[Math.floor(bit / 64)]! |= 1n << BigInt(bit % 64);
  return words;
}
