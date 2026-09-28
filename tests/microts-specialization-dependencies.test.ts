import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeSpecialization } from "../microts/compiler/specialization-harness.ts";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { dependencyWords } from "../microts/compiler/aot-view-deps.ts";

async function fixture(name: string, model: string, imports: string, template: string) {
  const directory = resolve(".pocket-build/validation/microts-specialization/dependencies", `${name}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "vue-vapor", aot: true, model: "compiled", entry: "App.vue" } }));
  await writeFile(resolve(directory, "App.ts"), `import {ref,computed} from "vue";import {imod,frames,type i32} from "@pocketjs/framework/vue-vapor/std";\n${model}`);
  await writeFile(resolve(directory, "App.vue"), `<script setup lang="ts">import {View,Text,ActionHandler} from "@pocketjs/framework/vue-vapor/components";import {BTN} from "@pocketjs/framework/vue-vapor/input";import {${imports}} from "./App";</script><template><View>${template}</View></template>`);
  return resolve(directory, "App.vue");
}

test("changed bitsets guard independent signals, stable memos and Ledger-read rendering functions", async () => {
  const directory = await fixture("signals", `
export const left=ref<i32>(0);export const right=ref<i32>(10);
export const parity=computed<i32>(()=>imod(left.value,2));
export function readLeft():i32{return left.value;}
export function bumpLeft():void{left.value+=2;}export function bumpRight():void{right.value+=1;}
`, "left,right,parity,readLeft,bumpLeft,bumpRight", `
<ActionHandler :button="BTN.CROSS" @press="bumpLeft()"/><ActionHandler :button="BTN.CIRCLE" @press="bumpRight()"/>
<Text>{{left}}</Text><Text>{{right}}</Text><Text>{{parity}}</Text><Text>{{readLeft()}}</Text>`);
  const result = await executeSpecialization(directory, { tape: [{}, { buttons: 16384 }, {}, { buttons: 8192 }, { set_props: true }, { invalidate: true }] });
  expect(result.reference.frames[1]!.counters.memo_evaluations).toBe(4);
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBe(2);
  expect(result.specialized.frames[3]!.counters.memo_evaluations).toBe(1);
  expect(result.specialized.frames[4]!.counters.memo_evaluations).toBe(4);
  expect(result.specialized.frames[5]!.counters.memo_evaluations).toBe(4);
  expect(result.specialized.frames[1]!.counters.update_at).toBeLessThan(result.reference.frames[1]!.counters.update_at);
}, 180_000);

test("opaque private-field input forces complete evaluation while preserving private field output", async () => {
  const directory = await fixture("opaque", `
let privateValue:i32=0;export const left=ref<i32>(0);export const right=ref<i32>(10);
export function readPrivate():i32{return privateValue;}export function press():void{privateValue+=1;}
`, "left,right,readPrivate,press", `<ActionHandler :button="BTN.CROSS" @press="press()"/><Text>{{left}}</Text><Text>{{right}}</Text><Text>{{readPrivate()}}</Text>`);
  const result = await executeSpecialization(directory, { tape: [{}, { buttons: 16384 }, { invalidate: true }, { set_props: true }] });
  for (const frame of result.specialized.frames.slice(1)) expect(frame.counters.memo_evaluations).toBe(3);
  expect(result.specialized.frames[1]!.counters.memo_writes).toBe(1);
}, 180_000);

test("task resumption forces complete evaluation instead of only the written signal", async () => {
  const directory = await fixture("task", `
export const left=ref<i32>(0);export const right=ref<i32>(10);
export async function later():Promise<void>{await frames(1);left.value+=1;}
`, "left,right,later", `<ActionHandler :button="BTN.CROSS" @press="later()"/><Text>{{left}}</Text><Text>{{right}}</Text>`);
  const result = await executeSpecialization(directory, { tape: [{}, { buttons: 16384 }, {}, {}] });
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBe(0);
  expect(result.specialized.frames[2]!.counters.memo_evaluations).toBe(2);
  expect(result.specialized.frames[2]!.counters.memo_writes).toBe(1);
}, 180_000);

test("dependency masks span multiple words without conflating signal 0 and signal 64", async () => {
  expect(dependencyWords([0, 64, 128])).toEqual([1n, 1n, 1n]);
  const names = Array.from({ length: 65 }, (_, i) => `s${i}`);
  const directory = await fixture("wide", `${names.map(name => `export const ${name}=ref<i32>(0);`).join("")}export function press():void{s64.value+=1;}export function high():void{s63.value+=1;}`, [...names, "press", "high"].join(","), `<ActionHandler :button="BTN.CROSS" @press="press()"/><ActionHandler :button="BTN.CIRCLE" @press="high()"/>${names.map(name => `<Text>{{${name}}}</Text>`).join("")}`);
  const result = await executeSpecialization(directory, { tape: [{}, { buttons: 16384 }, {}, { buttons: 8192 }] });
  expect(result.reference.frames[1]!.counters.memo_evaluations).toBe(65);
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBe(1);
  expect(result.specialized.frames[3]!.counters.memo_evaluations).toBe(1);
}, 180_000);

test("new factory branches initialize fully and accumulate changes through lifecycle rounds", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization/dependencies", `hooks-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, model: "compiled", entry: "App.tsx" } }));
  const files = {
    "App.ts": `import {createSignal} from "solid-js";import type {i32} from "@pocketjs/framework/solid/std";
export const [visible,setVisible]=createSignal(false);export const [left,setLeft]=createSignal<i32>(0);export const [right,setRight]=createSignal<i32>(10);
export function reveal():void{setVisible(true);setLeft(2);}`,
    "App.tsx": `import {Show} from "solid-js";import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components";import {BTN} from "@pocketjs/framework/input";
import {visible,left,right,reveal} from "./App";import Row from "./Row.tsx";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={reveal}/><Text>{left()}</Text><Text>{right()}</Text><Show when={visible()}><Row/></Show></View>;}`,
    "Row.ts": `import {createSignal} from "solid-js";import type {i32} from "@pocketjs/framework/solid/std";
export function createRow(){const [count,setCount]=createSignal<i32>(3);const [nested,setNested]=createSignal(false);function load():void{setCount(7);setNested(true);}return {count,nested,load};}`,
    "Row.tsx": `import {Show} from "solid-js";import {Text,View} from "@pocketjs/framework/solid/components";import {onMount} from "@pocketjs/framework/solid/lifecycle";
import {createRow} from "./Row";import Leaf from "./Leaf.tsx";
export default function Row(){const {count,nested,load}=createRow();onMount(load);return <View><Text>{count()}</Text><Show when={nested()}><Leaf/></Show></View>;}`,
    "Leaf.ts": `import {createSignal} from "solid-js";import type {i32} from "@pocketjs/framework/solid/std";
export function createLeaf(){const [count,setCount]=createSignal<i32>(4);function load():void{setCount(9);}return {count,load};}`,
    "Leaf.tsx": `import {Text} from "@pocketjs/framework/solid/components";import {onMount} from "@pocketjs/framework/solid/lifecycle";import {createLeaf} from "./Leaf";
export default function Leaf(){const {count,load}=createLeaf();onMount(load);return <Text>{count()}</Text>;}`,
  };
  for (const [name, source] of Object.entries(files)) await writeFile(resolve(directory, name), source);
  const result = await executeSpecialization(directory, { tape: [{}, { buttons: 16384 }, {}] });
  expect(JSON.stringify(result.specialized.frames[1]!.tree)).toContain('"text":"7"');
  expect(JSON.stringify(result.specialized.frames[1]!.tree)).toContain('"text":"9"');
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBeLessThan(result.reference.frames[1]!.counters.memo_evaluations);
}, 180_000);

test("handwritten model vm bindings retain whole-view evaluation", async () => {
  const directory = resolve(".pocket-build/validation/microts-specialization/dependencies", `manual-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "vue-vapor", aot: true, entry: "App.vue" } }));
  await writeFile(resolve(directory, "App.ts"), `import type {i32} from "@pocketjs/framework/vue-vapor/std";export declare const left:i32;export declare const right:i32;export declare function press():void;`);
  await writeFile(resolve(directory, "App.vue"), `<script setup lang="ts">import {View,Text,ActionHandler} from "@pocketjs/framework/vue-vapor/components";import {BTN} from "@pocketjs/framework/vue-vapor/input";import {left,right,press} from "./App";</script><template><View><ActionHandler :button="BTN.CROSS" @press="press()"/><Text>{{left}}</Text><Text>{{right}}</Text></View></template>`);
  const result = await executeSpecialization(directory, {
    modelSource: `#[derive(Default)] struct Model{left:i32} impl AppViewModel for Model{fn left(&self)->i32{self.left} fn right(&self)->i32{10} fn press(&mut self){self.left+=1;}}`,
    modelExpression: "Model::default()", tape: [{}, { buttons: 16384 }, { invalidate: true }],
  });
  expect(result.specialized.frames[1]!.counters.memo_evaluations).toBe(2);
  expect(result.specialized.frames[2]!.counters.memo_evaluations).toBe(2);
}, 180_000);


test("model view changes survive react and settle resets until the next frame", async () => {
  const entry = await fixture("rounds", `export const left=ref<i32>(0);export const right=ref<i32>(0);export const parity=computed<i32>(()=>imod(left.value,2));export function bumpLeft():void{left.value+=2;}export function bumpRight():void{right.value+=1;}`, "left,right,parity,bumpLeft,bumpRight", `<Text>{{left}}</Text><Text>{{right}}</Text><Text>{{parity}}</Text>`);
  const directory = resolve(".pocket-build/validation/microts-specialization/dependencies", `rounds-native-${process.pid}`);
  await buildAot(entry, { specialize: "on", format: false, outDir: resolve(directory, "src/gen") });
  await writeFile(resolve(directory, "Cargo.toml"), `[package]\nname="dependency-rounds"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\n`);
  await writeFile(resolve(directory, "src/main.rs"), `mod gen; use gen::*;
fn main(){let mut model=AppModel::default();let mut commands=Vec::new();
model.begin_view_frame();model.bumpLeft();model.react(false,&mut commands);model.settle();
assert!(model.view_changed(&[1]));assert!(!model.view_changed(&[2]));assert!(!model.view_changed(&[4]));
model.bumpRight();model.react(false,&mut commands);model.settle();
assert!(model.view_changed(&[1]));assert!(model.view_changed(&[2]));
model.begin_view_frame();assert!(!model.view_changed(&[3]));
model.bumpLeft();model.settle();assert!(model.view_changed(&[1]));assert!(!model.view_changed(&[2]));
}`);
  const child = Bun.spawn(["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/microts-specialization/target") } });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  await writeFile(resolve(directory, "native.log"), stderr);
  expect(status, stderr).toBe(0);
}, 180_000);
