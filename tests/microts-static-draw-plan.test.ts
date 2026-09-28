import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { executeSpecialization } from "../microts/compiler/specialization-harness.ts";
import { resolve } from "node:path";
import { DRAW_OP } from "../contracts/spec/spec.ts";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";
import { analyzeAotSpecialization } from "../microts/compiler/aot-specialization.ts";
import { createStaticDrawPlans, normalizeStaticDrawWords, staticDrawPlanAst, staticPaintFallback, type AotStaticDrawPlan, type StaticDrawSnapshot } from "../microts/compiler/aot-static-draw-plan.ts";
import { printRust } from "../microts/compiler/rust-printer.ts";
import { rl, rt } from "../microts/compiler/rust-ast.ts";

const xy = (x: number, y: number) => ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
const options = { viewport: [100, 80] as const };

test("static draw relocation is reversible and computes clip-bounded glyph damage", () => {
  const atlas = new Uint8Array(16); atlas[6] = 8; atlas[8] = 5; atlas[9] = 8; atlas[12] = 0;
  const words = [DRAW_OP.scissor, xy(10, 20), xy(15, 12), DRAW_OP.rect, xy(12, 22), xy(6, 5), 0xff123456,
    DRAW_OP.glyphRun, 1 << 16, 0xffffffff, xy(23, 28), 2, DRAW_OP.scissorPop];
  const plan = normalizeStaticDrawWords(words, [10, 20], { ...options, fontAtlases: [{ slot: 0, bytes: atlas }] });
  expect(plan.coordinates).toEqual([1, 4, 10]);
  expect(plan.bounds).toEqual([2, 2, 15, 12]);
  const reconstructed = [...plan.words];
  for (const index of plan.coordinates) {
    const value = reconstructed[index]!;
    reconstructed[index] = xy((value << 16 >> 16) + 10, (value >> 16) + 20);
  }
  expect(reconstructed).toEqual(words);
  expect(words[1]).toBe(xy(10, 20));
});

test("runtime texture/native text/transform ops and malformed streams are rejected", () => {
  for (const op of [DRAW_OP.texQuad, DRAW_OP.texTri, DRAW_OP.tri, DRAW_OP.textRun, DRAW_OP.surfaceQuad]) {
    expect(() => normalizeStaticDrawWords([op, ...Array(20).fill(0)], [0, 0], options)).toThrow("unsupported");
  }
  expect(() => normalizeStaticDrawWords([DRAW_OP.rect], [0, 0], options)).toThrow("truncated");
  expect(() => normalizeStaticDrawWords([DRAW_OP.scissorPop], [0, 0], options)).toThrow("unbalanced");
  expect(() => normalizeStaticDrawWords([], [0.25, 0], options)).toThrow("integer");
});

test("static tables are shared across plans while ordinary Rust constants retain syntax", () => {
  const source: AotStaticDrawPlan = { sourceKey: "one", target: "aarch64-apple-darwin-std", words: [1, 0, xy(10, 10), 0xff123456], coordinates: [1], patches: [], origin: [0, 0], size: [10, 10], clip: [0, 0, 100, 80], viewport: [100, 80], opacity: 1, bounds: [0, 0, 10, 10] };
  const ast = staticDrawPlanAst([source, { ...source, sourceKey: "two", origin: [20, 30] }]);
  const code = printRust({ items: [...ast.items, { kind: "const", name: "ORDINARY", type: rt("u32"), value: rl(7, "u32") }] });
  expect(code.match(/static STATIC_DRAW_WORDS_0:/g)).toHaveLength(1);
  expect(code).not.toContain("STATIC_DRAW_WORDS_1");
  expect(code.match(/words: &STATIC_DRAW_WORDS_0,/g)).toHaveLength(2);
  expect(code).toContain("const ORDINARY: u32 = 7u32;");
});

function view(style: string, rootStyle = "") {
  const file = resolve(".pocket-build/validation/microts-specialization/static-proof/App.tsx");
  const source = `import {View} from "@pocketjs/framework/solid/components";export default function App(){return <View ${rootStyle}><View style={{width:20,height:10,shrink:0}} class="${style}"/></View>;}`;
  return analyzeSolidAot(file, { sources: new Map([[file, source]]) });
}
function snapshot(program: ReturnType<typeof view>): StaticDrawSnapshot {
  const inner = analyzeAotSpecialization(program).components[0]!.nodes.filter(node => node.kind === "element")[1]!;
  return { sourceKey: "App/node:0/node:1", target: "aarch64-apple-darwin-std", nodes: [{ sourceIdentity: `${inner.loc.file}:${inner.loc.offset}:${inner.id}`, tag: "View", parentIndex: -1, rect: { x: 0, y: 0, width: 20, height: 10 } }], words: [DRAW_OP.rect, 0, xy(20, 10), 0xff123456] };
}

test("Build proofs reject ancestor transforms, opacity, clipping and Frame paint candidates", () => {
  const plain = view("bg-red-500");
  expect(createStaticDrawPlans(plain, [snapshot(plain)], options).plans).toHaveLength(1);
  for (const root of ['style={{rotate:5}}', 'style={{opacity:0.5}}', 'class="overflow-hidden"']) {
    const program = view("bg-red-500", root);
    expect(createStaticDrawPlans(program, [snapshot(program)], options).plans).toHaveLength(0);
  }
  for (const style of ["bg-red-500 focus:bg-transparent", "opacity-100 focus:opacity-0", "rounded-[0px] focus:rounded-[8px]", "shadow focus:shadow-lg", "bg-red-500 focus:bg-blue-500 focus:rounded-[8px]", "bg-red-500 focus:bg-blue-500 focus:hidden", "bg-red-500 focus:bg-blue-500 focus:bg-gradient-to-r"]) {
    const program = view(style);
    const result = createStaticDrawPlans(program, [snapshot(program)], options);
    expect(result.plans).toHaveLength(0);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("regenerate");
  }
  const program = view("bg-red-500 focus:bg-blue-500");
  const properties = analyzeAotSpecialization(program).components[0]!.nodes[1]!.properties;
  const color = properties.find(property => property.name === "bgColor")!.value;
  expect(color.kind).toBe("Candidates");
  const seed = snapshot(program); seed.words[3] = color.kind === "Candidates" ? color.values[0] as number : 0;
  const plan = createStaticDrawPlans(program, [seed], options).plans[0]!;
  expect(plan.patches).toEqual([{ word: 3, prop: properties.find(property => property.name === "bgColor")!.prop, candidates: color.kind === "Candidates" ? color.values as number[] : [] }]);
  expect(staticPaintFallback(properties).join(" ")).toContain("owning-node word-slot proof");
});


test("baked single RECT plans draw on the first frame and patch finite focus colors", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const directory = resolve(".pocket-build/validation/microts-specialization", `static-focus-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot: true, entry: "App.tsx" } }));
  await writeFile(resolve(directory, "App.tsx"), `import {View} from "@pocketjs/framework/solid/components";export default function App(){return <View focusable style={{width:20,height:10,shrink:0}} class="bg-red-500 focus:bg-blue-500"/>;}`);
  const result = await executeSpecialization(directory, {
    specializationTarget: "host", modelSource: "struct Model; impl AppViewModel for Model {}", modelExpression: "Model",
    tape: { viewport: [100, 80], frames: [{}, { buttons: 64 }, {}] },
  });
  expect(result.specialized.frames[0]!.counters.static_plan_hits).toBeGreaterThan(0);
  expect(result.specialized.frames[0]!.counters.generated_words).toBe(0);
  expect(result.reference.frames[0]!.counters.generated_words).toBe(4);
  expect(result.specialized.frames[1]!.counters.static_plan_hits).toBeGreaterThan(0);
  expect(result.specialized.frames[1]!.words).not.toEqual(result.specialized.frames[0]!.words);
  const source = await readFile(resolve(result.run, "on/src/gen/app.rs"), "utf8");
  expect(source).toContain("static STATIC_DRAW_WORDS_0:");
  expect(source).toContain("StaticDrawPatch");
}, 180_000);
