// Deterministically synthesize "PRIMARY LIGHT" — the original 64-second track
// the MV app streams through the audio module (contracts/spec/audio.ts). No
// downloaded or copyrighted recordings: every sample comes out of the
// oscillators below. Same synth architecture as apps/music/gen-assets.ts,
// grown into a full arrangement (lead, arpeggio, bass, pad, drum kit, delay).
//
//   bun apps/mv/gen-assets.ts     # rewrites apps/mv/media/primary-light.wav
//
// The output is committed (pak.json splices it verbatim; the build never runs
// this). Exactly 64.000 s at 22 050 Hz mono s16 — 150 BPM, so one beat is 24
// ticks and one bar is 96 ticks at the 60 Hz core clock. apps/mv/timeline.ts
// carries the same grid, which is what keeps every cut in app.tsx landing on
// a beat: the visuals and the waveform are two readings of one bar table.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 22_050;
const BPM = 150;
const BEATS_PER_BAR = 4;
const BARS = 40;
const SECONDS_PER_BEAT = 60 / BPM; // 0.4
const SECONDS_PER_BAR = SECONDS_PER_BEAT * BEATS_PER_BAR; // 1.6
const DURATION_SECONDS = BARS * SECONDS_PER_BAR; // 64
const SAMPLES = Math.round(SAMPLE_RATE * DURATION_SECONDS);
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "media");

// ---------------------------------------------------------------------------
// Harmony — one chord per bar on a four-bar loop, I-V-vi-IV in G major.
// ---------------------------------------------------------------------------

interface Chord {
  /** Bass root, one octave of pumping eighths built on it. */
  readonly bass: string;
  /** Four ascending arpeggio voices, low to high. */
  readonly arp: readonly string[];
  /** Sustained pad triad. */
  readonly pad: readonly string[];
}

const PROGRESSION: readonly Chord[] = [
  { bass: "G2", arp: ["G3", "B3", "D4", "G4"], pad: ["G3", "B3", "D4"] },
  { bass: "D2", arp: ["D3", "F#3", "A3", "D4"], pad: ["F#3", "A3", "D4"] },
  { bass: "E2", arp: ["E3", "G3", "B3", "E4"], pad: ["G3", "B3", "E4"] },
  { bass: "C2", arp: ["C3", "E3", "G3", "C4"], pad: ["E3", "G3", "C4"] },
];

// ---------------------------------------------------------------------------
// Lead — eight eighth notes per bar, one string per bar. "." rests and "-"
// holds the previous note through that slot.
// ---------------------------------------------------------------------------

const LEAD: readonly string[] = [
  // 0-3 intro: the hook's first phrase, alone and unaccompanied.
  ". . . . . . . .",
  ". . . . . . . .",
  "D5 . . . B4 . . .",
  "G4 . . . - - . .",
  // 4-11 verse: two four-bar phrases, the second a fourth higher.
  "B4 B4 A4 B4 D5 . B4 .",
  "A4 A4 B4 A4 F#4 . A4 .",
  "G4 G4 B4 D5 E5 . D5 .",
  "E5 D5 B4 A4 G4 . - .",
  "D5 D5 B4 D5 G5 . D5 .",
  "C5 C5 A4 C5 F#5 . C5 .",
  "B4 D5 E5 G5 . E5 D5 .",
  "E5 D5 C5 B4 A4 . - .",
  // 12-15 pre-chorus: one rising figure per bar, topping out on the last.
  "G4 B4 D5 G5 . D5 B4 D5",
  "A4 C5 F#5 A5 . F#5 D5 F#5",
  "B4 D5 E5 G5 B5 . G5 E5",
  "C5 E5 G5 C6 . - - -",
  // 16-23 chorus: the hook, syncopated off every downbeat but the first.
  "D5 . G5 F#5 E5 D5 . B4",
  "A4 . D5 . F#5 A5 . F#5",
  "G5 . E5 . D5 B4 . D5",
  "E5 . G5 . A5 . G5 E5",
  "D5 . G5 F#5 E5 D5 . B4",
  "A4 . D5 . F#5 A5 . B5",
  "G5 . B5 . A5 G5 . E5",
  "D5 . E5 . G5 . - .",
  // 24-27 break: single stabs over the bare kit.
  "G5 . . . D5 . . .",
  "F#5 . . . A4 . . .",
  "E5 . . . B4 . . .",
  "C5 . . E5 . G5 . .",
  // 28-31 bridge: long tones, then the lift back into the final chorus.
  "B4 . - - - - . .",
  "A4 . - - - - . .",
  "G4 . - - B4 . - .",
  "C5 . - . D5 . E5 .",
  // 32-39 final chorus: the hook again, its last two bars carrying the outro.
  "D5 . G5 F#5 E5 D5 . B4",
  "A4 . D5 . F#5 A5 . F#5",
  "G5 . E5 . D5 B4 . D5",
  "E5 . G5 . A5 . G5 E5",
  "D5 . G5 F#5 E5 D5 . B4",
  "A4 . D5 . F#5 A5 . B5",
  "G5 . B5 . A5 G5 . D6",
  "G5 . - - - - - -",
];

// ---------------------------------------------------------------------------
// Arrangement — layer gains and a drum kit per bar, written as a sparse table
// where each entry holds from its bar until the next one.
// ---------------------------------------------------------------------------

type KitName = "none" | "half" | "beat" | "drive" | "full" | "roll";

interface Slice {
  readonly bar: number;
  readonly lead: number;
  readonly arp: number;
  readonly bass: number;
  readonly pad: number;
  readonly kit: KitName;
}

const ARRANGEMENT: readonly Slice[] = [
  { bar: 0, lead: 0.0, arp: 0.5, bass: 0.0, pad: 0.5, kit: "none" },
  { bar: 2, lead: 0.8, arp: 0.7, bass: 0.5, pad: 0.55, kit: "half" },
  { bar: 4, lead: 0.85, arp: 0.7, bass: 0.9, pad: 0.4, kit: "half" },
  { bar: 6, lead: 0.85, arp: 0.75, bass: 0.9, pad: 0.4, kit: "beat" },
  { bar: 8, lead: 0.9, arp: 0.8, bass: 0.95, pad: 0.4, kit: "beat" },
  { bar: 12, lead: 0.95, arp: 0.9, bass: 0.95, pad: 0.45, kit: "drive" },
  { bar: 15, lead: 0.95, arp: 0.9, bass: 0.6, pad: 0.45, kit: "roll" },
  { bar: 16, lead: 1.0, arp: 0.85, bass: 1.0, pad: 0.55, kit: "full" },
  { bar: 24, lead: 0.8, arp: 0.6, bass: 0.7, pad: 0.45, kit: "beat" },
  { bar: 28, lead: 0.7, arp: 0.3, bass: 0.3, pad: 0.75, kit: "none" },
  { bar: 31, lead: 0.85, arp: 0.85, bass: 0.7, pad: 0.6, kit: "roll" },
  { bar: 32, lead: 1.0, arp: 0.9, bass: 1.0, pad: 0.6, kit: "full" },
  { bar: 38, lead: 1.0, arp: 0.85, bass: 1.0, pad: 0.6, kit: "drive" },
  { bar: 39, lead: 0.9, arp: 0.0, bass: 0.7, pad: 0.7, kit: "none" },
];

/** Sixteenth grids, one character per step: "x" strikes, "." rests. */
const KITS: Record<KitName, { kick: string; snare: string; hat: string }> = {
  none: { kick: "................", snare: "................", hat: "................" },
  half: { kick: "x.......x.......", snare: "................", hat: "..x...x...x...x." },
  beat: { kick: "x.......x.......", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  drive: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  full: { kick: "x...x..xx...x...", snare: "....x.......x...", hat: "xxxxxxxxxxxxxxxx" },
  roll: { kick: "x...............", snare: "xxxxxxxxxxxxxxxx", hat: "................" },
};

function sliceAt(bar: number): Slice {
  let current = ARRANGEMENT[0];
  for (const slice of ARRANGEMENT) {
    if (slice.bar <= bar) current = slice;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Note names and oscillators
// ---------------------------------------------------------------------------

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "F#5" -> MIDI 78, with C4 = 60. */
function midiOf(name: string): number {
  const letter = SEMITONE[name[0]];
  if (letter === undefined) throw new Error(`gen-assets: bad note '${name}'`);
  const accidental = name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0;
  const octave = Number(name.slice(accidental === 0 ? 1 : 2));
  if (!Number.isInteger(octave)) throw new Error(`gen-assets: bad octave in '${name}'`);
  return 12 * (octave + 1) + letter + accidental;
}

const frequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const fract = (value: number): number => value - Math.floor(value);
const sine = (phase: number): number => Math.sin(Math.PI * 2 * phase);
const saw = (phase: number): number => 2 * fract(phase) - 1;
/** Pulse wave with its own mean removed, so a narrow duty adds no DC term. */
const square = (phase: number, duty: number): number =>
  (fract(phase) < duty ? 1 : -1) - (2 * duty - 1);
const triangle = (phase: number): number => 1 - 4 * Math.abs(fract(phase) - 0.5);

/** xorshift on the sample index: same buffer for the same seed, every run. */
function noise(sample: number, seed: number): number {
  let value = (sample ^ (seed * 0x9e37_79b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return ((value >>> 0) / 0xffff_ffff) * 2 - 1;
}

/** Linear attack/decay to a sustain floor, then a release tail past `dur`. */
function adsr(t: number, dur: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  if (t < dur + r) return s * (1 - (t - dur) / r);
  return 0;
}

// ---------------------------------------------------------------------------
// Voices — each returns one sample for a note `t` seconds old.
// ---------------------------------------------------------------------------

type Voice = (t: number, dur: number, f: number, sample: number) => number;

/** Detuned saw pair under a slow vibrato: the line that carries the melody. */
const leadVoice: Voice = (t, dur, f) => {
  const vibrato = 1 + 0.004 * Math.sin(Math.PI * 2 * 5.2 * t) * Math.min(1, t / 0.12);
  const phase = f * vibrato * t;
  const tone = saw(phase) * 0.5 + saw(phase * 1.006 + 0.31) * 0.32 + square(phase * 0.5, 0.5) * 0.18;
  return tone * adsr(t, dur, 0.006, 0.09, 0.62, 0.12);
};

/** Short plucked square: the sixteenth-note arpeggio behind everything. */
const arpVoice: Voice = (t, _dur, f) => {
  const phase = f * t;
  const tone = square(phase, 0.28) * 0.6 + saw(phase) * 0.4;
  return tone * Math.exp(-t * 9);
};

/** Sine root with a saw edge and one sub-octave, gated per eighth. */
const bassVoice: Voice = (t, dur, f) => {
  const phase = f * t;
  const tone = sine(phase) * 0.72 + saw(phase) * 0.2 + sine(phase * 0.5) * 0.18;
  return tone * adsr(t, dur, 0.004, 0.05, 0.75, 0.06);
};

/** Two triangles a few cents apart: the harmonic glue under the mix. */
const padVoice: Voice = (t, dur, f) => {
  const tone = triangle(f * t) * 0.5 + triangle(f * 1.004 * t + 0.5) * 0.5;
  return tone * adsr(t, dur, 0.22, 0.2, 0.82, 0.4);
};

const kickVoice: Voice = (t, _dur, _f, sample) => {
  const sweep = 48 + 112 * Math.exp(-t * 26);
  const body = sine(sweep * t) * Math.exp(-t * 9);
  const click = noise(sample, 7) * Math.exp(-t * 110) * 0.3;
  return body + click;
};

const snareVoice: Voice = (t, _dur, _f, sample) => {
  const rattle = noise(sample, 11) * Math.exp(-t * 17);
  const shell = sine(186 * t) * Math.exp(-t * 24) * 0.4;
  return rattle * 0.78 + shell;
};

const hatVoice: Voice = (t, _dur, _f, sample) => {
  // Two decorrelated noise taps subtracted: a one-sample difference is a
  // cheap high-pass, which is what keeps the hat out of the bass.
  const bright = noise(sample, 23) - noise(sample - 1, 23) * 0.5;
  return bright * Math.exp(-t * 52);
};

// ---------------------------------------------------------------------------
// Sequencing — the whole arrangement becomes one flat list of note events.
// ---------------------------------------------------------------------------

interface Event {
  readonly start: number; // seconds
  readonly dur: number; // seconds the envelope sustains
  readonly tail: number; // extra seconds the voice keeps ringing
  readonly frequency: number;
  readonly gain: number;
  readonly voice: Voice;
  /** Delay-bus sends go to the wet buffer; everything else stays dry. */
  readonly wet: boolean;
}

function sequence(): Event[] {
  const events: Event[] = [];
  const eighth = SECONDS_PER_BEAT / 2;
  const sixteenth = SECONDS_PER_BEAT / 4;

  for (let bar = 0; bar < BARS; bar++) {
    const barStart = bar * SECONDS_PER_BAR;
    const chord = PROGRESSION[bar % PROGRESSION.length];
    const mix = sliceAt(bar);

    // Lead: parse the bar's eight slots, merging "-" holds into one event.
    if (mix.lead > 0) {
      const slots = LEAD[bar].split(" ");
      if (slots.length !== 8) throw new Error(`gen-assets: bar ${bar} lead has ${slots.length} slots`);
      let held: { midi: number; start: number; slots: number } | null = null;
      const flush = () => {
        if (!held) return;
        const dur = held.slots * eighth * 0.92;
        events.push({
          start: held.start, dur, tail: 0.2,
          frequency: frequency(held.midi), gain: mix.lead * 0.3, voice: leadVoice, wet: true,
        });
        held = null;
      };
      for (const [index, slot] of slots.entries()) {
        if (slot === "-" && held) held.slots++;
        else if (slot === "." || slot === "-") flush();
        else {
          flush();
          held = { midi: midiOf(slot), start: barStart + index * eighth, slots: 1 };
        }
      }
      flush();
    }

    // Arpeggio: sixteen sixteenths climbing the chord's four voices.
    if (mix.arp > 0) {
      for (let step = 0; step < 16; step++) {
        const midi = midiOf(chord.arp[step % chord.arp.length]);
        // Every fourth pass lifts an octave, so the figure breathes over a bar.
        const octave = step >= 8 ? 12 : 0;
        events.push({
          start: barStart + step * sixteenth, dur: sixteenth * 0.5, tail: 0.14,
          frequency: frequency(midi + octave), gain: mix.arp * 0.13, voice: arpVoice, wet: true,
        });
      }
    }

    // Bass: pumping eighths, octave up on the off-beats of 2 and 4.
    if (mix.bass > 0) {
      const root = midiOf(chord.bass);
      const octaves = [0, 0, 12, 0, 0, 0, 12, 0];
      for (let step = 0; step < 8; step++) {
        events.push({
          start: barStart + step * eighth, dur: eighth * 0.7, tail: 0.1,
          frequency: frequency(root + octaves[step]), gain: mix.bass * 0.34, voice: bassVoice, wet: false,
        });
      }
    }

    // Pad: the triad held across the whole bar.
    if (mix.pad > 0) {
      for (const name of chord.pad) {
        events.push({
          start: barStart, dur: SECONDS_PER_BAR * 0.96, tail: 0.5,
          frequency: frequency(midiOf(name)), gain: mix.pad * 0.1, voice: padVoice, wet: false,
        });
      }
    }

    // Drums: three sixteenth grids. The roll kit ramps across its own bar,
    // which is what turns bars 15 and 31 into a lift instead of a texture.
    const kit = KITS[mix.kit];
    for (let step = 0; step < 16; step++) {
      const at = barStart + step * sixteenth;
      const ramp = mix.kit === "roll" ? 0.3 + 0.7 * (step / 15) : 1;
      if (kit.kick[step] === "x") {
        events.push({ start: at, dur: 0.05, tail: 0.4, frequency: 0, gain: 0.5, voice: kickVoice, wet: false });
      }
      if (kit.snare[step] === "x") {
        events.push({ start: at, dur: 0.03, tail: 0.3, frequency: 0, gain: 0.26 * ramp, voice: snareVoice, wet: false });
      }
      if (kit.hat[step] === "x") {
        // Accent the downbeat of each quarter so a sixteenth hat still swings.
        const accent = step % 4 === 0 ? 1 : 0.6;
        events.push({ start: at, dur: 0.02, tail: 0.12, frequency: 0, gain: 0.075 * accent, voice: hatVoice, wet: false });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): Int16Array {
  const dry = new Float32Array(SAMPLES);
  const wet = new Float32Array(SAMPLES);

  for (const event of sequence()) {
    const first = Math.round(event.start * SAMPLE_RATE);
    const last = Math.min(SAMPLES, Math.round((event.start + event.dur + event.tail) * SAMPLE_RATE));
    const bus = event.wet ? wet : dry;
    for (let sample = Math.max(0, first); sample < last; sample++) {
      const t = (sample - first) / SAMPLE_RATE;
      bus[sample] += event.voice(t, event.dur, event.frequency, sample) * event.gain;
    }
  }

  // Dotted-eighth feedback delay on the wet bus (lead + arpeggio). At 150 BPM
  // that is 0.3 s, so each echo lands on the following off-beat.
  const delaySamples = Math.round(SECONDS_PER_BEAT * 0.75 * SAMPLE_RATE);
  for (let sample = delaySamples; sample < SAMPLES; sample++) {
    wet[sample] += wet[sample - delaySamples] * 0.32;
  }

  const pcm = new Int16Array(SAMPLES);
  const fadeIn = 0.3 * SAMPLE_RATE;
  const fadeOut = 1.6 * SAMPLE_RATE;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const edge =
      Math.min(1, sample / fadeIn) * Math.min(1, (SAMPLES - sample) / fadeOut);
    // tanh normalized so unity in stays unity out: peaks round over instead
    // of clipping, and the mix keeps its headroom at the chorus.
    const mixed = (dry[sample] + wet[sample] * 0.86) * 1.35;
    const limited = Math.tanh(mixed) / Math.tanh(1);
    pcm[sample] = Math.round(Math.max(-1, Math.min(1, limited * edge)) * 30_000);
  }
  return pcm;
}

function wavBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

mkdirSync(OUT, { recursive: true });
const pcm = render();
let peak = 0;
let sumSquares = 0;
for (const sample of pcm) {
  peak = Math.max(peak, Math.abs(sample));
  sumSquares += sample * sample;
}
const path = join(OUT, "primary-light.wav");
await Bun.write(path, wavBytes(pcm));
console.log(
  `primary-light.wav: ${DURATION_SECONDS}s, ${BARS} bars @ ${BPM} BPM, ` +
    `${SAMPLE_RATE} Hz mono PCM, peak ${(peak / 32_768).toFixed(3)}, ` +
    `rms ${(Math.sqrt(sumSquares / pcm.length) / 32_768).toFixed(3)}`,
);
