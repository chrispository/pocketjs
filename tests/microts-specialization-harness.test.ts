// End-to-end runs through the native oracle. Every run already rejects any
// difference between the reference and specialized builds (draw words,
// pixels, tree, hits, focus, commands, glyph misses); these tests add
// expectations about behavior and the work each frame does.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BTN, DRAW_OP, PROP } from "../contracts/spec/spec.ts";
import { registerAnimationTheme } from "../framework/compiler/animation.ts";
import { executeSpecialization } from "../microts/compiler/specialization-harness.ts";
import { frames, perFrame, runApp, total, treeNodes, treeTexts, type Run } from "./helpers/microts-specialization.ts";

const CROSS = { buttons: BTN.CROSS }, CIRCLE = { buttons: BTN.CIRCLE }, SQUARE = { buttons: BTN.SQUARE };

// Frame numbers index tests/tapes/settings-specialization.tape.json. Frames
// 0-99 replay settings-main's golden input; later frames press every
// brightness level and theme, resize the viewport, then force set_props and
// invalidate. Touch frames (0, 26, 90, 196, 200) hit-test every control.
const SETTINGS = {
  focusMoves: [4, 16, 28, 40, 44, 48], // DOWN; focus walks the first six controls
  touches: [26, 90, 196, 200],
  switches: [[10, 0.5], [22, 15.5]], // CIRCLE on a switch: [frame, knob x]
  brightness: [[34, 4], [100, 5], [112, 1], [124, 2], [136, 3], [198, 4]], // [frame, level]
  themes: [[54, 2], [148, 0], [160, 1], [172, 3], [184, 2]], // [frame, swatch]
  resizes: [196, 200],
  forcedUpdates: [202, 204],
} as const;

test("settings renders identically through real interactions, and each step does only its own work", async () => {
  const tape = JSON.parse(await readFile(resolve("tests/tapes/settings-specialization.tape.json"), "utf8"));
  const run = await executeSpecialization("settings", { tape });
  const observed = run.specialized.frames;
  expect(observed).toHaveLength(tape.frames.length);
  const work = (frame: number) => observed[frame]!.counters;
  // Frame 0 touches each control: two switches, the brightness row and four theme swatches.
  const controls = observed[0]!.hits;
  expect(new Set(controls).size).toBe(7);
  expect(controls).not.toContain("$none");
  const themes = controls.slice(3);

  expect(SETTINGS.focusMoves.map(frame => observed[frame]!.focused)).toEqual(controls.slice(0, 6));
  for (const frame of SETTINGS.touches) expect(observed[frame]!.hits).toEqual(controls);

  // A switch slides its knob; nothing is laid out, shaped or fully redrawn.
  for (const [frame, knobX] of SETTINGS.switches) {
    expect(observed[frame]!.commands).toEqual([expect.objectContaining({ kind: "animate", prop: PROP.translateX, to: knobX, dur: 160 })]);
    expect(work(frame)).toMatchObject({ layout_passes: 0, shaping_calls: 0, damage_full_redraws: 0 });
    expect(work(frame).damage_area).toBeGreaterThan(0);
    expect(work(frame).damage_area).toBeLessThan(480 * 272);
  }

  // A brightness change rewrites one label and animates the bar and its thumb.
  expect(treeTexts(observed[0]!.tree)).toContain("3/5");
  for (const [frame, level] of SETTINGS.brightness) {
    expect(treeTexts(observed[frame]!.tree)).toContain(`${level}/5`);
    expect(observed[frame]!.commands).toEqual([
      expect.objectContaining({ kind: "animate", prop: PROP.scaleX, to: level / 5, dur: 150 }),
      expect.anything(),
      expect.objectContaining({ kind: "animate", prop: PROP.translateX, to: level * 24 - 8, dur: 150 }),
    ]);
    expect(work(frame)).toMatchObject({ set_text: 1, shaping_calls: 1 });
  }

  // A theme selection moves the check mark (a Show) to another swatch.
  const checked = (frame: number) => treeNodes(observed[frame]!.tree).filter(node => themes.includes(node.node) && node.children.length > 0).map(node => node.node);
  expect(checked(0)).toEqual([themes[0]]);
  for (const [frame, swatch] of SETTINGS.themes) {
    expect(checked(frame)).toEqual([themes[swatch]]);
    expect(work(frame)).toMatchObject({ nodes_created: 1, nodes_destroyed: 1, structure_syncs: 1, shaping_calls: 0 });
  }

  for (const frame of SETTINGS.resizes) expect(work(frame)).toMatchObject({ layout_passes: 1, damage_full_redraws: 1 });
  for (const frame of SETTINGS.forcedUpdates) expect(work(frame).memo_evaluations).toBeGreaterThan(0);
  // Show swaps and resizes synchronize the one layout tree built at startup.
  expect([total(run.reference, "structure_rebuilds"), total(run.specialized, "structure_rebuilds")]).toEqual([1, 1]);
  for (const counter of ["memo_evaluations", "update_at"]) expect(total(run.specialized, counter)).toBeLessThan(total(run.reference, counter));
}, 180_000);

test("keyed reorders and empty text keep node identities and the layout tree", async () => {
  const run = await runApp("keyed-layout", {
    "App.ts": `import {createSignal} from "solid-js"; import {map,len,type i32} from "@pocketjs/framework/solid/std";
export interface Row { id:i32; label:string }
export const [rows,setRows]=createSignal<Row[]>([{id:1,label:"A"},{id:2,label:"B"},{id:3,label:"C"}]);
export const [status,setStatus]=createSignal("");
export function reverse():void{setRows(map(rows(),(row,index)=>rows()[len(rows())-index-1]));}
export function toggleText():void{setStatus(status()===""?"ready":"");}
export function resize():void{if(len(rows())===3)setRows([rows()[0],rows()[1]]);else setRows([rows()[0],rows()[1],{id:4,label:"D"}]);}`,
    "App.tsx": `import {View,Text,For,ActionHandler} from "@pocketjs/framework/solid/components"; import {BTN} from "@pocketjs/framework/input";
import {rows,status,reverse,toggleText,resize} from "./App";
export default function App(){return <View class="flex-col"><ActionHandler button={BTN.CROSS} onPress={reverse}/><ActionHandler button={BTN.SQUARE} onPress={toggleText}/><ActionHandler button={BTN.CIRCLE} onPress={resize}/>
<Text>{status()}</Text><For each={rows()} by={(row)=>row.id}>{(row)=><View class="flex-row"><Text>{row().label}</Text></View>}</For></View>}`,
  }, { tape: frames(11, { 1: CROSS, 3: SQUARE, 5: CIRCLE, 7: CIRCLE, 9: SQUARE }) });
  // CROSS reverses the rows, SQUARE toggles the status text, CIRCLE drops the third row or appends D.
  const nodes = (frame: number) => treeNodes(run.specialized.frames[frame]!.tree);
  const labels = (frame: number) => nodes(frame).map(node => node.text).filter(text => /^[A-D]$/.test(text));
  expect([0, 1, 5, 7].map(labels)).toEqual([["A", "B", "C"], ["C", "B", "A"], ["C", "B"], ["C", "B", "D"]]);
  const identity = (frame: number, label: string) => nodes(frame).find(node => node.text === label)!.node;
  for (const label of ["B", "C"]) expect([1, 3, 5, 7, 9].map(frame => identity(frame, label))).toEqual(Array(5).fill(identity(0, label)));
  expect(treeTexts(run.specialized.frames[3]!.tree)).toContain("ready");
  expect(treeTexts(run.specialized.frames[9]!.tree)).not.toContain("ready");
  const work = (frame: number) => run.specialized.frames[frame]!.counters;
  expect(work(1)).toMatchObject({ nodes_created: 0, nodes_destroyed: 0 }); // a reverse only moves nodes
  expect(work(5).nodes_destroyed).toBeGreaterThan(0);
  expect(work(7).nodes_created).toBeGreaterThan(0);
  expect([total(run.reference, "structure_rebuilds"), total(run.specialized, "structure_rebuilds")]).toEqual([1, 1]);
}, 180_000);

test("a private field binding stays live across input, set_props and invalidate", async () => {
  const run = await runApp("private-field-log", {
    "App.ts": `import type {i32} from "@pocketjs/framework/solid/std";
let count:i32=0; export function read():i32{return count;} export function press():void{count+=1; console.log(count);}`,
    "App.tsx": `import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components"; import {BTN} from "@pocketjs/framework/input"; import {read,press} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={press}/><Text>{read()}</Text><View style={{width:5+7,height:8}}/></View>}`,
  }, { tape: [CROSS, { set_props: true }, CROSS, { invalidate: true }] });
  expect(run.specialized.frames.map(frame => frame.commands)).toEqual([['Log("1")'], [], ['Log("2")'], []]);
  expect(run.specialized.frames[1]!.counters.memo_evaluations).toBeGreaterThan(0);
}, 180_000);

test("a handwritten model receives first-frame input before a Build display write", async () => {
  const run = await runApp("first-input", {
    "App.ts": `import type {i32} from "@pocketjs/framework/vue-vapor/std"; export declare function press():void; export declare const count:i32;`,
    "App.vue": `<script setup lang="ts">import {View,Text} from "@pocketjs/framework/vue-vapor/components"; import {press,count} from "./App";</script>
<template><View><View v-show="false" focusable @press="press()"/><Text>{{count}}</Text></View></template>`,
  }, {
    modelSource: `#[derive(Default)] struct Model { count: i32 }
impl AppViewModel for Model { fn press(&mut self) { self.count += 1; } fn count(&self) -> i32 { self.count } }`,
    modelExpression: "Model::default()",
    tape: [{ buttons: BTN.DOWN | BTN.CIRCLE }, { invalidate: true }, { set_props: true }],
  });
  // DOWN focuses the hidden View and CIRCLE presses it within the first frame.
  expect(treeTexts(run.specialized.frames[0]!.tree)).toContain("1");
}, 180_000);

test("the CLI prints the specialization report as JSON and rejects invalid options", () => {
  const check = (...args: string[]) => Bun.spawnSync([process.execPath, "microts/compiler/cli.ts", "check", "settings", ...args], { stdout: "pipe", stderr: "pipe" });
  const report = check("--report", "specialization", "--json", "--strict");
  expect(report.exitCode, report.stderr.toString()).toBe(0);
  expect(JSON.parse(report.stdout.toString()).version).toBe(1);
  expect(report.stderr.toString()).toMatch(/warning VS10[12]/); // auto width or default shrink blocks a region
  for (const args of [["--specialize", "sometimes"], ["--specialize"], ["--report", "unknown"]]) expect(check(...args).exitCode).not.toBe(0);
}, 30_000);

/** The one untransformed box these apps draw, decoded from its RECT words. Colors are ABGR. */
function boxes(run: Run) {
  return run.specialized.frames.map(({ words }) => {
    expect(words).toHaveLength(4);
    expect(words[0]).toBe(DRAW_OP.rect);
    return { width: words[2]! & 0xffff, height: words[2]! >>> 16, color: words[3]! };
  });
}
const alpha = (color: number) => color >>> 24;

test("a Build class still transitions from its mount state in the first update", async () => {
  const run = await runApp("build-style-transition", { "App.tsx": `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View class={true?"w-[10] h-[10] shrink-0 bg-red-500 transition-all duration-100 ease-linear":"w-[40] h-[10] shrink-0 bg-blue-500"}/>}` },
  { specializationTarget: "host", tape: frames(8) });
  const box = boxes(run);
  // The first update applies the class, so the fill fades in from transparent.
  expect(box[0]!.width).toBe(10);
  expect(alpha(box[0]!.color)).toBeGreaterThan(0);
  expect(alpha(box[0]!.color)).toBeLessThan(255);
  expect(alpha(box[7]!.color)).toBe(255);
  expect(perFrame(run.specialized, "set_style").slice(1)).toEqual(Array(7).fill(0));
}, 180_000);

test("a dynamic class transitions from mount, then transitions layout and paint on change", async () => {
  const transition = "shrink-0 transition-all duration-100 ease-linear";
  const run = await runApp("style-transitions", {
    "App.ts": `import {createSignal} from "solid-js"; export const [expanded,setExpanded]=createSignal(false); export function toggle():void{setExpanded(!expanded());}`,
    "App.tsx": `import {View,ActionHandler} from "@pocketjs/framework/solid/components"; import {BTN} from "@pocketjs/framework/input"; import {expanded,toggle} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={toggle}/>
<View class={expanded()?"w-[40] h-[10] bg-blue-500 ${transition}":"w-[10] h-[10] bg-red-500 ${transition}"}/></View>}`,
  }, { specializationTarget: "host", tape: frames(16, { 8: CROSS }) });
  const box = boxes(run);
  // The fill fades in from transparent; the width was auto at mount, so it snaps to 10.
  expect(box[0]!.width).toBe(10);
  expect(alpha(box[0]!.color)).toBeGreaterThan(0);
  expect(alpha(box[0]!.color)).toBeLessThan(255);
  expect(alpha(box[7]!.color)).toBe(255);
  // CROSS at frame 8 expands the box; width and fill are mid-transition.
  expect(box[8]!.width).toBeGreaterThan(10);
  expect(box[8]!.width).toBeLessThan(40);
  expect([box[7]!.color, box[15]!.color]).not.toContain(box[8]!.color);
  expect(box[15]!.width).toBe(40);
  expect(run.specialized.frames[8]!.counters.style_updates).toBeGreaterThan(0);
}, 180_000);

test("layout and paint keyframes update every frame and fill forwards", async () => {
  registerAnimationTheme({
    keyframes: { "specialization-test": { from: { width: 10, backgroundColor: "#ff0000" }, to: { width: 40, backgroundColor: "#0000ff" } } },
    animation: { "specialization-test": "specialization-test 100ms linear forwards" },
  });
  try {
    const run = await runApp("style-timelines", { "App.tsx": `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View class="w-[10] h-[10] shrink-0 bg-red-500 animate-specialization-test"/>}` },
    { specializationTarget: "host", tape: frames(10) });
    expect(run.program.styles.anims[0]!.tracks.map(track => track.prop).sort((a, b) => a - b)).toEqual([PROP.width, PROP.bgColor].sort((a, b) => a - b));
    const box = boxes(run);
    expect(box[0]).toEqual({ width: 10, height: 10, color: 0xff0000ff }); // red
    expect(box[1]!.width).toBeGreaterThan(10);
    expect(box[1]!.width).toBeLessThan(40);
    expect(box[2]!.color).not.toBe(box[0]!.color);
    expect(box[8]).toEqual({ width: 40, height: 10, color: 0xffff0000 }); // blue, held by `forwards`
    expect(box[9]).toEqual(box[8]);
    expect(run.specialized.frames[2]!.counters.style_updates).toBeGreaterThan(0);
  } finally {
    registerAnimationTheme(undefined);
  }
}, 180_000);

test("ref animate and jump keep geometry, paint and completion order", async () => {
  const run = await runApp("ref-animation", {
    "App.ts": `import {createNodeRef,animate,jump} from "@pocketjs/framework/animation"; import type {u32} from "@pocketjs/framework/solid/std";
export const bar=createNodeRef();
export async function run():Promise<void>{const result=await animate(bar,"width",40,{dur:100 as u32,easing:"linear"}); console.log(result);}
export function replace():void{jump(bar,"width",25); jump(bar,"bgColor","#010203");}`,
    "App.tsx": `import {View,ActionHandler} from "@pocketjs/framework/solid/components"; import {BTN} from "@pocketjs/framework/input"; import {bar,run,replace} from "./App";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={run}/><ActionHandler button={BTN.SQUARE} onPress={replace}/>
<View ref={bar} class="w-[10] h-[10] shrink-0 bg-red-500"/></View>}`,
  }, { specializationTarget: "host", tape: frames(14, { 1: CROSS, 3: SQUARE, 6: CROSS }) });
  // CROSS animates the width to 40; SQUARE jumps width and color, which ends
  // that animation as "replaced"; the second CROSS animates to the end.
  const box = boxes(run);
  expect(box[0]!.width).toBe(10);
  expect(box[1]!.width).toBeGreaterThan(10);
  expect(box[1]!.width).toBeLessThan(40);
  expect(box[3]).toEqual({ width: 25, height: 10, color: 0xff030201 });
  expect(box[13]).toEqual({ width: 40, height: 10, color: 0xff030201 });
  const commands = run.specialized.frames.flatMap(frame => frame.commands).map(command => typeof command === "string" ? command : (command as { kind: string }).kind);
  expect(commands).toEqual(["animate", "jump", "jump", 'Log("replaced")', "animate", 'Log("ended")']);
  expect(run.specialized.frames[3]!.counters.style_updates).toBeGreaterThan(0);
}, 180_000);
