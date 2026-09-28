import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";
import { generateStylesModule } from "../framework/compiler/tailwind.ts";
import { analyzeAot, buildAot } from "../microts/compiler/aot-build.ts";
import { analyzeAotSpecialization } from "../microts/compiler/aot-specialization.ts";
import type { AotProgram } from "../microts/compiler/aot-ir.ts";

const run = resolve(".pocket-build/validation/microts-specialization", `guest-${process.pid}-${Date.now()}`);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// Use the actual framework bundling plugin with a build-local style module.
// This gate does not rewrite the shared styles.generated.ts mirror.
async function guest(app: string, program: AotProgram): Promise<Uint8Array> {
  const solid = app === "solid-aot-lab", entry = resolve(`apps/${app}/main.${solid ? "tsx" : "ts"}`);
  const { bytes, ...styles } = program.styles;
  const build = await Bun.build({
    entrypoints: [entry], target: "browser", format: "iife", conditions: ["browser"],
    plugins: [jsxPlugin(solid ? "solid" : "vue-vapor", { entry, generatedStyles: generateStylesModule({ ...styles, bin: Uint8Array.from(bytes) }) })],
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  expect(build.outputs).toHaveLength(1);
  return new Uint8Array(await build.outputs[0]!.arrayBuffer());
}

test.each(["solid-aot-lab", "vue-sfc-lab"])("%s guest bytes and serialized IR do not depend on native specialization", async app => {
  const directory = resolve(run, app), entry = resolve(`apps/${app}/app.${app === "solid-aot-lab" ? "tsx" : "vue"}`);
  mkdirSync(directory, { recursive: true });
  const initial = analyzeAot(entry, { strict: true });
  const baseline = await guest(app, initial);
  const ir: Record<string, string> = {}, bundles: Record<string, string> = {};
  for (const specialize of ["off", "on"] as const) {
    const irPath = resolve(directory, specialize, "view.json");
    const built = await buildAot(entry, { specialize, strict: true, format: false, outDir: resolve(directory, specialize), ir: irPath });
    const serialized = readFileSync(irPath, "utf8"), modelPath = irPath.replace(/\.json$/, ".model.json");
    expect(serialized).toBe(JSON.stringify(initial, null, 2) + "\n");
    if (initial.model) expect(readFileSync(modelPath, "utf8")).toBe(JSON.stringify(initial.model, null, 2) + "\n");
    else expect(existsSync(modelPath)).toBe(false);
    // Running the report in the same process must not alter guest caches or IR.
    analyzeAotSpecialization(built.program);
    const bundle = await guest(app, built.program);
    expect(bundle).toEqual(baseline);
    ir[specialize] = hash(serialized);
    bundles[specialize] = hash(bundle);
    writeFileSync(resolve(directory, specialize, "guest.js"), bundle);
  }
  expect(ir.on).toBe(ir.off);
  expect(bundles.on).toBe(bundles.off);
  writeFileSync(resolve(directory, "receipt.json"), JSON.stringify({ app, command: "bun test tests/microts-specialization-guest.test.ts", acceptance: "byte equality for guest JS, View IR, and Model IR", guestBytes: baseline.length, baseline: hash(baseline), ir, bundles }, null, 2) + "\n");
}, 120_000);
