/** Fixtures shared by the MicroTS UI specialization tests. */
import { expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FONT_MAGIC, FONT_VERSION, encodeStyleTable, type AnimTimeline, type StyleRecord } from "../../contracts/spec/spec.ts";
import { emitAot, type AotEmitOptions } from "../../microts/compiler/aot-codegen.ts";
import { BOOL, I32, STRING, type AotComponent, type AotExpr, type AotNode, type AotProgram, type AotType } from "../../microts/compiler/aot-ir.ts";
import { executeSpecialization, type SpecializationFrame, type SpecializationHarnessOptions } from "../../microts/compiler/specialization-harness.ts";

/** Ignored output root for generated crates, apps and cargo logs. */
export const OUT = resolve(".pocket-build/validation/microts-specialization");

// AOT IR builders. Node and memo IDs default to 0; codegen assigns its own.

export const loc = { file: resolve("tests/fixtures/aot/specialization/App.tsx"), line: 1, column: 1, offset: 0 };
export type Element = Extract<AotNode, { kind: "element" }>;
export const num = (name: Extract<AotType, { kind: "number" }>["name"]): AotType => ({ kind: "number", name });

export const lit = (value: string | number | boolean, type?: AotType): AotExpr =>
  ({ kind: "literal", value, type: type ?? (typeof value === "number" ? I32 : typeof value === "boolean" ? BOOL : STRING), loc });
/** A literal that keeps its source spelling, e.g. a decimal that no f32 represents exactly. */
export const raw = (source: string, type: AotType = num("f32")): AotExpr =>
  ({ kind: "literal", value: Number(source), rawNumber: source, type, loc }) as AotExpr;
export const vm = (name: string, type: AotType = I32): AotExpr => ({ kind: "binding", scope: "vm", name, type, loc });
export const local = (name: string, type: AotType = I32): AotExpr => ({ kind: "binding", scope: "local", name, type, loc });
export const call = (name: string, type: AotType = I32): AotExpr => ({ kind: "call", target: "vm", name, arguments: [], type, loc });
export const builtin = (name: string, type: AotType, ...args: AotExpr[]): AotExpr => ({ kind: "call", target: "builtin", name, arguments: args, type, loc });
export const binary = (operator: string, left: AotExpr, right: AotExpr, type = left.type): AotExpr => ({ kind: "binary", operator, left, right, type, loc });

export const text = (parts: (string | AotExpr)[], id = 0): Element =>
  ({ kind: "element", id, tag: "Text", style: -1, props: [], text: { parts, memo: id }, focusable: false, events: [], children: [], loc });
export const view = (style = -1, children: AotNode[] = [], id = 0): Element =>
  ({ kind: "element", id, tag: "View", style, props: [], focusable: false, events: [], children, loc });
export const show = (condition: AotExpr, children: AotNode[], id = 0): AotNode => ({ kind: "if", id, branches: [{ condition, children }], loc });
export const instance = (name: string, extra: Partial<Extract<AotNode, { kind: "component" }>> = {}): AotNode =>
  ({ kind: "component", id: 0, component: name, props: [], events: [], slots: [], loc, ...extra });
export const component = (name: string, nodes: AotNode[] = [], extra: Partial<AotComponent> = {}): AotComponent =>
  ({ name, file: loc.file, root: name === "App", props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 0, memoCount: 0, handlerCount: 0, ...extra });
/** A model method the view calls as an event handler or lifecycle hook. */
export const handler = (name: string) => ({
  method: { name, sourceName: name, parameters: [], returns: { kind: "void" } as AotType, binding: false, handler: true },
  call: { kind: "call" as const, id: 0, loc, expression: { kind: "call" as const, target: "vm" as const, name, arguments: [], type: { kind: "void" } as AotType, loc } },
});

export interface ProgramOptions { components?: AotComponent[]; styles?: StyleRecord[]; anims?: AnimTimeline[]; fontSlots?: number[] }
/** A program whose root is `App`; other components come first. */
export function program(app: AotNode[] | AotComponent, { components = [], styles = [], anims = [], fontSlots = [] }: ProgramOptions = {}): AotProgram {
  const root = Array.isArray(app) ? component("App", app) : app;
  return {
    version: 1, root: "App", components: [...components, root], types: [], diagnostics: [],
    styles: { records: styles, anims, ids: {}, bytes: [...encodeStyleTable(styles, anims)], usedFontSlots: fontSlots },
  };
}

/** Recursively freezes `value`, so any write by the code under test throws. */
export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export interface FontAtlasOptions { slot?: number; cell?: [number, number]; lineHeight?: number; tofu?: number; glyphs?: Record<string, number> }
/**
 * A version-3 font atlas with full-coverage cells (1x1 by default). Glyph 0
 * (codepoint 0) is the tofu box; `glyphs` maps characters to advances.
 */
export function fontAtlas({ slot = 0, cell: [width, height] = [1, 1], lineHeight = 1, tofu = 1, glyphs = {} }: FontAtlasOptions = {}): Uint8Array {
  const cmap = [[0, tofu], ...Object.entries(glyphs).map(([char, advance]) => [char.codePointAt(0)!, advance])].sort((a, b) => a[0]! - b[0]!);
  const bytes = new Uint8Array(16 + cmap.length * (8 + width * height));
  const data = new DataView(bytes.buffer);
  data.setUint32(0, FONT_MAGIC, true);
  data.setUint16(4, FONT_VERSION, true);
  data.setUint16(6, cmap.length, true);
  bytes.set([width, height, height, lineHeight, slot, 0, 1, 0], 8); // baseline at the cell bottom, flags 0, density 1
  cmap.forEach(([codepoint, advance], gid) => {
    data.setUint32(16 + gid * 8, codepoint!, true);
    data.setUint16(20 + gid * 8, gid, true);
    bytes[22 + gid * 8] = advance!;
  });
  bytes.fill(255, 16 + cmap.length * 8);
  return bytes;
}

/** Rust `&[u8]` literal. */
export const rustBytes = (bytes: ArrayLike<number>) => `&[${Array.from(bytes).join(",")}]`;

/** `off.rs` is the reference output; `on.rs` is specialized with `options`. */
export function emitPair(input: AotProgram, options: AotEmitOptions = {}): Record<string, string> {
  return {
    "off.rs": emitAot(input, { harness: options.harness }).files["app.rs"]!,
    "on.rs": emitAot(input, { ...options, specialize: true }).files["app.rs"]!,
  };
}

/**
 * Writes a crate that depends on `microts` and runs its `main.rs`, or
 * `cargo test` when the sources have a `lib.rs`. Fails with cargo's output.
 */
export function runCrate(name: string, sources: Record<string, string>, features = ["std", "counters"]): void {
  const directory = resolve(OUT, "crates", name);
  mkdirSync(resolve(directory, "src"), { recursive: true });
  const microts = `microts = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ${JSON.stringify(features)} }`;
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\n${microts}\n`);
  for (const [file, source] of Object.entries(sources)) writeFileSync(resolve(directory, "src", file), source);
  const command = "lib.rs" in sources ? ["test", "--lib"] : ["run"];
  const result = Bun.spawnSync(["cargo", ...command, "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(OUT, "target") },
  });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(resolve(directory, "cargo.log"), output);
  expect(result.exitCode, output).toBe(0);
}

/** Writes `files` as an app directory and returns its path. */
export function writeApp(name: string, files: Record<string, string>, compiledModel = "App.ts" in files): string {
  const directory = resolve(OUT, "apps", `${name}-${process.pid}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const entry = Object.keys(files).find(file => /^App\.(tsx|vue)$/.test(file))!;
  const app = { framework: entry.endsWith(".vue") ? "vue-vapor" : "solid", aot: true, entry, ...(compiledModel ? { model: "compiled" } : {}) };
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ app }));
  for (const [file, source] of Object.entries(files)) writeFileSync(resolve(directory, file), source);
  return directory;
}

/**
 * Runs an app through the native harness, which builds the reference and
 * specialized binaries, replays the tape and rejects any observable
 * difference. Apps without `App.ts` get an empty handwritten model.
 */
export function runApp(name: string, files: Record<string, string>, options: SpecializationHarnessOptions = {}) {
  const compiled = "App.ts" in files && options.modelSource === undefined;
  const model = compiled || options.modelSource ? {} : { modelSource: "struct Model; impl AppViewModel for Model {}", modelExpression: "Model" };
  return executeSpecialization(writeApp(name, files, compiled), { ...model, ...options });
}

export type Run = Awaited<ReturnType<typeof executeSpecialization>>;
export type Mode = Run["reference"];

/** One counter value per frame. */
export const perFrame = (mode: Mode, counter: string) => mode.frames.map(frame => frame.counters[counter] ?? 0);
export const total = (mode: Mode, counter: string) => perFrame(mode, counter).reduce((sum, value) => sum + value, 0);

/** `length` idle frames with `events` at their frame indices. */
export const frames = (length: number, events: Record<number, SpecializationFrame> = {}): SpecializationFrame[] =>
  Array.from({ length }, (_, index) => events[index] ?? {});

export interface TreeNode { node: string; text: string; children: TreeNode[] }
/** Every node of a harness tree observation, depth first. */
export const treeNodes = (tree: unknown): TreeNode[] => [tree as TreeNode, ...(tree as TreeNode).children.flatMap(treeNodes)];
export const treeTexts = (tree: unknown) => treeNodes(tree).map(node => node.text).filter(Boolean);
