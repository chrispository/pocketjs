// The MV's one structural claim, pinned: the TICK COUNTER is the transport.
//
// apps/mv derives every pixel from a frame counter that nothing but the core
// clock advances, and streams apps/mv/media/primary-light.wav beside it
// without ever asking the audio clock where it is. Two consequences follow,
// and both are checked here against the REAL bundle (dist/mv-main.js) driven
// through the whole 64-second piece:
//
//   1. Mounting the audio module cannot move a pixel. If it ever could, the
//      beat-locked cuts would be following playback instead of the clock, and
//      the offline render (site/record-mv.ts, which has no audio module at
//      all) would stop matching what a device shows.
//   2. One stream feeds 3840 ticks with no underrun, and the loop at the wrap
//      re-cues it without one either.
//
// Run: bun tools/build.ts mv-main && bun test --conditions=browser tests/mv-sim.test.ts

import { expect, test } from "bun:test";
import { bootWorld, fnv1a } from "../hosts/sim/sim.ts";
import { createSimAudioSink, type SimAudioSink } from "../hosts/sim/audio.ts";
import { TOTAL } from "../apps/mv/timeline.ts";

/** One tick past the piece, so the run covers the wrap back to the top. */
const TICKS = TOTAL + 1;
/** Sample every 40 ticks: 97 hashes spread over all seven scenes. */
const SAMPLE = 40;

interface Run {
  /** fnv1a of the RGBA frame at every SAMPLE-th tick, plus both wrap ticks. */
  readonly hashes: string[];
  readonly sink: SimAudioSink | null;
}

async function runMv(withAudio: boolean): Promise<Run> {
  const sink = withAudio ? createSimAudioSink() : null;
  const world = await bootWorld("mv-main", 60, sink ? { audio: sink.ns } : undefined);
  const hashes: string[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    world.frame(0); // the MV reads no input; CROSS would pause it
    world.tick();
    sink?.tick(); // the virtual audio clock advances WITH the core clock
    if (tick % SAMPLE === 0 || tick === TICKS - 1) hashes.push(fnv1a(world.render()));
  }
  return { hashes, sink };
}

test("pixels are byte-identical with and without the audio module", async () => {
  const withAudio = await runMv(true);
  const silent = await runMv(false);
  expect(withAudio.hashes.length).toBeGreaterThan(90);
  expect(silent.hashes).toEqual(withAudio.hashes);
  // Not a still frame held for 64 seconds: the samples really do differ.
  expect(new Set(withAudio.hashes).size).toBeGreaterThan(80);
}, 120_000);

test("the loop returns the picture to the top", async () => {
  const { hashes } = await runMv(false);
  // Tick 0 leaves frame 1 on screen and tick TOTAL leaves frame 1 again, so
  // the first and last samples are the same picture iff the wrap is clean.
  expect(hashes[hashes.length - 1]).toBe(hashes[0]);
}, 120_000);

test("one stream feeds the whole piece without an underrun", async () => {
  const a = await runMv(true);
  const b = await runMv(true);
  const sink = a.sink!;
  expect(sink.log.filter((line) => line.startsWith("op createStream")))
    .toEqual(["op createStream 22050 1", "op createStream 22050 1"]); // the second is the loop's re-cue
  expect(sink.log.some((line) => line.includes('"underrun"'))).toBe(false);
  // 64 s at 22.05 kHz, minus the tail still in the ring at the final tick.
  expect(sink.consumedFrames()).toBeGreaterThan(64 * 22_050 - 1_000);
  // Byte-exact reproducibility: consumed PCM, op order, event order.
  expect(b.sink!.pcmHash()).toBe(sink.pcmHash());
  expect(b.sink!.log).toEqual(sink.log);
}, 120_000);
