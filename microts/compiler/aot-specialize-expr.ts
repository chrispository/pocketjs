import type { AotConstant, AotExpr, AotType, AotTypeDeclaration, LiteralValue } from "./aot-ir.ts";
import { __modelNumber, __modelMultiply, abs, ceil, clamp, fixed, floor, idiv, imod, len, max, min, round, trunc } from "../../framework/src/std-microts.ts";
import { parseMicroTsColor } from "../../contracts/spec/microts.ts";

export interface AotFoldContext {
  types: AotTypeDeclaration[];
  /** Compiled models display f32 after f64 promotion; handwritten models keep
   * native shortest-f32 formatting, which is not JS Number stringification. */
  promoteF32Text?: boolean;
  resolveConstant?: (expression: Extract<AotExpr, { kind: "constant" }>) => AotConstant | undefined;
}

/** Only evaluated scalar results qualify. Unknown calls, target-sized integers,
 * and non-reflexive NaN values retain the ordinary runtime memo path. */
export function isBuildExpression(expression: AotExpr): boolean {
  return expression.kind === "undefined" || expression.kind === "literal" && !(typeof expression.value === "number" && Number.isNaN(expression.value));
}

function baseType(type: AotType, context: AotFoldContext): AotType {
  const declaration = type.kind === "named" ? context.types.find(value => value.name === type.name) : undefined;
  return declaration?.kind === "newtype" && declaration.unit !== "Color" ? baseType(declaration.base, context) : type;
}

/** A decimal literal can round to an exact f32 midpoint when first parsed as
 * f64, even though Rust's direct decimal-to-f32 parse lies on one side. Keep
 * those rare raw literals rather than double-rounding them at build time. */
function rawF32Midpoint(expression: Extract<AotExpr, { kind: "literal" }>, type: AotType): boolean {
  if (!expression.rawNumber || type.kind !== "number" || type.name !== "f32" || typeof expression.value !== "number") return false;
  const value = expression.value, rounded = __modelNumber(value, "f32");
  if (!Number.isFinite(value) || value === rounded) return false;
  const floats = new Float32Array(1), bits = new Uint32Array(floats.buffer);
  floats[0] = rounded;
  bits[0] = rounded === 0 ? value < 0 ? 0x80000001 : 1 : bits[0]! + ((value > rounded) === (rounded > 0) ? 1 : -1);
  return value === (rounded + floats[0]!) / 2;
}

/** Uses the same width/f32 normalization and builtin implementations as the
 * compiled view oracle. Wide integer arithmetic uses bigint, never JS number. */
export function foldAotExpression(expression: AotExpr, context: AotFoldContext): AotExpr {
  const fold = (value: AotExpr) => foldAotExpression(value, context);
  const literal = (value: LiteralValue | bigint, type = expression.type): AotExpr => ({ kind: "literal", value: typeof value === "bigint" ? Number(value) : value, ...(typeof value === "bigint" ? { rawNumber: String(value) } : {}), type, loc: expression.loc });
  const normalize = (value: number | bigint, type = expression.type): number | bigint | undefined => {
    const base = baseType(type, context);
    if (base.kind !== "number") return value;
    if (base.name === "usize") return;
    if (base.name === "i64" || base.name === "u64") return typeof value === "bigint" ? (base.name === "i64" ? BigInt.asIntN(64, value) : BigInt.asUintN(64, value)) : undefined;
    if (typeof value === "bigint") value = Number(value);
    return base.name === "f64" ? value : __modelNumber(value, base.name);
  };
  const value = (e: AotExpr): LiteralValue | bigint | undefined => {
    if (e.kind !== "literal") return;
    const base = baseType(e.type, context);
    if (rawF32Midpoint(e, base)) return;
    const declaration = base.kind === "named" ? context.types.find(value => value.name === base.name) : undefined;
    if (declaration?.kind === "newtype" && declaration.unit === "Color") return typeof e.value === "string" ? parseMicroTsColor(e.value) : e.value;
    if (base.kind === "number" && base.name === "usize" && !Number.isSafeInteger(e.value)) return;
    if (base.kind === "number" && (base.name === "i64" || base.name === "u64")) {
      if (!e.rawNumber && !Number.isSafeInteger(e.value)) return;
      try { return BigInt(e.rawNumber ?? e.value); } catch { return; }
    }
    return e.value;
  };
  const computed = (result: LiteralValue | bigint | undefined, fallback: AotExpr): AotExpr => {
    if (result === undefined) return fallback;
    if (typeof result === "number" || typeof result === "bigint") {
      const normalized = normalize(result);
      return normalized === undefined ? fallback : literal(normalized);
    }
    return literal(result);
  };
  switch (expression.kind) {
    case "literal": {
      if (typeof expression.value !== "number") return expression;
      if (rawF32Midpoint(expression, baseType(expression.type, context))) return expression;
      const normalized = normalize(value(expression) as number | bigint);
      return normalized === undefined ? expression : literal(normalized);
    }
    case "constant": {
      const constant = context.resolveConstant?.(expression);
      return constant && !Array.isArray(constant.value) ? fold({ kind: "literal", value: constant.value, rawNumber: constant.rawNumber, type: expression.type, loc: expression.loc }) : expression;
    }
    case "unary": {
      const operand = fold(expression.operand), next = { ...expression, operand }, v = value(operand);
      if (v === undefined) return next;
      if (expression.operator === "!") return typeof v === "boolean" ? literal(!v) : next;
      if (typeof v !== "number" && typeof v !== "bigint") return next;
      return computed(expression.operator === "-" ? -v : v, next);
    }
    case "binary": {
      const left = fold(expression.left), right = fold(expression.right), next = { ...expression, left, right };
      const a = value(left), b = value(right), op = expression.operator;
      if (op === "&&" && a === false || op === "||" && a === true) return literal(a as boolean);
      if (op === "??" && left.kind === "undefined") return right;
      if (a === undefined || b === undefined || typeof a !== typeof b) return next;
      if (op === "===") return literal(a === b);
      if (op === "!==") return literal(a !== b);
      if (op === "<") return literal(a < b);
      if (op === "<=") return literal(a <= b);
      if (op === ">") return literal(a > b);
      if (op === ">=") return literal(a >= b);
      if (typeof a === "boolean" && typeof b === "boolean") return op === "&&" ? literal(a && b) : op === "||" ? literal(a || b) : next;
      const base = baseType(expression.type, context);
      if (typeof a === "bigint" && typeof b === "bigint") {
        if (op === "+") return computed(a + b, next);
        if (op === "-") return computed(a - b, next);
        if (op === "*") return computed(a * b, next);
        return next;
      }
      if (typeof a !== "number" || typeof b !== "number" || base.kind !== "number" || base.name === "usize") return next;
      if (op === "+") return computed(a + b, next);
      if (op === "-") return computed(a - b, next);
      if (op === "*") return computed(base.name.startsWith("f") ? a * b : __modelMultiply(a, b), next);
      // Integer / and % can trap; preserve that operation and its timing.
      if (base.name.startsWith("f") && op === "/") return computed(a / b, next);
      if (base.name.startsWith("f") && op === "%") return computed(a % b, next);
      return next;
    }
    case "conditional": {
      const condition = fold(expression.condition);
      if (condition.kind === "literal" && typeof condition.value === "boolean") return fold(condition.value ? expression.consequent : expression.alternate);
      return { ...expression, condition, consequent: fold(expression.consequent), alternate: fold(expression.alternate) };
    }
    case "template": {
      const parts = expression.parts.map(part => typeof part === "string" ? part : fold(part));
      const rendered = parts.map(part => typeof part === "string" ? part : buildText(part, context, true));
      return rendered.every(part => part !== undefined) ? literal(rendered.join("")) : { ...expression, parts };
    }
    case "call": {
      const args = expression.arguments.map(fold), next = { ...expression, arguments: args };
      if (expression.target !== "builtin") return next;
      const values = args.map(value);
      if (values.some(value => value === undefined)) return next;
      const [a, b, c] = values;
      if (typeof a === "bigint") {
        if (expression.name === "abs") return computed(a < 0n ? -a : a, next);
        if (typeof b !== "bigint") return next;
        if (expression.name === "idiv") return computed(b === 0n ? 0n : a / b, next);
        if (expression.name === "imod") return computed(b === 0n ? 0n : a % b, next);
        if (expression.name === "min") return computed(a < b ? a : b, next);
        if (expression.name === "max") return computed(a > b ? a : b, next);
        if (expression.name === "clamp" && typeof c === "bigint") return computed((a > b ? a : b) < c ? (a > b ? a : b) : c, next);
        return next;
      }
      if (expression.name === "len" && typeof a === "string") return computed(len(a), next);
      if (typeof a !== "number" || values.some(v => typeof v !== "number")) return next;
      const numeric = [a, b as number, c as number];
      switch (expression.name) {
        case "abs": return computed(abs(a), next);
        case "min": return computed(min(a, numeric[1]!), next);
        case "max": return computed(max(a, numeric[1]!), next);
        case "clamp": return computed(clamp(a, numeric[1]!, numeric[2]!), next);
        case "idiv": return computed(idiv(a, numeric[1]!), next);
        case "imod": return computed(imod(a, numeric[1]!), next);
        case "floor": return computed(floor(a), next);
        case "ceil": return computed(ceil(a), next);
        case "round": return computed(round(a), next);
        case "trunc": return computed(trunc(a), next);
        case "fixed": return Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 100 ? literal(fixed(a, b as number)) : next;
        default: return next;
      }
    }
    // Rust float-to-integer casts saturate, integer casts wrap; do not treat
    // those as interchangeable with typed arithmetic normalization.
    case "cast": case "narrow": return { ...expression, value: fold(expression.value) };
    case "field": return { ...expression, object: fold(expression.object) };
    case "index": return { ...expression, object: fold(expression.object), index: fold(expression.index) };
    default: return expression;
  }
}

/** Mirrors displayExpr's model-dependent f32 formatting. Absent direct text
 * is empty; absent template interpolation is "undefined". */
export function buildText(expression: AotExpr, context: AotFoldContext, template = false): string | undefined {
  if (expression.kind === "undefined") return template ? "undefined" : "";
  if (!isBuildExpression(expression) || expression.kind !== "literal") return;
  const type = baseType(expression.type, context);
  if (rawF32Midpoint(expression, type)) return;
  if (type.kind === "number") {
    if (type.name === "usize") return;
    if (type.name === "i64" || type.name === "u64") return expression.rawNumber ?? (Number.isSafeInteger(expression.value) ? String(expression.value) : undefined);
    if (type.name === "f32") {
      const value = __modelNumber(expression.value as number, "f32");
      if (!context.promoteF32Text && !(Number.isInteger(value) && Math.abs(value) <= 16777216) && Number.isFinite(value)) return;
      return String(value);
    }
    return String(expression.value);
  }
  const declaration = type.kind === "named" ? context.types.find(value => value.name === type.name) : undefined;
  if (declaration?.kind === "newtype" && declaration.unit === "Color") {
    if (typeof expression.value !== "string") return;
    const bits = parseMicroTsColor(expression.value);
    return "#" + [bits & 255, bits >>> 8 & 255, bits >>> 16 & 255, bits >>> 24].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return type.kind === "string" || type.kind === "boolean" || declaration?.kind === "enum" ? String(expression.value) : undefined;
}
