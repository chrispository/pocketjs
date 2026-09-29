// Model dependency masks. A specialized update re-evaluates only the bindings
// whose model reads changed; inputs the Ledger cannot see (private fields,
// task resumption, handwritten models) re-evaluate every binding.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import { buildAot } from "../microts/compiler/aot-build.ts";
import { dependencyWords } from "../microts/compiler/aot-view-deps.ts";
import { OUT, perFrame, runApp, runCrate, treeTexts, writeApp, type Mode } from "./helpers/microts-specialization.ts";

const CROSS = { buttons: BTN.CROSS }, CIRCLE = { buttons: BTN.CIRCLE };
const evaluations = (mode: Mode) => perFrame(mode, "memo_evaluations");

const vueView = (imports: string[], template: string) => `<script setup lang="ts">import {View,Text,ActionHandler} from "@pocketjs/framework/vue-vapor/components";
import {BTN} from "@pocketjs/framework/vue-vapor/input"; import {${imports.join(",")}} from "./App";</script><template><View>${template}</View></template>`;

/** A Vue app with a compiled model; the template can use every model export. */
function vueApp(model: string, template: string) {
  const exports = [...model.matchAll(/export (?:const|(?:async )?function) (\w+)/g)].map(match => match[1]!);
  return {
    "App.ts": `import {ref,computed} from "vue"; import {imod,frames,type i32} from "@pocketjs/framework/vue-vapor/std";\n${model}`,
    "App.vue": vueView(exports, template),
  };
}

const TWO_SIGNALS = `export const left=ref<i32>(0); export const right=ref<i32>(10);
export const parity=computed<i32>(()=>imod(left.value,2));
export function bumpLeft():void{left.value+=2;} export function bumpRight():void{right.value+=1;}`;

test("a signal change re-evaluates only the bindings that read it", async () => {
  const run = await runApp("signals", vueApp(`${TWO_SIGNALS} export function readLeft():i32{return left.value;}`,
    `<ActionHandler :button="BTN.CROSS" @press="bumpLeft()"/><ActionHandler :button="BTN.CIRCLE" @press="bumpRight()"/>
<Text>{{left}}</Text><Text>{{right}}</Text><Text>{{parity}}</Text><Text>{{readLeft()}}</Text>`),
  { tape: [{}, CROSS, {}, CIRCLE, { set_props: true }, { invalidate: true }] });
  // frames:                                   idle  left+=2  idle  right+=1  set_props  invalidate
  expect(evaluations(run.reference)).toEqual([0, 4, 0, 4, 4, 4]);
  // left+=2 keeps parity at 0, so only `left` and `readLeft()` re-run.
  expect(evaluations(run.specialized)).toEqual([0, 2, 0, 1, 4, 4]);
  expect(run.specialized.frames[1]!.counters.update_at).toBeLessThan(run.reference.frames[1]!.counters.update_at);
}, 180_000);

test("a private field read re-evaluates every binding", async () => {
  const run = await runApp("private-field", vueApp(`let privateValue:i32=0; export const left=ref<i32>(0); export const right=ref<i32>(10);
export function readPrivate():i32{return privateValue;} export function press():void{privateValue+=1;}`,
  `<ActionHandler :button="BTN.CROSS" @press="press()"/><Text>{{left}}</Text><Text>{{right}}</Text><Text>{{readPrivate()}}</Text>`),
  { tape: [{}, CROSS, { invalidate: true }, { set_props: true }] });
  expect(evaluations(run.specialized).slice(1)).toEqual([3, 3, 3]);
  expect(run.specialized.frames[1]!.counters.memo_writes).toBe(1); // only the private field's text changed
}, 180_000);

test("a resumed task re-evaluates every binding", async () => {
  const run = await runApp("task", vueApp(`export const left=ref<i32>(0); export const right=ref<i32>(10);
export async function later():Promise<void>{await frames(1); left.value+=1;}`,
  `<ActionHandler :button="BTN.CROSS" @press="later()"/><Text>{{left}}</Text><Text>{{right}}</Text>`),
  { tape: [{}, CROSS, {}, {}] });
  // CROSS starts the task; it writes `left` when it resumes one frame later.
  expect(evaluations(run.specialized).slice(1, 3)).toEqual([0, 2]);
  expect(run.specialized.frames[2]!.counters.memo_writes).toBe(1);
}, 180_000);

test("masks span 64-bit words without aliasing signal 0 and signal 64", async () => {
  expect(dependencyWords([0, 64, 128])).toEqual([1n, 1n, 1n]);
  const names = Array.from({ length: 65 }, (_, i) => `s${i}`);
  const run = await runApp("wide", vueApp(`${names.map(name => `export const ${name}=ref<i32>(0);`).join("")}
export function bump64():void{s64.value+=1;} export function bump63():void{s63.value+=1;}`,
  `<ActionHandler :button="BTN.CROSS" @press="bump64()"/><ActionHandler :button="BTN.CIRCLE" @press="bump63()"/>${names.map(name => `<Text>{{${name}}}</Text>`).join("")}`),
  { tape: [{}, CROSS, {}, CIRCLE] });
  expect(evaluations(run.reference)[1]).toBe(65);
  expect(evaluations(run.specialized).slice(1)).toEqual([1, 0, 1]);
}, 180_000);

test("a newly mounted factory branch runs its mount hooks before the next update", async () => {
  const model = `import {createSignal} from "solid-js"; import type {i32} from "@pocketjs/framework/solid/std";`;
  const view = `import {Show} from "solid-js"; import {View,Text,ActionHandler} from "@pocketjs/framework/solid/components"; import {onMount} from "@pocketjs/framework/solid/lifecycle";`;
  const run = await runApp("factory-branch", {
    "App.ts": `${model} export const [visible,setVisible]=createSignal(false); export const [left,setLeft]=createSignal<i32>(0); export const [right,setRight]=createSignal<i32>(10);
export function reveal():void{setVisible(true); setLeft(2);}`,
    "App.tsx": `${view} import {BTN} from "@pocketjs/framework/input"; import {visible,left,right,reveal} from "./App"; import Row from "./Row.tsx";
export default function App(){return <View><ActionHandler button={BTN.CROSS} onPress={reveal}/><Text>{left()}</Text><Text>{right()}</Text><Show when={visible()}><Row/></Show></View>;}`,
    // Row mounts with count 3 and its hook sets 7; that reveals Leaf, whose hook sets 9.
    "Row.ts": `${model} export function createRow(){const [count,setCount]=createSignal<i32>(3); const [nested,setNested]=createSignal(false); function load():void{setCount(7); setNested(true);} return {count,nested,load};}`,
    "Row.tsx": `${view} import {createRow} from "./Row"; import Leaf from "./Leaf.tsx";
export default function Row(){const {count,nested,load}=createRow(); onMount(load); return <View><Text>{count()}</Text><Show when={nested()}><Leaf/></Show></View>;}`,
    "Leaf.ts": `${model} export function createLeaf(){const [count,setCount]=createSignal<i32>(4); function load():void{setCount(9);} return {count,load};}`,
    "Leaf.tsx": `${view} import {createLeaf} from "./Leaf"; export default function Leaf(){const {count,load}=createLeaf(); onMount(load); return <Text>{count()}</Text>;}`,
  }, { tape: [{}, CROSS, {}] });
  expect(treeTexts(run.specialized.frames[1]!.tree)).toEqual(expect.arrayContaining(["7", "9"]));
  expect(evaluations(run.specialized)[1]).toBeLessThan(evaluations(run.reference)[1]!);
}, 180_000);

test("a handwritten model re-evaluates every binding", async () => {
  const run = await runApp("handwritten", {
    "App.ts": `import type {i32} from "@pocketjs/framework/vue-vapor/std"; export declare const left:i32; export declare const right:i32; export declare function press():void;`,
    "App.vue": vueView(["left", "right", "press"], `<ActionHandler :button="BTN.CROSS" @press="press()"/><Text>{{left}}</Text><Text>{{right}}</Text>`),
  }, {
    modelSource: `#[derive(Default)] struct Model { left: i32 }
impl AppViewModel for Model { fn left(&self) -> i32 { self.left } fn right(&self) -> i32 { 10 } fn press(&mut self) { self.left += 1; } }`,
    modelExpression: "Model::default()", tape: [{}, CROSS, { invalidate: true }],
  });
  expect(evaluations(run.specialized).slice(1)).toEqual([2, 2]);
}, 180_000);

test("view changes accumulate across react and settle until the next view frame", async () => {
  const app = writeApp("rounds", vueApp(TWO_SIGNALS, `<Text>{{left}}</Text><Text>{{right}}</Text><Text>{{parity}}</Text>`));
  await buildAot(app, { specialize: "on", format: false, outDir: resolve(OUT, "crates/dependency-rounds/src/gen") });
  runCrate("dependency-rounds", { "main.rs": `mod gen; use gen::*;
const LEFT: u64 = 1; const RIGHT: u64 = 2; const PARITY: u64 = 4; // one mask bit per signal or memo
fn main() {
  let (mut model, mut commands) = (AppModel::default(), Vec::new());
  model.begin_view_frame();
  model.bumpLeft(); model.react(false, &mut commands); model.settle();
  assert!(model.view_changed(&[LEFT]) && !model.view_changed(&[RIGHT]) && !model.view_changed(&[PARITY]));
  model.bumpRight(); model.react(false, &mut commands); model.settle();
  assert!(model.view_changed(&[LEFT]) && model.view_changed(&[RIGHT]));
  model.begin_view_frame();
  assert!(!model.view_changed(&[LEFT | RIGHT]));
  model.bumpLeft(); model.settle();
  assert!(model.view_changed(&[LEFT]) && !model.view_changed(&[RIGHT]));
}` }, ["std"]);
}, 180_000);
