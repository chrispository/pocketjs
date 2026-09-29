// Static draw plans: draw words recorded at build time and relocated to the
// region origin at runtime. A region gets a plan only when its paint is known
// at build time or limited to known candidate colors.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BTN, DRAW_OP } from "../contracts/spec/spec.ts";
import type { AotProgram } from "../microts/compiler/aot-ir.ts";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";
import { analyzeAotSpecialization } from "../microts/compiler/aot-specialization.ts";
import { specializationBakeTarget } from "../microts/compiler/aot-specialization-bake.ts";
import { createStaticDrawPlans, normalizeStaticDrawWords, staticDrawPlanAst, staticPaintFallback, type AotStaticDrawPlan } from "../microts/compiler/aot-static-draw-plan.ts";
import { rl, rt } from "../microts/compiler/rust-ast.ts";
import { printRust } from "../microts/compiler/rust-printer.ts";
import { OUT, fontAtlas, perFrame, runApp } from "./helpers/microts-specialization.ts";

/** A draw-list position word: x in the low 16 bits, y in the high 16 bits. */
const xy = (x: number, y: number) => ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
const options = { viewport: [100, 80] as const };

test("relocation is reversible and glyph damage is clipped by the scissor", () => {
  const words = [
    DRAW_OP.scissor, xy(10, 20), xy(15, 12),
    DRAW_OP.rect, xy(12, 22), xy(6, 5), 0xff123456,
    DRAW_OP.glyphRun, 1 << 16 /* one glyph from slot 0 */, 0xffffffff, xy(23, 28), 2 /* glyph id */,
    DRAW_OP.scissorPop,
  ];
  const fontAtlases = [{ slot: 0, bytes: fontAtlas({ cell: [5, 8], glyphs: { a: 5, b: 5 } }) }];
  const plan = normalizeStaticDrawWords(words, [10, 20], { ...options, fontAtlases });
  expect(plan.coordinates).toEqual([1, 4, 10]);
  // The 5x8 glyph cell at (23, 28) is clipped to the scissor; bounds are relative to (10, 20).
  expect(plan.bounds).toEqual([2, 2, 15, 12]);
  const relocated = plan.words.map((word, index) => plan.coordinates.includes(index) ? xy((word << 16 >> 16) + 10, (word >> 16) + 20) : word);
  expect(relocated).toEqual(words);
});

test("runtime-only ops and malformed streams are rejected", () => {
  const normalize = (words: number[], origin: [number, number] = [0, 0]) => () => normalizeStaticDrawWords(words, origin, options);
  for (const op of [DRAW_OP.texQuad, DRAW_OP.texTri, DRAW_OP.tri, DRAW_OP.textRun, DRAW_OP.surfaceQuad]) {
    expect(normalize([op, ...Array(20).fill(0)])).toThrow("unsupported");
  }
  expect(normalize([DRAW_OP.rect])).toThrow("truncated");
  expect(normalize([DRAW_OP.scissorPop])).toThrow("unbalanced");
  expect(normalize([], [0.25, 0])).toThrow("integer");
});

test("plans with identical words share one static table", () => {
  const plan: AotStaticDrawPlan = { sourceKey: "one", target: "aarch64-apple-darwin-std", words: [DRAW_OP.rect, 0, xy(10, 10), 0xff123456], coordinates: [1],
    patches: [], origin: [0, 0], size: [10, 10], clip: [0, 0, 100, 80], viewport: [100, 80], opacity: 1, bounds: [0, 0, 10, 10] };
  const { items } = staticDrawPlanAst([plan, { ...plan, sourceKey: "two", origin: [20, 30] }]);
  const code = printRust({ items: [...items, { kind: "const", name: "ORDINARY", type: rt("u32"), value: rl(7, "u32") }] });
  expect(code.match(/static STATIC_DRAW_WORDS_\d+:/g)).toEqual(["static STATIC_DRAW_WORDS_0:"]);
  expect(code.match(/words: &STATIC_DRAW_WORDS_0,/g)).toHaveLength(2);
  expect(code).toContain("const ORDINARY: u32 = 7u32;"); // non-static constants print unchanged
});

/** A root View around a 20x10 box with `className`. */
function app(className: string, rootAttributes = "") {
  const file = resolve(OUT, "static-proof/App.tsx");
  const source = `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View ${rootAttributes}><View style={{width:20,height:10,shrink:0}} class="${className}"/></View>;}`;
  return analyzeSolidAot(file, { sources: new Map([[file, source]]) });
}

/** Plans for the box, given the RECT it drew at build time. */
function plans(program: AotProgram, color = 0xff123456) {
  const box = analyzeAotSpecialization(program).components[0]!.nodes.filter(node => node.kind === "element")[1]!;
  const node = { sourceIdentity: `${box.loc.file}:${box.loc.offset}:${box.id}`, tag: "View" as const, parentIndex: -1, rect: { x: 0, y: 0, width: 20, height: 10 } };
  return createStaticDrawPlans(program, [{ sourceKey: "App/node:0/node:1", target: "aarch64-apple-darwin-std", nodes: [node], words: [DRAW_OP.rect, 0, xy(20, 10), color] }], options);
}

test("plans require Build paint; ancestor transforms, opacity, clipping and paint changes are rejected", () => {
  expect(plans(app("bg-red-500")).plans).toHaveLength(1);
  for (const root of ["style={{rotate:5}}", "style={{opacity:0.5}}", 'class="overflow-hidden"']) {
    expect(plans(app("bg-red-500", root)).plans).toEqual([]);
  }
  // Focus styles that change more than an opaque fill color.
  for (const style of ["bg-red-500 focus:bg-transparent", "opacity-100 focus:opacity-0", "rounded-[0px] focus:rounded-[8px]", "shadow focus:shadow-lg",
    "bg-red-500 focus:bg-blue-500 focus:rounded-[8px]", "bg-red-500 focus:bg-blue-500 focus:hidden", "bg-red-500 focus:bg-blue-500 focus:bg-gradient-to-r"]) {
    const result = plans(app(style));
    expect(result.plans).toEqual([]);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("regenerate");
  }
  // A focus color swap becomes a patch of the RECT's color word.
  const program = app("bg-red-500 focus:bg-blue-500");
  const properties = analyzeAotSpecialization(program).components[0]!.nodes[1]!.properties;
  const fill = properties.find(property => property.name === "bgColor")!;
  expect(fill.value.kind).toBe("Candidates");
  const candidates = fill.value.kind === "Candidates" ? fill.value.values as number[] : [];
  expect(plans(program, candidates[0]).plans[0]!.patches).toEqual([{ word: 3, prop: fill.prop, candidates }]);
  expect(staticPaintFallback(properties).join(" ")).toContain("owning-node word-slot proof");
});

test.skipIf(specializationBakeTarget("host") === null)("a baked RECT plan draws the first frame and patches the focus color", async () => {
  const run = await runApp("static-focus", { "App.tsx": `import {View} from "@pocketjs/framework/solid/components";
export default function App(){return <View focusable style={{width:20,height:10,shrink:0}} class="bg-red-500 focus:bg-blue-500"/>;}` },
  { specializationTarget: "host", tape: { viewport: [100, 80], frames: [{}, { buttons: BTN.DOWN }, {}] } });
  expect(perFrame(run.reference, "generated_words")[0]).toBe(4);
  expect(perFrame(run.specialized, "generated_words")[0]).toBe(0); // copied from the plan
  expect(perFrame(run.specialized, "static_plan_hits").slice(0, 2).every(hits => hits > 0)).toBe(true);
  expect(run.specialized.frames[1]!.words).not.toEqual(run.specialized.frames[0]!.words); // DOWN focused the box
}, 180_000);
