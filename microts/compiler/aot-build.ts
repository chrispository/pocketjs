/** Public Vue SFC / Solid TSX -> generated Rust build entry. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { analyzeSolidAot } from "./aot-solid-frontend.ts";
import { analyzeVueAot } from "./aot-frontend.ts";
import { emitAot } from "./aot-codegen.ts";
import type { AotProgram } from "./aot-ir.ts";
import { requireAotBoard, aotBoardAdmission } from "./aot-admission.ts";
import { attachCompiledModel } from "./aot-model-build.ts";
import { generateModelRust } from "./aot-model-codegen.ts";
import { replayModelTape } from "./aot-model-tape.ts";
import { analyzeAotSpecialization, formatAotSpecializationReport } from "./aot-specialization.ts";
import { createSpecializationContract, type SpecializationContractOptions } from "./aot-specialization-contract.ts";
import { bakeAotSpecialization, type AotSpecializationBake } from "./aot-specialization-bake.ts";
import { createStaticDrawPlans } from "./aot-static-draw-plan.ts";

export function analyzeAot(entry: string, options: { strict?: boolean } = {}): AotProgram {
  return attachCompiledModel(entry.endsWith(".tsx") ? analyzeSolidAot(entry, options) : analyzeVueAot(entry, options), entry, options.strict);
}
export interface AotBuildOptions {
  strict?: boolean;
  outDir?: string;
  format?: boolean;
  ir?: string;
  board?: string;
  /** Internal comparison override; native optimizations are enabled by default. */
  specialize?: "on" | "off";
  /** Register logical node identities in a runtime built with `harness`. */
  harness?: boolean;
  /** Native host asset bytes and environment used by guarded layout proofs. */
  specializationEnvironment?: SpecializationContractOptions;
  /** Baking requires a target with a maintained native/wasm golden. */
  specializationTarget?: string;
  specializationShapeCacheBytes?: number;
}
export interface AotBuildResult {
  entry: string;
  outDir: string;
  files: string[];
  program: AotProgram;
  specializationBake?: AotSpecializationBake;
}

export function resolveAotEntry(app: string): string {
  const root = resolve(import.meta.dir, "../..");
  const candidates = [resolve(app), resolve(root, "apps", app)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (statSync(path).isFile() && /\.(vue|tsx)$/.test(path)) return path;
    if (!statSync(path).isDirectory()) continue;
    for (const name of ["app.vue", "App.vue", `${basename(path)}.vue`, "app.tsx", "App.tsx", `${basename(path)}.tsx`]) {
      const entry = join(path, name);
      if (existsSync(entry)) return entry;
    }
    const manifest = join(path, "pocket.json");
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, "utf8")).app?.entry;
      if (typeof entry === "string" && /\.(vue|tsx)$/.test(entry)) {
        const filename = resolve(path, entry);
        if (existsSync(filename)) return filename;
      }
    }
  }
  throw new Error(`MicroTS: cannot resolve ${JSON.stringify(app)} to a root .vue or .tsx component`);
}

export async function buildAot(app: string, options: AotBuildOptions = {}): Promise<AotBuildResult> {
  const entry = resolveAotEntry(app);
  const program = analyzeAot(entry, { strict: options.strict });
  if (options.board) requireAotBoard(program, options.board);
  let environment = options.specializationEnvironment;
  if (!environment && options.specialize !== "off") {
    const manifest = join(dirname(entry), "pocket.json");
    const config = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : undefined;
    environment = { viewport: config?.app?.viewport?.fixed?.logical ?? [480, 272], tickRate: 60 };
  }
  const specializationContract = options.specialize !== "off" && environment
    ? createSpecializationContract(program, environment) : undefined;
  if (options.specializationShapeCacheBytes !== undefined && (!Number.isSafeInteger(options.specializationShapeCacheBytes) || options.specializationShapeCacheBytes < 0)) throw new Error("MicroTS specialization shape cache budget must be a nonnegative integer");
  const specializationBake = specializationContract && environment && options.specializationTarget
    ? await bakeAotSpecialization(program, { target: options.specializationTarget, environment }) : undefined;
  const staticDraw = specializationBake && environment ? createStaticDrawPlans(program, specializationBake.regions, environment) : undefined;
  if (specializationBake && staticDraw) specializationBake.diagnostics.push(...staticDraw.rejected.map(rejection => `${rejection.sourceKey}: static draw plan declined: ${rejection.reasons.join("; ")}`));
  const output = emitAot(program, { specialize: options.specialize !== "off", harness: options.harness, specializationContract, specializationBake, specializationShapeCacheBytes: options.specializationShapeCacheBytes, staticDrawPlans: staticDraw?.plans });
  if (program.model) {
    const name = program.root.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() + "_model";
    output.files[`${name}.rs`] = generateModelRust(program.model, program, { specialize: options.specialize !== "off" });
    output.files["mod.rs"] += `\nmod ${name};\npub use self::${name}::*;\n`;
  }
  const outDir = resolve(options.outDir ?? join(dirname(entry), "gen"));
  const files: string[] = [];
  const formatted = new Map<string, string>();
  // Format in memory before replacing generated files, so a broken emitter
  // never leaves the app with a mixture of old and new Rust modules.
  const rustfmt = options.format !== false ? Bun.which("rustfmt") : null;
  for (const [name, code] of Object.entries(output.files)) {
    if (isAbsolute(name) || relative(outDir, resolve(outDir, name)).startsWith("..")) {
      throw new Error(`MicroTS: emitter returned invalid output path ${name}`);
    }
    let source = code;
    if (rustfmt && name.endsWith(".rs")) {
      const result = Bun.spawn([rustfmt, "--edition", "2021", "--emit", "stdout", "--config", "skip_children=true"], {
        stdin: new Blob([source]), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited,
      ]);
      if (status !== 0) throw new Error(`MicroTS: rustfmt rejected ${name}:\n${stderr}`);
      source = stdout;
    }
    formatted.set(name, source);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, code] of formatted) {
    const path = join(outDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);
    files.push(path);
  }
  const stylePath = join(outDir, "styles.bin");
  writeFileSync(stylePath, Uint8Array.from(program.styles.bytes));
  files.push(stylePath);
  if (options.ir) {
    const path = resolve(options.ir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(program, null, 2) + "\n");
    files.push(path);
    if (program.model) {
      const modelPath = path.replace(/\.json$/, "") + ".model.json";
      writeFileSync(modelPath, JSON.stringify(program.model, null, 2) + "\n"); files.push(modelPath);
    }
  }
  return { entry, outDir, files, program, ...(specializationBake ? { specializationBake } : {}) };
}

export async function runAotCli(args: string[]): Promise<void> {
  if (args[0] === "run") {
    const app = args[1], tapeIndex = args.indexOf("--tape"), tapePath = args[tapeIndex + 1];
    if (!app || tapeIndex < 0 || !tapePath) throw new Error("usage: bun microts/compiler/cli.ts run <app> --tape <file>");
    const program = analyzeAot(resolveAotEntry(app));
    if (!program.model) throw new Error("Model interpreter requires app.model = compiled");
    const tape = JSON.parse(readFileSync(tapePath, "utf8"));
    for (const frame of replayModelTape(program, tape)) console.log(JSON.stringify(frame));
    return;
  }
  const command = args[0] === "check" ? "check" : "build";
  if (args[0] === "build" || args[0] === "check") args = args.slice(1);
  let app: string | undefined;
  let outDir: string | undefined;
  let ir: string | undefined;
  let strict = false;
  let json = false;
  let format = true;
  let board: string | undefined;
  let boards = false;
  let specialize: "on" | "off" = "on";
  let report: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-format") format = false;
    else if (arg === "--boards") boards = true;
    // Internal differential/debugging switch; omitted from public CLI help.
    else if (arg === "--specialize" || arg.startsWith("--specialize=")) {
      const value = arg === "--specialize" ? args[++i] : arg.slice(13);
      if (value !== "on" && value !== "off") throw new Error("MicroTS: --specialize expects on or off");
      specialize = value;
    }
    else if (arg === "--report" || arg.startsWith("--report=")) {
      report = arg === "--report" ? args[++i] : arg.slice(9);
      if (report !== "specialization") throw new Error("MicroTS: --report expects specialization");
    }
    else if (arg === "--out" || arg === "--ir" || arg === "--board") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`MicroTS: ${arg} needs a path`);
      if (arg === "--out") outDir = value;
      else if (arg === "--ir") ir = value;
      else board = value;
    } else if (arg.startsWith("--out=")) outDir = arg.slice(6);
    else if (arg.startsWith("--ir=")) ir = arg.slice(5);
    else if (arg.startsWith("--board=")) board = arg.slice(8);
    else if (arg.startsWith("-")) throw new Error(`MicroTS: unknown option ${arg}`);
    else if (app) throw new Error(`MicroTS: unexpected argument ${arg}`);
    else app = arg;
  }
  if (!app) throw new Error("usage: bun microts/compiler/cli.ts build <app|Root.vue|App.tsx> [--out gen] [--strict] [--ir file] [--board name] [--boards] [--no-format]");
  const result = command === "build"
    ? await buildAot(app, { strict, outDir, ir, format, board, specialize })
    : { entry: resolveAotEntry(app), program: analyzeAot(resolveAotEntry(app), { strict }), files: [] };
  if (command === "check" && ir) {
    const path = resolve(ir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result.program, null, 2) + "\n");
    if (result.program.model) writeFileSync(path.replace(/\.json$/, "") + ".model.json", JSON.stringify(result.program.model, null, 2) + "\n");
  }
  const admission = aotBoardAdmission(result.program, board, boards);
  const specialization = report || strict ? analyzeAotSpecialization(result.program) : undefined;
  if (strict) for (const diagnostic of specialization?.diagnostics ?? []) {
    console.warn(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: warning ${diagnostic.code}: ${diagnostic.message}`);
  }
  if (json) await Bun.write(Bun.stdout, JSON.stringify(report ? specialization : (admission.length ? { ...result.program, admission } : result.program), null, 2) + "\n");
  else {
    for (const diagnostic of result.program.diagnostics) {
      console.warn(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}: ${diagnostic.message}`);
    }
    console.log(`MicroTS: ${result.program.root}, ${result.program.components.length} components, ${result.program.styles.records.length} styles`);
    for (const file of result.files) console.log(file);
    if (report && specialization) console.log(formatAotSpecializationReport(specialization));
    for (const row of admission) {
      console.log(`${row.board}: ${row.ok ? "OK" : "FAIL"} (input profile)`);
      for (const issue of row.issues) console.log(`  ${issue.severity} ${issue.code}: ${issue.message}`);
    }
  }
  if (board && admission.some(row => !row.ok)) process.exitCode = 1;
}
