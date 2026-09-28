// site/record-mv.ts — renders apps/mv ("PRIMARY LIGHT") to the distributable
// MV file. Same headless path as site/record-sim-clips.ts and tools/tape.ts:
// the wasm core draws every frame, the raw RGBA goes straight into ffmpeg, and
// the app's own committed WAV (apps/mv/media) becomes the audio track. No
// screen capture, no camera, no compositing outside the engine.
//
//   bun site/record-mv.ts                     # MV + poster -> site/assets
//   bun site/record-mv.ts --out=/tmp/mv.mp4   # elsewhere (poster alongside)
//   bun site/record-mv.ts --stills=0,384,1536 # those ticks as PNGs, no video
//
// The video is 60 fps because the app is authored at the 60 Hz core tick: one
// encoded frame per tick keeps the beat-locked cuts exactly where the app put
// them. 480x272 is nearest-neighbour quadrupled to 1920x1088, the same integer
// blowup site/bake-demo-wall.ts ships: the app's manifest declares
// `integer-fit`, so scaling by a whole number with no resampling IS the
// presentation it asks for, and every output pixel belongs to exactly one
// core pixel.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import { encodePNG } from "../tests/png.ts";
import { HZ, TOTAL } from "../apps/mv/timeline.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = "mv-main";
const BUILD_DIST = ROOT + "site/.cache/mv/build/";
const STILL_DIR = ROOT + "site/.cache/mv/stills/";
const WASM_PATH = ROOT + "hosts/web/pocketjs.wasm";
const TRACK = ROOT + "apps/mv/media/primary-light.wav";
const DEFAULT_OUT = ROOT + "site/assets/pocketjs-mv.mp4";

const FPS = HZ; // one encoded frame per core tick
const SCALE = 4; // 480x272 -> 1920x1088, nearest neighbour, no padding
/** Poster frame: the wordmark lockup scene 1 settles on, held through bar 3. */
const POSTER_TICK = 340;

function buildApp(): string {
  rmSync(BUILD_DIST, { recursive: true, force: true });
  mkdirSync(BUILD_DIST, { recursive: true });
  const build = Bun.spawnSync(["bun", "tools/build.ts", APP, `--outdir=${BUILD_DIST}`], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0 || !existsSync(BUILD_DIST + APP + ".js")) {
    throw new Error("record-mv: build failed");
  }
  return BUILD_DIST;
}

/** Same boot dance as tools/tape.ts — fresh core, bundle installs frame(). */
async function boot(dist: string) {
  if (!existsSync(WASM_PATH)) {
    const wasm = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (wasm.exitCode !== 0) throw new Error("record-mv: wasm build failed");
  }
  const core = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  g.ui = core.ops;
  g.__pak = existsSync(dist + APP + ".pak") ? await Bun.file(dist + APP + ".pak").arrayBuffer() : undefined;
  g.frame = undefined;
  g.__pocketApp = APP;
  (0, eval)(await Bun.file(dist + APP + ".js").text());
  const frame = g.frame as ((buttons: number) => void) | undefined;
  if (typeof frame !== "function") throw new Error("record-mv: the bundle did not install globalThis.frame");
  return { frame, tick: core.tick, render: () => core.render() };
}

function rgbaFrame(render: () => Uint8Array): Uint8Array {
  const rgba = render();
  const expected = SCREEN_W * SCREEN_H * 4;
  if (rgba.byteLength !== expected) {
    throw new Error(`record-mv: ${rgba.byteLength} RGBA bytes, expected ${expected}`);
  }
  return rgba;
}

/** Ticks named on the command line, written as PNGs for frame-by-frame review. */
async function recordStills(ticks: readonly number[]): Promise<void> {
  const core = await boot(buildApp());
  rmSync(STILL_DIR, { recursive: true, force: true });
  mkdirSync(STILL_DIR, { recursive: true });
  const wanted = new Set(ticks);
  const last = Math.max(...ticks);
  for (let f = 0; f <= last; f++) {
    core.frame(0);
    core.tick();
    if (!wanted.has(f)) continue;
    const path = `${STILL_DIR}${String(f).padStart(4, "0")}.png`;
    await Bun.write(path, encodePNG(rgbaFrame(core.render), SCREEN_W, SCREEN_H));
    console.log(`record-mv: ${path.slice(ROOT.length)}`);
  }
}

async function recordVideo(out: string): Promise<void> {
  const core = await boot(buildApp());
  const directory = out.slice(0, out.lastIndexOf("/"));
  if (directory) mkdirSync(directory, { recursive: true });
  const ff = Bun.spawn(
    ["ffmpeg", "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${SCREEN_W}x${SCREEN_H}`, "-framerate", String(FPS), "-i", "-",
      "-i", TRACK,
      "-filter_complex",
      `[0:v]scale=${SCREEN_W * SCALE}:${SCREEN_H * SCALE}:flags=neighbor,format=yuv420p[v]`,
      "-map", "[v]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-profile:v", "high", "-level", "4.2",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart", "-shortest", out],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  let poster: Uint8Array | undefined;
  for (let f = 0; f < TOTAL; f++) {
    core.frame(0);
    core.tick();
    const rgba = rgbaFrame(core.render);
    if (f === POSTER_TICK) poster = rgba.slice();
    ff.stdin.write(rgba);
    await ff.stdin.flush();
  }
  await ff.stdin.end();
  if ((await ff.exited) !== 0) throw new Error("record-mv: ffmpeg failed");
  const size = Bun.file(out).size;
  console.log(
    `record-mv: ${out.slice(ROOT.length)} — ${TOTAL} ticks, ${(TOTAL / FPS).toFixed(3)} s, ` +
      `${SCREEN_W * SCALE}x${SCREEN_H * SCALE} @ ${FPS} fps, ${(size / 1024 / 1024).toFixed(2)} MiB`,
  );
  if (poster) await writePoster(poster, out.replace(/\.mp4$/, ".jpg"));
}

/** First-paint poster, encoded from the very RGBA the core produced for that
 *  tick rather than seeked back out of the finished h264. */
async function writePoster(rgba: Uint8Array, out: string): Promise<void> {
  const ff = Bun.spawn(
    ["ffmpeg", "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${SCREEN_W}x${SCREEN_H}`, "-i", "-",
      "-vf", `scale=${SCREEN_W * SCALE}:${SCREEN_H * SCALE}:flags=neighbor`,
      "-frames:v", "1", "-q:v", "3", out],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  ff.stdin.write(rgba);
  await ff.stdin.end();
  if ((await ff.exited) !== 0) throw new Error("record-mv: poster encode failed");
  console.log(`record-mv: ${out.slice(ROOT.length)} — tick ${POSTER_TICK}, ${(Bun.file(out).size / 1024).toFixed(0)} KiB`);
}

if (import.meta.main) {
  const stills = process.argv.find((argument) => argument.startsWith("--stills="));
  if (stills) {
    const ticks = stills.slice("--stills=".length).split(",").map(Number);
    if (ticks.some((tick) => !Number.isInteger(tick) || tick < 0 || tick >= TOTAL)) {
      throw new Error(`record-mv: --stills wants ticks in 0..${TOTAL - 1}`);
    }
    await recordStills(ticks);
  } else {
    const out = process.argv.find((argument) => argument.startsWith("--out="));
    await recordVideo(out ? out.slice("--out=".length) : DEFAULT_OUT);
  }
}
