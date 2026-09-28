// apps/mv/scenes.tsx — the seven cuts of "PRIMARY LIGHT", in running order.
//
// Each scene is a pure function of ONE number: the tick offset from its own
// first frame (apps/mv/timeline.ts `sceneStart`). Nothing here holds state, so
// seeking is a matter of passing a different `f` — which is what lets the
// offline renderer (site/record-mv.ts) and a console run the same code and get
// the same pixels.
//
// The reading behind the picture: red, green and blue are what a display has,
// and they are also the three framework adapters that reach one native tree.
// The MV runs that sentence forwards — one point splits into three primaries,
// the three converge back into one white beam — and lands on the hardware.

import { Index, Show } from "solid-js";
import type { JSX } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { Box, Caption, CellLabel, CellMono, Label, Mono, Sub, Title, Wordmark } from "./stage.tsx";
import {
  BEAT, BLUE, CLEAR, DIM, GREEN, INK, PRIMARIES, RED, WHITE,
  beatPulse, blend, clamp01, easeIn, easeInOut, easeOut, easeOutBack, fade, hash, phase, ramp,
} from "./timeline.ts";

const W = 480;
const H = 272;
const CX = 240;
const CY = 136;

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** 0..n-1 as a real array — `Index` needs a list, and these never change. */
const series = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i);

const CELLS_12 = series(12);
const CELLS_7 = series(7);
const BARS_24 = series(24);
const LANES = series(3);
const BLOCKS = series(9);
const RINGS = series(4);
const SPOKES = series(12);
const PIXEL_COLS = series(8);
const PIXEL_ROWS = series(5);
const SUBPIXELS = series(3);
const DEVICES = series(5);

// ---------------------------------------------------------------------------
// 1. IGNITE — bars 0-3. One point of light splits into the three primaries.
// ---------------------------------------------------------------------------

/** The three rules' resting baselines before they collapse under the wordmark. */
const IGNITE_Y = [96, 136, 176];

export function Ignite(props: { f: number }): JSX.Element {
  const f = () => props.f;
  // The rules start spread across the screen and end as a tight RGB triple
  // rule under the wordmark, which is the lockup the end card returns to.
  const collapse = () => easeInOut(ramp(f(), 228, 312));
  const seedAlpha = () => ramp(f(), 4, 40) * (1 - ramp(f(), 96, 132));
  const seedSize = () => 2 + 7 * easeOut(ramp(f(), 4, 72));
  // Strike on the frame and fall away squared: a linear ramp spends too many
  // ticks at half alpha, which reads as a gray wash instead of a flash.
  const flash = () => (f() < 192 ? 0 : Math.max(0, 1 - (f() - 192) / 12) ** 2);
  const wordIn = () => ramp(f(), 192, 246);

  return (
    <>
      <Index each={LANES}>
        {(lane) => {
          const i = lane();
          const width = () => lerp(476, 252, collapse()) * easeOut(ramp(f(), 132 + i * 8, 236 + i * 8));
          const top = () => lerp(IGNITE_Y[i], 168 + i * 5, collapse());
          return (
            <Box
              debugName="IgniteRule"
              style={{
                insetL: CX - width() / 2, insetT: top(), width: width(), height: 2,
                bgColor: fade(PRIMARIES[i], ramp(f(), 108 + i * 8, 150 + i * 8) * 0.95),
              }}
            />
          );
        }}
      </Index>

      {/* The seed: one white point, before there is anything to split. */}
      <Box
        debugName="IgniteSeed"
        style={{
          insetL: CX - seedSize() / 2, insetT: CY - seedSize() / 2,
          width: seedSize(), height: seedSize(), radius: seedSize() / 2,
          bgColor: fade(WHITE, seedAlpha()),
        }}
      />

      {/* The split: three points fanning out to their own baselines. */}
      <Index each={LANES}>
        {(lane) => {
          const i = lane();
          const spread = () => easeOut(ramp(f(), 96, 156));
          const top = () => lerp(CY, lerp(IGNITE_Y[i], 168 + i * 5, collapse()) + 1, spread());
          return (
            <Box
              debugName="IgniteDot"
              style={{
                insetL: CX - 4, insetT: top() - 4, width: 8, height: 8, radius: 4,
                bgColor: fade(PRIMARIES[i], ramp(f(), 96, 126) * (1 - ramp(f(), 150, 186))),
              }}
            />
          );
        }}
      </Index>

      <Wordmark
        text="PocketJS"
        y={100}
        split={16 * (1 - easeOut(ramp(f(), 192, 258))) + 1.6 + 1.4 * Math.sin(f() * 0.055)}
        opacity={ramp(f(), 192, 206)}
        scale={lerp(1.3, 1, easeOutBack(wordIn()))}
      />

      <Caption
        text="A PORTABLE APPLICATION RUNTIME"
        style={{ insetT: 196, textColor: DIM, opacity: ramp(f(), 258, 306) * 0.9, tracking: 1.2 }}
      />

      <Box
        debugName="IgniteFlash"
        style={{ insetL: 0, insetT: 0, width: W, height: H, bgColor: fade(WHITE, flash() * 0.8) }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. LANES — bars 4-11. One lane per framework adapter, entering two bars
// apart. The mono line under them retypes that lane's real import.
// ---------------------------------------------------------------------------

const LANE_Y = [64, 128, 192];
const LANE_ENTER = [0, 192, 384];
const LANE_NAME = ["solid-js", "vue vapor", "octane"];
const LANE_IMPORT = [
  'import { createSignal } from "solid-js"',
  'import { ref } from "vue"',
  'import { signal } from "octane"',
];
const SHARED_IMPORT = 'import { View } from "@pocketjs/framework/components"';

/** The import being typed at tick `f`, and how far the caret has got. */
function typed(f: number): string {
  const source = f >= 576 ? SHARED_IMPORT : f >= 384 ? LANE_IMPORT[2] : f >= 192 ? LANE_IMPORT[1] : LANE_IMPORT[0];
  const start = f >= 576 ? 576 : f >= 384 ? 384 : f >= 192 ? 192 : 24;
  const shown = Math.min(source.length, Math.floor((f - start) / 2));
  if (shown <= 0) return "";
  const caret = shown < source.length || phase(f, 32) < 0.5 ? "_" : " ";
  return source.slice(0, shown) + caret;
}

export function Lanes(props: { f: number }): JSX.Element {
  const f = () => props.f;
  return (
    <>
      <Caption
        text="THREE FRAMEWORK ADAPTERS"
        style={{ insetT: 16, textColor: DIM, opacity: ramp(f(), 8, 56) * 0.9, tracking: 1.4 }}
      />

      <Index each={LANES}>
        {(lane) => {
          const i = lane();
          const t = () => f() - LANE_ENTER[i];
          const on = () => clamp01(t() / 30);
          const width = () => W * easeOut(clamp01(t() / 54));
          return (
            <>
              <Box
                debugName="LaneRule"
                style={{
                  insetL: 0, insetT: LANE_Y[i], width: width(), height: 2,
                  bgColor: fade(PRIMARIES[i], on() * 0.9),
                }}
              />
              <Label
                text={LANE_NAME[i]}
                style={{ insetL: 12, insetT: LANE_Y[i] - 18, textColor: PRIMARIES[i], opacity: on() }}
              />
              <Index each={BLOCKS}>
                {(block) => {
                  const j = block();
                  const x = () => W - ((t() * 2.4 + j * 62 + i * 27) % 560);
                  const w = 16 + 26 * hash(i * 16 + j);
                  return (
                    <Box
                      debugName="LaneBlock"
                      style={{
                        insetL: x(), insetT: LANE_Y[i] + 10, width: w, height: 11, radius: 2,
                        bgColor: fade(PRIMARIES[i], (0.26 + 0.6 * beatPulse(f() - j * 2, BEAT, 4)) * on()),
                      }}
                    />
                  );
                }}
              </Index>
              {/* The read head: where this lane's frame is being built right now. */}
              <Box
                debugName="LaneHead"
                style={{
                  insetL: (t() * 3.4) % 492 - 6, insetT: LANE_Y[i] - 4, width: 4, height: 10,
                  bgColor: fade(WHITE, on() * 0.65),
                }}
              />
            </>
          );
        }}
      </Index>

      <Mono text={typed(f())} style={{ insetT: 240, textColor: DIM, opacity: 0.95 }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. PRISM — bars 12-15. The three lanes rotate onto one axis and meet. The
// snare roll of bar 15 rides the rings leaving the convergence point.
// ---------------------------------------------------------------------------

const PRISM_X = 352;
const BEAM_LENGTH = 430;
/** Angle that puts each beam's far end on its lane baseline from scene 2. */
const BEAM_ANGLE = LANE_Y.map((y) => (Math.asin((y - CY) / BEAM_LENGTH) * 180) / Math.PI);
const CARRIERS = series(5);

export function Prism(props: { f: number }): JSX.Element {
  const f = () => props.f;
  const converge = () => easeInOut(ramp(f(), 48, 240));
  const core = () =>
    6 + 30 * easeOut(ramp(f(), 180, 288)) + 12 * beatPulse(f(), BEAT, 6) * ramp(f(), 180, 228);
  const output = () => (W - PRISM_X + 8) * easeOut(ramp(f(), 240, 306));

  return (
    <>
      <Index each={LANES}>
        {(lane) => {
          const i = lane();
          return (
            <View
              debugName="PrismBeam"
              class="absolute left-0 top-0 origin-right"
              style={{
                insetL: PRISM_X - BEAM_LENGTH, insetT: CY - 1.5,
                width: BEAM_LENGTH, height: 3,
                rotate: BEAM_ANGLE[i] * (1 - converge()),
                // The last stretch of the turn washes each primary out to
                // white, so the three beams land as one white line.
                bgColor: fade(blend(PRIMARIES[i], WHITE, clamp01((converge() - 0.55) / 0.45)), 0.85),
              }}
            >
              {/* Work riding the beam toward the meeting point. */}
              <Index each={CARRIERS}>
                {(carrier) => {
                  const j = carrier();
                  const x = () => ((f() * 3.1 + j * 96 + i * 37) % (BEAM_LENGTH + 60)) - 30;
                  return (
                    <Box
                      debugName="PrismCarrier"
                      style={{
                        insetL: x(), insetT: -3, width: 22, height: 9, radius: 2,
                        bgColor: fade(PRIMARIES[i], 0.35 + 0.55 * beatPulse(f() - j * 3, BEAT, 4)),
                      }}
                    />
                  );
                }}
              </Index>
            </View>
          );
        }}
      </Index>

      {/* The white output: one beam, leaving on the far side. */}
      <Box
        debugName="PrismOutput"
        style={{ insetL: PRISM_X, insetT: CY - 1.5, width: output(), height: 3, bgColor: fade(WHITE, 0.95) }}
      />

      {/* The meeting point itself. */}
      <Box
        debugName="PrismCore"
        style={{
          insetL: PRISM_X - core() / 2, insetT: CY - core() / 2,
          width: core(), height: core(), radius: 3, rotate: 45,
          bgColor: fade(WHITE, ramp(f(), 172, 214)),
        }}
      />

      <Index each={RINGS}>
        {(ring) => {
          const k = ring();
          const spawn = 276 + k * 26;
          const grow = () => ramp(f(), spawn, spawn + 60);
          const r = () => 10 + 132 * grow();
          return (
            <Box
              debugName="PrismRing"
              style={{
                insetL: PRISM_X - r(), insetT: CY - r(), width: r() * 2, height: r() * 2, radius: r(),
                bgColor: CLEAR, borderWidth: 2,
                borderColor: fade(WHITE, grow() > 0 ? (1 - grow()) * 0.7 : 0),
              }}
            />
          );
        }}
      </Index>

      <Caption
        text="ONE QUICKJS GUEST, ONE RUST CORE"
        style={{ insetT: 232, textColor: DIM, opacity: ramp(f(), 108, 156) * 0.9, tracking: 1.3 }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared: the beat grid. Twelve by seven cells cycling the three primaries on
// a diagonal wave, one beat per column pair. Chorus and finale both sit on it.
// ---------------------------------------------------------------------------

export function BeatGrid(props: { f: number; gain: number }): JSX.Element {
  return (
    <Index each={CELLS_12}>
      {(column) => {
        const c = column();
        return (
          <Index each={CELLS_7}>
            {(row) => {
              const r = row();
              const wave = () => beatPulse(props.f - (c * 2 + r * 5), BEAT * 2, 5);
              return (
                <Box
                  debugName="GridCell"
                  style={{
                    insetL: c * 40 + 1, insetT: r * 38 + 3, width: 38, height: 36, radius: 2,
                    bgColor: fade(PRIMARIES[(c + r) % 3], (0.05 + 0.32 * wave()) * props.gain),
                  }}
                />
              );
            }}
          </Index>
        );
      }}
    </Index>
  );
}

/** The 24-band spectrum strip: one hue wheel across the bottom of the screen. */
export function Spectrum(props: { f: number; gain: number }): JSX.Element {
  return (
    <Index each={BARS_24}>
      {(band) => {
        const j = band();
        const color =
          j < 8 ? blend(RED, GREEN, j / 8)
          : j < 16 ? blend(GREEN, BLUE, (j - 8) / 8)
          : blend(BLUE, RED, (j - 16) / 8);
        const h = () =>
          4 + 22 * Math.abs(Math.sin(props.f * 0.11 + j * 0.62)) *
            (0.45 + 0.55 * beatPulse(props.f, BEAT / 2, 4));
        return (
          <Box
            debugName="SpectrumBand"
            style={{
              insetL: j * 20 + 1, insetT: 266 - h(), width: 18, height: h(), radius: 1,
              bgColor: fade(color, 0.9 * props.gain),
            }}
          />
        );
      }}
    </Index>
  );
}

// ---------------------------------------------------------------------------
// 4. CHORUS — bars 16-23. Four two-bar claims, each slammed in with a fringe
// that settles, and the native tree drawing itself under the last one.
// ---------------------------------------------------------------------------

const CLAIMS = ["NO DOM", "NO CSS ENGINE", "NO WEBVIEW", "ONE NATIVE TREE"];
const TREE_INPUT_Y = [104, 136, 168];
const TREE_BRANCH_Y = [90, 136, 182];
const LEAF_DY = [-20, 20];
const BRANCHES = series(3);
const LEAVES = series(2);

/** The native tree, drawn left to right in the order the build makes it: three
 *  colored adapter feeds, an orthogonal merge, and one white tree past the
 *  root. Right of the merge nothing is colored any more — that is the point. */
function NativeTree(props: { f: number }): JSX.Element {
  const f = () => props.f;
  const ink = (at: number, over: number) => fade(WHITE, ramp(f(), at, over) * 0.95);
  const live = () => 0.78 + 0.22 * beatPulse(f(), BEAT, 5);

  return (
    <>
      <Index each={LANES}>
        {(lane) => {
          const i = lane();
          const y = TREE_INPUT_Y[i];
          const drop = Math.abs(y - CY);
          return (
            <>
              <Box
                debugName="TreeFeed"
                style={{
                  insetL: 0, insetT: y - 1, width: 140 * easeOut(ramp(f(), i * 3, 38 + i * 3)), height: 2,
                  bgColor: fade(PRIMARIES[i], 0.9),
                }}
              />
              {/* The turn onto the root's axis: the last colored pixel. */}
              <Box
                debugName="TreeRiser"
                style={{
                  insetL: 138, insetT: Math.min(y, CY) - 1,
                  width: 2, height: (drop + 2) * easeOut(ramp(f(), 36, 56)),
                  bgColor: fade(PRIMARIES[i], 0.9),
                }}
              />
            </>
          );
        }}
      </Index>

      <Box debugName="TreeMerge" style={{ insetL: 140, insetT: CY - 1, width: 38 * easeOut(ramp(f(), 52, 70)), height: 2, bgColor: ink(52, 70) }} />
      <Box debugName="TreeRoot" style={{ insetL: 178, insetT: CY - 8, width: 16, height: 16, radius: 3, bgColor: fade(WHITE, ramp(f(), 66, 80) * live()) }} />
      <Box debugName="TreeTrunk" style={{ insetL: 194, insetT: CY - 1, width: 56 * easeOut(ramp(f(), 76, 94)), height: 2, bgColor: ink(76, 94) }} />
      <Box debugName="TreeSpine" style={{ insetL: 250, insetT: CY - 46 * easeOut(ramp(f(), 90, 112)), width: 2, height: 92 * easeOut(ramp(f(), 90, 112)), bgColor: ink(90, 112) }} />

      <Index each={BRANCHES}>
        {(branch) => {
          const b = branch();
          const y = TREE_BRANCH_Y[b];
          const limb = 106 + b * 4;
          return (
            <>
              <Box debugName="TreeLimb" style={{ insetL: 252, insetT: y - 1, width: 56 * easeOut(ramp(f(), limb, limb + 20)), height: 2, bgColor: ink(limb, limb + 20) }} />
              <Box debugName="TreeNode" style={{ insetL: 306, insetT: y - 6, width: 12, height: 12, radius: 2, bgColor: fade(WHITE, ramp(f(), limb + 16, limb + 30) * live()) }} />
              <Box debugName="TreeStem" style={{ insetL: 318, insetT: y - 1, width: 30 * easeOut(ramp(f(), 126, 144)), height: 2, bgColor: ink(126, 144) }} />
              <Box debugName="TreeFork" style={{ insetL: 348, insetT: y - 20 * easeOut(ramp(f(), 132, 152)), width: 2, height: 40 * easeOut(ramp(f(), 132, 152)), bgColor: ink(132, 152) }} />
              <Index each={LEAVES}>
                {(leaf) => {
                  const l = leaf();
                  const ly = y + LEAF_DY[l];
                  const at = 146 + b * 3 + l * 2;
                  return (
                    <>
                      <Box debugName="TreeTwig" style={{ insetL: 350, insetT: ly - 1, width: 44 * easeOut(ramp(f(), at, at + 20)), height: 2, bgColor: ink(at, at + 20) }} />
                      <Box debugName="TreeLeaf" style={{ insetL: 394, insetT: ly - 5, width: 10, height: 10, radius: 2, bgColor: fade(WHITE, ramp(f(), at + 16, at + 32) * live()) }} />
                    </>
                  );
                }}
              </Index>
            </>
          );
        }}
      </Index>
    </>
  );
}

export function Chorus(props: { f: number }): JSX.Element {
  const f = () => props.f;
  const claim = () => Math.min(3, Math.floor(f() / 192));
  const local = () => f() % 192;
  const tree = () => f() >= 576;
  return (
    <>
      <BeatGrid f={f()} gain={tree() ? 0.3 : 1} />
      <Show when={tree()}>
        <NativeTree f={f() - 576} />
      </Show>

      <Title
        text={CLAIMS[claim()]}
        y={tree() ? 16 : 104}
        split={18 * (1 - easeOut(ramp(local(), 0, 32))) + 1.2 + 1.8 * beatPulse(f(), BEAT, 7)}
        opacity={ramp(local(), 0, 14) * (1 - ramp(local(), 174, 190))}
        scale={lerp(1.18, 1, easeOutBack(clamp01(local() / 26)))}
      />

      <Spectrum f={f()} gain={1} />

      {/* The beat itself, as a frame-wide lift on every strike. */}
      <Box
        debugName="ChorusBeat"
        style={{ insetL: 0, insetT: 0, width: W, height: H, bgColor: fade(WHITE, 0.05 * beatPulse(f(), BEAT, 9)) }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. HARDWARE — bars 24-27. The break drops to the kit, and the same guest
// bundle lights up one screen per beat. Every resolution below is the logical
// viewport the repo's own host for that device declares.
// ---------------------------------------------------------------------------

interface Device {
  readonly name: string;
  readonly res: string;
  readonly bw: number;
  readonly bh: number;
  readonly sw: number;
  readonly sh: number;
  readonly sy: number;
  /** Second panel, for the clamshell. */
  readonly aux?: { readonly w: number; readonly h: number; readonly y: number };
}

const DEVICE_TABLE: readonly Device[] = [
  { name: "PSP", res: "480x272", bw: 86, bh: 40, sw: 46, sh: 26, sy: 7 },
  { name: "VITA", res: "960x544", bw: 86, bh: 38, sw: 52, sh: 26, sy: 6 },
  { name: "3DS", res: "400x240", bw: 50, bh: 62, sw: 42, sh: 22, sy: 5, aux: { w: 34, h: 18, y: 36 } },
  { name: "GBA", res: "240x160", bw: 62, bh: 42, sw: 32, sh: 22, sy: 9 },
  { name: "iPOD", res: "320x568", bw: 38, bh: 68, sw: 32, sh: 50, sy: 9 },
];

const SHELL = blend(INK, WHITE, 0.09);
const DEVICE_BASE = 192; // bottom edge every body sits on

export function Hardware(props: { f: number }): JSX.Element {
  const f = () => props.f;
  return (
    <>
      <Caption text="TARGETS" style={{ insetT: 14, textColor: DIM, opacity: ramp(f(), 6, 40) * 0.85, tracking: 2 }} />

      <Index each={DEVICES}>
        {(device) => {
          const i = device();
          const d = DEVICE_TABLE[i];
          const x = 5 + i * 94 + (94 - d.bw) / 2;
          const top = DEVICE_BASE - d.bh;
          const lit = () =>
            clamp01((f() - 20 - i * 22) / 20) *
            (f() < 264 ? 1 : 0.55 + 0.45 * beatPulse(f(), BEAT, 4));
          const screen = () => fade(PRIMARIES[i % 3], 0.16 + 0.84 * lit());
          const enter = () => easeOut(ramp(f(), i * 10, 40 + i * 10));
          return (
            <>
              <Box
                debugName="DeviceBody"
                style={{
                  insetL: x, insetT: top + 14 * (1 - enter()), width: d.bw, height: d.bh, radius: 6,
                  bgColor: fade(SHELL, enter()), borderWidth: 1, borderColor: fade(DIM, enter() * 0.6),
                }}
              />
              <Box
                debugName="DeviceScreen"
                style={{
                  insetL: x + (d.bw - d.sw) / 2, insetT: top + d.sy + 14 * (1 - enter()),
                  width: d.sw, height: d.sh, radius: 2, bgColor: fade(screen(), enter()),
                }}
              />
              <Show when={d.aux}>
                <Box
                  debugName="DeviceAux"
                  style={{
                    insetL: x + (d.bw - (d.aux?.w ?? 0)) / 2, insetT: top + (d.aux?.y ?? 0) + 14 * (1 - enter()),
                    width: d.aux?.w ?? 0, height: d.aux?.h ?? 0, radius: 2, bgColor: fade(screen(), enter() * 0.85),
                  }}
                />
              </Show>
              <CellLabel
                text={d.name}
                style={{ insetL: 5 + i * 94, insetT: 200, width: 94, textColor: WHITE, opacity: enter() }}
              />
              <CellMono
                text={d.res}
                style={{ insetL: 5 + i * 94, insetT: 216, width: 94, textColor: DIM, opacity: enter() * 0.9 }}
              />
            </>
          );
        }}
      </Index>

      <Title
        text="ONE GUEST BUNDLE"
        y={42}
        split={14 * (1 - easeOut(ramp(f(), 16, 72))) + 1 + 1.4 * beatPulse(f(), BEAT, 7)}
        opacity={ramp(f(), 16, 40)}
        scale={lerp(1.14, 1, easeOutBack(clamp01((f() - 16) / 30)))}
      />
      <Caption
        text="THE SAME TYPESCRIPT SOURCES"
        style={{ insetT: 244, textColor: DIM, opacity: ramp(f(), 200, 240) * 0.9, tracking: 1.3 }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 6. PIXELS — bars 28-31. The bridge drops the kit entirely and the camera
// pulls back off a panel's own red, green and blue stripes.
// ---------------------------------------------------------------------------

const SUBPIXEL_COLOR = [RED, GREEN, BLUE];

export function Pixels(props: { f: number }): JSX.Element {
  const f = () => props.f;
  const zoom = () => lerp(2.9, 1, easeInOut(ramp(f(), 10, 312)));
  const wipe = () => ramp(f(), 352, 384);
  const text = () => ramp(f(), 54, 120) * (1 - ramp(f(), 316, 350));

  return (
    <>
      <View debugName="PixelPanel" class="absolute left-0 top-0" style={{ insetL: 0, insetT: 0, width: W, height: H, scale: zoom() }}>
        <Index each={PIXEL_COLS}>
          {(column) => {
            const c = column();
            return (
              <Index each={PIXEL_ROWS}>
                {(row) => {
                  const r = row();
                  return (
                    <Index each={SUBPIXELS}>
                      {(stripe) => {
                        const k = stripe();
                        const glow = () =>
                          0.08 + 0.92 * clamp01(0.5 + 0.5 * Math.sin(c * 0.8 + r * 1.1 - f() * 0.07 + k * 0.9));
                        return (
                          <Box
                            debugName="Subpixel"
                            style={{
                              insetL: 8 + c * 58 + 1 + k * 18, insetT: 6 + r * 52 + 3,
                              width: 16, height: 44,
                              bgColor: fade(SUBPIXEL_COLOR[k], glow() * ramp(f(), 0, 24)),
                            }}
                          />
                        );
                      }}
                    </Index>
                  );
                }}
              </Index>
            );
          }}
        </Index>
      </View>

      {/* Scrim, so the two lines stay readable over a lit panel. */}
      <Box
        debugName="PixelScrim"
        style={{ insetL: 0, insetT: 90, width: W, height: 100, bgColor: fade(INK, 0.88 * text()) }}
      />
      <Title text="EVERY PIXEL" y={104} split={1.4 + 1.2 * Math.sin(f() * 0.05)} opacity={text()} scale={1} />
      <Sub text="ONE THREAD, ONE PROCESS" style={{ insetT: 150, textColor: DIM, opacity: text() * 0.95 }} />

      <Box
        debugName="PixelWipe"
        style={{ insetL: 0, insetT: 0, width: W, height: H, bgColor: fade(WHITE, wipe() * 0.9) }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 7. FINALE — bars 32-39. The three beams run back in, converge to white, and
// the card that comes out of the flash is the lockup scene 1 built.
// ---------------------------------------------------------------------------

const FINALE_Y = [68, 136, 204];
/** Two two-bar statements over the beams, before the convergence. */
const FINALE_TITLE = ["EVERY FRAME OF THIS", "480 x 272"];
const FINALE_SUB = ["WAS DRAWN BY THE CORE", "SIXTY TIMES A SECOND"];

export function Finale(props: { f: number }): JSX.Element {
  const f = () => props.f;
  const card = () => f() >= 480;
  const core = () => 8 + 150 * easeIn(ramp(f(), 384, 458));
  // One node covers both white events: the wipe handed over by scene 6, and
  // the convergence flash the end card comes out of.
  const white = () =>
    Math.max(0.88 * (1 - ramp(f(), 0, 18)), ramp(f(), 446, 478) * (1 - ramp(f(), 486, 528)));
  const out = () => 1 - ramp(f(), 688, 762);
  const statement = () => (f() >= 192 ? 1 : 0);
  const beat = () => f() % 192;
  const said = () => ramp(beat(), 10, 34) * (1 - ramp(beat(), 170, 182)) * (1 - ramp(f(), 372, 388));

  return (
    <>
      <Show when={!card()}>
        <BeatGrid f={f()} gain={0.9 * (1 - ramp(f(), 384, 452))} />

        {/* Three beams, racing back to the point they left in scene 1. */}
        <Index each={LANES}>
          {(lane) => {
            const i = lane();
            const head = () =>
              lerp(-140, CX - 8, easeOut(ramp(f(), i * 14, 168))) +
              7 * beatPulse(f() - i * 4, BEAT, 6) * ramp(f(), 160, 186);
            const collapse = () => easeIn(ramp(f(), 340, 440));
            return (
              <>
                <Box
                  debugName="FinaleTrail"
                  style={{
                    insetL: head() - 150, insetT: lerp(FINALE_Y[i], CY, collapse()) - 1,
                    width: 150, height: 2, bgColor: fade(PRIMARIES[i], 0.3),
                  }}
                />
                <Box
                  debugName="FinaleBeam"
                  style={{
                    insetL: head() - 60, insetT: lerp(FINALE_Y[i], CY, collapse()) - 2,
                    width: 60, height: 4, bgColor: fade(PRIMARIES[i], 0.95),
                  }}
                />
              </>
            );
          }}
        </Index>

        <Index each={RINGS}>
          {(ring) => {
            const k = ring();
            const p = () => phase(f() - 192 - k * 24, 96);
            const r = () => 14 + 160 * p();
            const on = () => (f() >= 192 + k * 24 && f() < 400 ? 1 : 0);
            return (
              <Box
                debugName="FinaleRing"
                style={{
                  insetL: CX - r(), insetT: CY - r(), width: r() * 2, height: r() * 2, radius: r(),
                  bgColor: CLEAR, borderWidth: 2, borderColor: fade(WHITE, (1 - p()) * 0.55 * on()),
                }}
              />
            );
          }}
        </Index>

        <Index each={SPOKES}>
          {(spoke) => {
            const k = spoke();
            return (
              <View
                debugName="FinaleSpoke"
                class="absolute left-0 top-0 origin-left"
                style={{
                  insetL: CX, insetT: CY - 1.5, width: 240, height: 3,
                  rotate: k * 30 + f() * 1.1,
                  bgColor: fade(WHITE, ramp(f(), 372, 414) * (1 - ramp(f(), 444, 466)) * 0.75),
                }}
              />
            );
          }}
        </Index>

        <Box
          debugName="FinaleCore"
          style={{
            insetL: CX - core() / 2, insetT: CY - core() / 2, width: core(), height: core(), radius: core() / 2,
            bgColor: fade(WHITE, ramp(f(), 380, 420)),
          }}
        />

        <Spectrum f={f()} gain={1 - ramp(f(), 384, 440)} />

        {/* What the last chorus is actually for: the video is the runtime. */}
        <Box
          debugName="FinaleScrim"
          style={{ insetL: 0, insetT: 74, width: W, height: 100, bgColor: fade(INK, 0.82 * said()) }}
        />
        <Title
          text={FINALE_TITLE[statement()]}
          y={84}
          split={16 * (1 - easeOut(ramp(beat(), 10, 46))) + 1.2 + 1.6 * beatPulse(f(), BEAT, 7)}
          opacity={said()}
          scale={lerp(1.14, 1, easeOutBack(clamp01((beat() - 10) / 28)))}
        />
        <Sub
          text={FINALE_SUB[statement()]}
          style={{ insetT: 134, textColor: DIM, opacity: said() * 0.95 }}
        />
      </Show>

      {/* End card: wordmark, the RGB triple rule, and where to find it. */}
      <Show when={card()}>
        <Wordmark
          text="PocketJS"
          y={64}
          split={1.6 + 2.4 * Math.sin(f() * 0.045)}
          opacity={ramp(f(), 486, 512) * out()}
          scale={lerp(1.06, 1, easeOut(ramp(f(), 486, 580)))}
        />
        <Index each={LANES}>
          {(lane) => {
            const i = lane();
            const w = () => 220 * easeOut(ramp(f(), 512 + i * 8, 566 + i * 8));
            return (
              <Box
                debugName="CardRule"
                style={{
                  insetL: CX - w() / 2, insetT: 132 + i * 5, width: w(), height: 2,
                  bgColor: fade(PRIMARIES[i], 0.95 * out()),
                }}
              />
            );
          }}
        </Index>
        <Caption
          text="NO DOM · NO CSS ENGINE · NO WEBVIEW"
          style={{ insetT: 158, textColor: DIM, opacity: ramp(f(), 552, 596) * 0.95 * out(), tracking: 0.8 }}
        />
        <Caption
          text="SOLID · VUE VAPOR · OCTANE"
          style={{ insetT: 176, textColor: DIM, opacity: ramp(f(), 570, 614) * 0.95 * out(), tracking: 0.8 }}
        />
        <Sub
          text="pocketjs.dev"
          style={{ insetT: 202, textColor: WHITE, opacity: ramp(f(), 596, 640) * out() }}
        />
      </Show>

      <Box
        debugName="FinaleWhite"
        style={{ insetL: 0, insetT: 0, width: W, height: H, bgColor: fade(WHITE, white()) }}
      />
    </>
  );
}
