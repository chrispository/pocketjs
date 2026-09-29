// Native specialization must not reach the guest: the serialized IR and the
// bundled guest JavaScript are byte-identical with it on and off.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";
import { generateStylesModule } from "../framework/compiler/tailwind.ts";
import { analyzeAot, buildAot } from "../microts/compiler/aot-build.ts";
import type { AotProgram } from "../microts/compiler/aot-ir.ts";
import { analyzeAotSpecialization } from "../microts/compiler/aot-specialization.ts";
import { OUT } from "./helpers/microts-specialization.ts";

/** Bundles the guest with the framework plugin and a build-local style module. */
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
  const entry = resolve(`apps/${app}/app.${app === "solid-aot-lab" ? "tsx" : "vue"}`);
  const initial = analyzeAot(entry, { strict: true });
  const baseline = await guest(app, initial);
  for (const specialize of ["off", "on"] as const) {
    const outDir = resolve(OUT, "guest", app, specialize), ir = resolve(outDir, "view.json"), modelIr = resolve(outDir, "view.model.json");
    const built = await buildAot(entry, { specialize, strict: true, format: false, outDir, ir });
    expect(readFileSync(ir, "utf8")).toBe(JSON.stringify(initial, null, 2) + "\n");
    if (initial.model) expect(readFileSync(modelIr, "utf8")).toBe(JSON.stringify(initial.model, null, 2) + "\n");
    else expect(existsSync(modelIr)).toBe(false);
    analyzeAotSpecialization(built.program); // the report runs in the same process
    expect(await guest(app, built.program)).toEqual(baseline);
  }
}, 120_000);
