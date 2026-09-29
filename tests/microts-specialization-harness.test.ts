import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeSpecialization } from "../microts/compiler/specialization-harness.ts";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { registerAnimationTheme } from "../framework/compiler/animation.ts";
import { DRAW_OP, PROP } from "../contracts/spec/spec.ts";

test("sensor-list preserves words, keyed logical identities, focus, hits and commands", async () => {
  const result = await executeSpecialization("sensor-list");
  expect(result.reference.frames).toHaveLength(16);
  expect(result.reference.frames[0]!.words.length).toBeGreaterThan(0);
  const sum = (mode: typeof result.reference, field: string) => mode.frames.reduce((n, frame) => n + (frame.counters[field] ?? 0), 0);
  expect(sum(result.specialized, "memo_evaluations")).toBeLessThan(sum(result.reference, "memo_evaluations"));
  expect(sum(result.specialized, "update_at")).toBeLessThan(sum(result.reference, "update_at"));
  // The general solver now retains text measurements across topology edits.
  // Separate region solvers still rebuild at boundary changes/deoptimization,
  // so total shaping work no longer has a strict on < off ordering.
  expect(sum(result.reference, "structure_rebuilds")).toBe(1);
  expect(result.reference.frames[4]!.counters.shaping_calls).toBe(0);
  expect(result.reference.frames[9]!.counters.shaping_calls).toBeLessThan(result.reference.frames[0]!.counters.shaping_calls!);
  expect(sum(result.specialized, "generated_words")).toBeLessThan(sum(result.reference, "generated_words"));
  expect(sum(result.specialized, "region_cache_hits")).toBeGreaterThan(0);
  expect(result.specialized.frames[0]!.counters.draw_segments).toBeGreaterThan(0);
  expect(result.specialized.frames.at(-1)!.counters.draw_segments).toBe(0);
  // Scroll rebuilds the containing list solver, without rebuilding or shaping
  // any of its three fixed card regions.
  expect(result.specialized.frames[4]!.counters.structure_rebuilds).toBe(1);
  expect(result.specialized.frames[4]!.counters.shaping_calls).toBe(0);
  // Removing and inserting a card keeps damage local after the first frame.
  for (const frame of [7, 9]) {
    expect(result.specialized.frames[frame]!.counters.damage_full_redraws).toBe(0);
    expect(result.specialized.frames[frame]!.counters.damage_area).toBeLessThan(480 * 272);
  }
  expect(result.generatedLines.on).toBeGreaterThan(0);
}, 180_000);

test("one sensor value update damages only its fixed card", async () => {
  const result = await executeSpecialization("sensor-list", { tape: [{}, { buttons: 8 }, {}] });
  const frame = result.specialized.frames[1]!.counters;
  expect(frame.set_text).toBe(1);
  // Array replacement reconciles the list; card contents remain isolated.
  expect(frame.structure_rebuilds).toBeLessThanOrEqual(1);
  expect(frame.shaping_calls).toBe(0);
  expect(frame.damage_full_redraws).toBe(0);
  expect(frame.damage_area).toBeGreaterThan(0);
  expect(frame.damage_min_x).toBeGreaterThanOrEqual(16);
  expect(frame.damage_min_y).toBeGreaterThanOrEqual(52);
  expect(frame.damage_max_x).toBeLessThanOrEqual(464);
  expect(frame.damage_max_y).toBeLessThanOrEqual(116);
}, 180_000);

test("private field bindings remain live across input, set_props and invalidate", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization", `private-field-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, model: "compiled", entry: "App.tsx" } }));
  await writeFile(resolve(directory, "App.ts"), `import type {i32} from "@pocketjs/framework/solid/std";
let count:i32=0; export function read():i32{return count;} export function press():void{count+=1; console.log(count);}`);
  await writeFile(resolve(directory, "App.tsx"), `import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";
import {BTN} from "@pocketjs/framework/input"; import {read,press} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={press}/><Text>{read()}</Text><View style={{width:5+7,height:8}}/></View>}`);
  const result = await executeSpecialization(directory, { tape: [{ buttons: 16384 }, { buttons: 0, set_props: true }, { buttons: 16384 }, { buttons: 0, invalidate: true }] });
  expect(result.specialized.frames[0]!.commands).toEqual(['Log("1")']);
  expect(result.specialized.frames[2]!.commands).toEqual(['Log("2")']);
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBeGreaterThan(0);
}, 180_000);

test("handwritten model receives first-frame input before a Build display write", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization", `first-input-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "vue-vapor", aot: true, entry: "App.vue" } }));
  await writeFile(resolve(directory, "App.ts"), `import type {i32} from "@pocketjs/framework/vue-vapor/std";
export declare function press():void; export declare const count:i32;`);
  await writeFile(resolve(directory, "App.vue"), `<script setup lang="ts">
import {View,Text} from "@pocketjs/framework/vue-vapor/components"; import {press,count} from "./App";
</script><template><View><View v-show="false" focusable @press="press()"/><Text>{{count}}</Text></View></template>`);
  const result = await executeSpecialization(directory, {
    modelSource: `#[derive(Default)] struct Model { count:i32 }
impl AppViewModel for Model { fn press(&mut self) { self.count += 1; } fn count(&self)->i32 { self.count } }`,
    modelExpression: "Model::default()",
    tape: [{ buttons: 0x0040 | 0x2000 }, { buttons: 0, invalidate: true }, { buttons: 0, set_props: true }],
  });
  expect(JSON.stringify(result.specialized.frames[0])).toContain('"text":"1"');
}, 180_000);

test("specialization CLI keeps IR identical and rejects invalid option values", async () => {
  const run = resolve(".pocket-build/validation/microts-specialization", `cli-${process.pid}`);
  for (const specialize of ["off", "on"] as const) {
    await buildAot("sensor-list", { specialize, outDir: resolve(run, specialize), ir: resolve(run, `${specialize}.json`), format: false });
  }
  expect(await readFile(resolve(run, "on.json"), "utf8")).toBe(await readFile(resolve(run, "off.json"), "utf8"));
  expect(await readFile(resolve(run, "on.model.json"), "utf8")).toBe(await readFile(resolve(run, "off.model.json"), "utf8"));
  const report = Bun.spawn([process.execPath, "microts/compiler/cli.ts", "check", "sensor-list", "--report", "specialization", "--json", "--strict"], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([report.exited, new Response(report.stdout).text(), new Response(report.stderr).text()]);
  expect(status, stderr).toBe(0);
  expect(JSON.parse(stdout).version).toBe(1);
  expect(stderr).toMatch(/warning VS10[12]/);
  for (const args of [["--specialize", "sometimes"], ["--specialize"], ["--report", "unknown"]]) {
    const result = Bun.spawnSync([process.execPath, "microts/compiler/cli.ts", "check", "sensor-list", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
  }
}, 30_000);

async function animationFixture(name: string, model: string, view: string): Promise<string> {
  const directory = resolve(".pocket-build/validation/microts-specialization", `${name}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, model: "compiled", entry: "App.tsx" } }));
  await writeFile(resolve(directory, "App.ts"), model);
  await writeFile(resolve(directory, "App.tsx"), view);
  return directory;
}

// These fixtures draw one untransformed, unclipped solid box. Decode its
// public draw words to prove that intermediate animation frames are exercised.
function animatedBox(words: number[]) {
  expect(words).toHaveLength(4);
  expect(words[0]).toBe(DRAW_OP.rect);
  return { width: words[2]! & 0xffff, height: words[2]! >>> 16, color: words[3]! };
}

test("a Build style binding keeps its first transition at update time", async () => {
  const directory = await animationFixture("build-style-transition", `export function unused():void{}`, `import {View} from "@pocketjs/framework/solid/components"; import {unused} from "./App";
export default function App(){return <View class={true?"w-[10] h-[10] shrink-0 bg-red-500 transition-all duration-100 ease-linear":"w-[40] h-[10] shrink-0 bg-blue-500"}/>}`);
  const result = await executeSpecialization(directory, { specializationTarget: "host", tape: Array.from({ length: 8 }, () => ({})) });
  const boxes = result.specialized.frames.map(frame => animatedBox(frame.words));
  expect(boxes[0]!.width).toBe(10);
  expect(boxes[0]!.color >>> 24).toBeGreaterThan(0);
  expect(boxes[0]!.color >>> 24).toBeLessThan(255);
  expect(boxes[7]!.color >>> 24).toBe(255);
  expect(result.specialized.frames.slice(1).every(frame => frame.counters.set_style === 0)).toBe(true);
}, 180_000);

test("first dynamic style preserves mount initialization and layout/paint transitions", async () => {
  const directory = await animationFixture("style-transitions", `import {createSignal} from "solid-js";
export const [expanded,setExpanded]=createSignal(false);
export function toggle():void{setExpanded(!expanded());}`, `import {View,ActionHandler} from "@pocketjs/framework/solid/components";
import {BTN} from "@pocketjs/framework/input"; import {expanded,toggle} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={toggle}/>
<View class={expanded()?"w-[40] h-[10] shrink-0 bg-blue-500 transition-all duration-100 ease-linear":"w-[10] h-[10] shrink-0 bg-red-500 transition-all duration-100 ease-linear"}/></View>}`);
  const result = await executeSpecialization(directory, { specializationTarget: "host", tape: Array.from({ length: 16 }, (_, i) => ({ buttons: i === 8 ? 16384 : 0 })) });
  const boxes = result.specialized.frames.map(frame => animatedBox(frame.words));
  // The admitted class binding mounts STYLE_ID_NONE before its first update.
  // The first record must transition from transparent; moving it into mount
  // would skip that transition. Auto width, however, snaps to the first width.
  expect(boxes[0]!.width).toBe(10);
  expect(boxes[0]!.color >>> 24).toBeGreaterThan(0);
  expect(boxes[0]!.color >>> 24).toBeLessThan(255);
  expect(boxes[7]!.color >>> 24).toBe(255);
  expect(boxes[8]!.width).toBeGreaterThan(10);
  expect(boxes[8]!.width).toBeLessThan(40);
  expect(boxes[8]!.color).not.toBe(boxes[7]!.color);
  expect(boxes[8]!.color).not.toBe(boxes[15]!.color);
  expect(boxes[15]!.width).toBe(40);
  expect(result.specialized.frames[8]!.counters.style_updates).toBeGreaterThan(0);
}, 180_000);

test("layout and paint timelines retain intermediate frames and forward fill", async () => {
  const directory = await animationFixture("style-timelines", `export function unused():void{}`, `import {View} from "@pocketjs/framework/solid/components"; import {unused} from "./App";
export default function App(){return <View class="w-[10] h-[10] shrink-0 bg-red-500 animate-specialization-test"/>}`);
  registerAnimationTheme({ keyframes: { "specialization-test": { from: { width: 10, backgroundColor: "#ff0000" }, to: { width: 40, backgroundColor: "#0000ff" } } }, animation: { "specialization-test": "specialization-test 100ms linear forwards" } });
  try {
    const result = await executeSpecialization(directory, { specializationTarget: "host", tape: Array.from({ length: 10 }, () => ({})) });
    expect(result.program.styles.anims[0]!.tracks.map(track => track.prop).sort((a, b) => a - b)).toEqual([PROP.width, PROP.bgColor].sort((a, b) => a - b));
    const boxes = result.specialized.frames.map(frame => animatedBox(frame.words));
    expect(boxes[0]).toEqual({ width: 10, height: 10, color: 0xff0000ff });
    expect(boxes[1]!.width).toBeGreaterThan(10);
    expect(boxes[1]!.width).toBeLessThan(40);
    expect(boxes[2]!.width).toBeGreaterThan(boxes[0]!.width);
    expect(boxes[2]!.color).not.toBe(boxes[0]!.color);
    expect(boxes[9]).toEqual({ width: 40, height: 10, color: 0xffff0000 });
    expect(boxes[8]).toEqual(boxes[9]);
    expect(result.specialized.frames[2]!.counters.style_updates).toBeGreaterThan(0);
  } finally { registerAnimationTheme(undefined); }
}, 180_000);

test("model ref Animate and Jump keep geometry, paint and completion ordering", async () => {
  const directory = await animationFixture("ref-animation", `import {createNodeRef,animate,jump} from "@pocketjs/framework/animation";
import type {u32} from "@pocketjs/framework/solid/std";
export const bar=createNodeRef();
export async function run():Promise<void>{const result=await animate(bar,"width",40,{dur:100 as u32,easing:"linear"});console.log(result);}
export function replace():void{jump(bar,"width",25);jump(bar,"bgColor","#010203");}`, `import {View,ActionHandler} from "@pocketjs/framework/solid/components";
import {BTN} from "@pocketjs/framework/input"; import {bar,run,replace} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={run}/><ActionHandler button={BTN.SQUARE} onPress={replace}/>
<View ref={bar} class="w-[10] h-[10] shrink-0 bg-red-500"/></View>}`);
  const result = await executeSpecialization(directory, { specializationTarget: "host", tape: Array.from({ length: 14 }, (_, i) => ({ buttons: i === 1 || i === 6 ? 16384 : i === 3 ? 32768 : 0 })) });
  const boxes = result.specialized.frames.map(frame => animatedBox(frame.words));
  expect(boxes[0]!.width).toBe(10);
  expect(boxes[1]!.width).toBeGreaterThan(10);
  expect(boxes[1]!.width).toBeLessThan(40);
  expect(boxes[3]).toEqual({ width: 25, height: 10, color: 0xff030201 });
  expect(boxes[13]).toEqual({ width: 40, height: 10, color: 0xff030201 });
  const commands = result.specialized.frames.flatMap(frame => frame.commands);
  expect(commands.filter(command => typeof command === "object" && command !== null && "kind" in command).map(command => (command as {kind: string}).kind)).toEqual(["animate", "jump", "jump", "animate"]);
  expect(commands.filter(command => typeof command === "string")).toEqual(['Log("replaced")', 'Log("ended")']);
  expect(result.specialized.frames[3]!.counters.style_updates).toBeGreaterThan(0);
}, 180_000);
