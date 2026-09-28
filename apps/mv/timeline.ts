// apps/mv/timeline.ts — the one clock the whole MV reads.
//
// "PRIMARY LIGHT" runs at 150 BPM, so at the 60 Hz core tick a beat is exactly
// 24 ticks and a bar is 96. apps/mv/gen-assets.ts renders the waveform against
// that same grid, which is why every cut below lands on a beat without any
// audio-position query: the tick counter IS the transport. A host with no
// audio module plays the identical picture in silence.
//
// Everything here is pure arithmetic over the tick counter. No signals, no
// state — the scenes in app.tsx call these with the current frame.

export const HZ = 60;
export const BEAT = 24; // ticks per beat at 150 BPM
export const BAR = BEAT * 4; // 96
export const BARS = 40;
export const TOTAL = BAR * BARS; // 3840 ticks = 64.000 s

// ---------------------------------------------------------------------------
// Palette — additive primaries on near-black, plus the two neutrals.
// ---------------------------------------------------------------------------

/** Pack a color the way the native contract carries it: u32 ABGR, no string
 *  allocation on the per-frame path (see contracts/spec/spec.ts `abgr`). */
export const abgr = (r: number, g: number, b: number, a = 255): number =>
  (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;

export const INK = abgr(0x05, 0x07, 0x0d);
export const RED = abgr(0xff, 0x2d, 0x4b);
export const GREEN = abgr(0x3c, 0xff, 0xa0);
export const BLUE = abgr(0x3d, 0x8b, 0xff);
export const WHITE = abgr(0xff, 0xff, 0xff);
export const DIM = abgr(0x6c, 0x7a, 0x8c);
export const CLEAR = abgr(0, 0, 0, 0);

/** The three primaries in the order the MV introduces them. */
export const PRIMARIES = [BLUE, GREEN, RED] as const;

/** Same color, scaled alpha — the per-frame fade knob for a packed color. */
export const fade = (color: number, alpha: number): number => {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return ((color & 0x00ff_ffff) | (a << 24)) >>> 0;
};

/** Linear blend of two packed colors, alpha included. */
export const blend = (from: number, to: number, t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  const lerp = (shift: number): number =>
    Math.round((((from >>> shift) & 255) * (1 - k)) + (((to >>> shift) & 255) * k));
  return abgr(lerp(0), lerp(8), lerp(16), lerp(24));
};

// ---------------------------------------------------------------------------
// Scenes — seven cuts, each pinned to a bar of the arrangement.
// ---------------------------------------------------------------------------

export type SceneName = "ignite" | "lanes" | "prism" | "chorus" | "hardware" | "pixels" | "finale";

interface Cut {
  readonly bar: number;
  readonly scene: SceneName;
}

const CUTS: readonly Cut[] = [
  { bar: 0, scene: "ignite" }, //   intro: one dot splits into three
  { bar: 4, scene: "lanes" }, //    verse: three framework lanes
  { bar: 12, scene: "prism" }, //   pre-chorus: the lanes converge
  { bar: 16, scene: "chorus" }, //  chorus: the native tree and the claims
  { bar: 24, scene: "hardware" }, // break: the hardware the same bundle runs on
  { bar: 28, scene: "pixels" }, //  bridge: subpixels, the literal three primaries
  { bar: 32, scene: "finale" }, //  final chorus: convergence to white, end card
];

export const sceneAt = (frame: number): SceneName => {
  const bar = Math.floor(frame / BAR);
  let scene: SceneName = CUTS[0].scene;
  for (const cut of CUTS) {
    if (cut.bar <= bar) scene = cut.scene;
  }
  return scene;
};

/** Tick at which the scene holding `frame` started — every scene animates
 *  from its own zero, so a scene body never has to know its absolute bar. */
export const sceneStart = (frame: number): number => {
  const bar = Math.floor(frame / BAR);
  let start = 0;
  for (const cut of CUTS) {
    if (cut.bar <= bar) start = cut.bar * BAR;
  }
  return start;
};

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 0 before `from`, 1 after `to`, linear between — the scene's scrub bar. */
export const ramp = (frame: number, from: number, to: number): number =>
  clamp01((frame - from) / (to - from));

export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeIn = (t: number): number => t * t * t;
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
/** Overshoots past 1 and settles — the slam every chorus title lands with. */
export const easeOutBack = (t: number): number =>
  1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/** Position inside a repeating period, 0 at each boundary. */
export const phase = (frame: number, period: number): number =>
  ((frame % period) + period) % period / period;

/** 1 on the strike, decaying to 0 across the period — the beat envelope. */
export const beatPulse = (frame: number, period = BEAT, decay = 5): number =>
  Math.exp(-phase(frame, period) * decay);

/** Deterministic hash in 0..1 — stand-in for randomness the goldens can pin. */
export const hash = (n: number): number => {
  let value = (n * 0x9e37_79b1) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x85eb_ca6b) >>> 0;
  value ^= value >>> 13;
  return (value >>> 0) / 0xffff_ffff;
};
