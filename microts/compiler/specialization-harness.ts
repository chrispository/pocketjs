/** Native on/off oracle. Every retained word and logical identity is compared. */
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeAot, buildAot, resolveAotEntry } from "./aot-build.ts";
import { bakeAtlases } from "../../framework/compiler/bake-font.ts";

export interface SpecializationFrame {
  buttons?: number;
  axes?: [number, number];
  motion?: unknown;
  /** Points to hit-test after the frame, independent of press input. */
  touch?: [number, number][];
  press?: [number, number];
  viewport?: [number, number];
  /** Atlas filenames, resolved relative to the fixture. */
  fonts?: string[];
  deliveries?: unknown[];
  invalidate?: boolean;
  set_props?: boolean;
}
export interface SpecializationTape {
  viewport?: [number, number];
  hz?: number;
  services?: string[];
  frames: SpecializationFrame[];
}
export interface SpecializationHarnessOptions {
  tape?: SpecializationTape | SpecializationFrame[];
  /** Handwritten Rust model source for fixtures without a compiled model. */
  modelSource?: string;
  modelExpression?: string;
  propsExpression?: string;
  /** Build optimized native binaries for host timing and size measurements. */
  release?: boolean;
  specializationTarget?: string;
}
export interface SpecializationObservation {
  bootCounters: Record<string, number>;
  frames: { words: number[]; hash: string; pixels_hash: string; glyph_misses: number; focused: string; hits: string[]; tree: unknown; commands: unknown[]; ready: unknown[]; counters: Record<string, number> }[];
  cleanup: unknown[];
}

export async function executeSpecialization(app: string, options: SpecializationHarnessOptions = {}) {
  const run = resolve(".pocket-build/validation/microts-specialization", `${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const packageSuffix = run.split("/").at(-1)!;
  await mkdir(run, { recursive: true });
  const entry = resolveAotEntry(app);
  const program = analyzeAot(entry, { strict: true });
  const fixture = dirname(entry);
  const rawTape = options.tape ?? JSON.parse(await readFile(resolve(fixture, "tape.json"), "utf8"));
  const tape: SpecializationTape = Array.isArray(rawTape) ? { frames: rawTape } : rawTape;
  // Include source literals plus ASCII so dynamic numeric text emits glyphs.
  const codepoints = new Set(Array.from(JSON.stringify(program), c => c.codePointAt(0)!));
  const atlases = await bakeAtlases({ slots: [...new Set([0, ...program.styles.usedFontSlots])], codepoints });
  const builds = [];
  for (const specialize of ["off", "on"] as const) {
    builds.push(await buildAot(app, { strict: true, specialize, harness: true, format: false,
      specializationEnvironment: { viewport: tape.viewport ?? [480, 272], tickRate: tape.hz ?? 60, fontAtlases: atlases },
      specializationTarget: options.specializationTarget,
      outDir: resolve(run, specialize, "src/gen"), ir: resolve(run, specialize, "ir.json") }));
  }
  const [off, on] = builds;
  if (!off || !on) throw new Error("Missing specialization build");
  const ir = await Promise.all(["off", "on"].map(mode => readFile(resolve(run, mode, "ir.json"), "utf8")));
  if (ir[0] !== ir[1]) throw new Error(`Specialization changed shared View IR: ${run}`);
  if (off.program.model) {
    const model = await Promise.all(["off", "on"].map(mode => readFile(resolve(run, mode, "ir.model.json"), "utf8")));
    if (model[0] !== model[1]) throw new Error(`Specialization changed shared Model IR: ${run}`);
  } else if (!options.modelSource) throw new Error("A handwritten model fixture requires modelSource");
  const normalized = { ...tape, frames: tape.frames.map(frame => ({ ...frame,
    ...(frame.fonts ? { fonts: frame.fonts.map(path => resolve(fixture, path)) } : {}) })) };
  await Bun.write(resolve(run, "tape.json"), JSON.stringify(normalized));
  const fontPaths: string[] = [];
  for (const atlas of atlases) {
    const path = resolve(run, `font-${atlas.slot}.bin`);
    await Bun.write(path, atlas.bytes); fontPaths.push(path);
  }
  const template = await readFile(new URL("./specialization-driver.rs.in", import.meta.url), "utf8");
  const source = template.replaceAll("__ROOT__", off.program.root)
    .replace("__MODEL_SOURCE__", options.modelSource ?? "")
    .replaceAll("__PROPS__", options.propsExpression ?? `${off.program.root}Props {}`)
    .replace("__MODEL__", options.modelExpression ?? `${off.program.root}Model::default()`)
    .replace("__TAPE__", JSON.stringify(resolve(run, "tape.json")))
    .replace("__FONTS__", fontPaths.map(path => `include_bytes!(${JSON.stringify(path)}).as_slice()`).join(","));
  const observations: SpecializationObservation[] = [];
  const generatedLines: Record<string, number> = {};
  const binaryBytes: Record<string, number> = {};
  for (const [index, mode] of ["off", "on"].entries()) {
    const directory = resolve(run, mode!);
    await Bun.write(resolve(directory, "src/main.rs"), source.replace("__PREPARE_SPECIALIZATION__", mode === "on" ? "prepare_specialization(&mut ui);" : ""));
    await Bun.write(resolve(directory, "Cargo.toml"), `[package]\nname="microts-specialization-${mode}-${packageSuffix}"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve(import.meta.dir, "../../engine/crates/microts"))},features=["std","counters","harness"]}\nserde_json="1"\n[profile.dev]\noverflow-checks=false\n`);
    const child = Bun.spawn(["cargo", "run", "--quiet", ...(options.release ? ["--release"] : []), "--manifest-path", resolve(directory, "Cargo.toml")], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") },
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Bun.write(resolve(directory, "native.log"), stderr);
    if (status !== 0) throw new Error(`Specialization ${mode} native run failed (${run}):\n${stderr}`);
    const observation = JSON.parse(stdout) as SpecializationObservation;
    observations.push(observation);
    await Bun.write(resolve(directory, "observations.json"), JSON.stringify(observation, null, 2));
    generatedLines[mode!] = (await Promise.all(builds[index]!.files.filter(file => file.endsWith(".rs")).map(file => readFile(file, "utf8")))).reduce((n, text) => n + text.split("\n").length, 0);
    binaryBytes[mode!] = Bun.file(resolve(".pocket-build/validation/microts-specialization/target", options.release ? "release" : "debug", `microts-specialization-${mode}-${packageSuffix}`)).size;
  }
  const [reference, specialized] = observations as [SpecializationObservation, SpecializationObservation];
  const frameObservable = ({ counters, ...frame }: SpecializationObservation["frames"][number]) => frame;
  const observable = (value: SpecializationObservation) => ({ frames: value.frames.map(frameObservable), cleanup: value.cleanup });
  if (!isDeepStrictEqual(observable(reference), observable(specialized))) {
    const first = reference.frames.findIndex((frame, index) => !specialized.frames[index] || !isDeepStrictEqual(frameObservable(frame), frameObservable(specialized.frames[index]!)));
    throw new Error(`Specialization differs at ${first < 0 ? "cleanup" : `frame ${first}`}; full words and observations: ${run}`);
  }
  await Bun.write(resolve(run, "summary.json"), JSON.stringify({ equal: true, frames: reference.frames.length, profile: options.release ? "release" : "debug", host: `${process.platform}-${process.arch}`, generatedLines, binaryBytes }, null, 2));
  return { reference, specialized, generatedLines, binaryBytes, run, program: off.program };
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter(arg => arg !== "--release");
  const app = args[0];
  if (!app) throw new Error("usage: bun microts/compiler/specialization-harness.ts <app> [tape.json] [--release]");
  const tape = args[1] ? JSON.parse(await readFile(resolve(args[1]), "utf8")) : undefined;
  const result = await executeSpecialization(app, { tape, release: process.argv.includes("--release") });
  console.log(`Specialization: ${result.reference.frames.length} frames equal; ${result.run}`);
}
