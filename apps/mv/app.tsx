// apps/mv/app.tsx — "PRIMARY LIGHT", a promotional music video that is itself
// a PocketJS application. The Rust core draws every frame of it; nothing here
// is a rendered movie being played back.
//
// The tick counter is the transport. `frame` advances once per core tick and
// wraps at apps/mv/timeline.ts `TOTAL` (3840 ticks = 64 s at 150 BPM), the
// scene table picks the cut, and every scene derives its whole picture from
// that one number. The audio module streams the track the same counter was
// written against (apps/mv/gen-assets.ts), so the cuts land on the beat
// WITHOUT the app ever asking the audio clock where it is — a host with no
// audio module renders byte-identical pixels in silence.
//
// CROSS pauses and resumes; nothing else reads input. With the picture a pure
// function of the counter, seeking is assignment, which is what lets
// site/record-mv.ts render the same 3840 frames headlessly.

import { createMemo, createSignal, Index, Match, Switch } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createWavPlayer } from "@pocketjs/framework/audio";
import { Chorus, Finale, Hardware, Ignite, Lanes, Pixels, Prism } from "./scenes.tsx";
import { Box } from "./stage.tsx";
import { BEAT, PRIMARIES, TOTAL, beatPulse, fade, sceneAt, sceneStart } from "./timeline.ts";

/** pak key suffix: audio:wav.<name> (see apps/mv/pak.json + gen-assets.ts). */
const TRACK = "primary-light";

/** Thirds of the top and bottom edge rules — one per primary. */
const EDGE_SEGMENTS = [0, 1, 2];

export default function Mv() {
  const [frame, setFrame] = createSignal(0);
  const [paused, setPaused] = createSignal(false);

  // Real playback where the host mounts the audio module; a silent no-op
  // everywhere else. The counter below never follows the player.
  const player = createWavPlayer();
  player.load(TRACK);
  player.play();

  onButtonPress(BTN.CROSS, () => {
    const next = !paused();
    setPaused(next);
    if (next) player.pause();
    else player.play();
  });

  onFrame(() => {
    player.pump(); // drain this tick's event batch, feed within credit
    if (paused()) return;
    const next = frame() + 1;
    if (next < TOTAL) {
      setFrame(next);
      return;
    }
    // Loop from the top: rewind the picture and re-cue the same track.
    setFrame(0);
    player.load(TRACK);
    player.play();
  });

  // One lookup per tick, and one scene body mounted at a time.
  const scene = createMemo(() => sceneAt(frame()));
  const local = () => frame() - sceneStart(frame());

  return (
    <View debugName="Mv" class="relative w-full h-full overflow-hidden bg-[#05070d]">
      <Switch>
        <Match when={scene() === "ignite"}>
          <Ignite f={local()} />
        </Match>
        <Match when={scene() === "lanes"}>
          <Lanes f={local()} />
        </Match>
        <Match when={scene() === "prism"}>
          <Prism f={local()} />
        </Match>
        <Match when={scene() === "chorus"}>
          <Chorus f={local()} />
        </Match>
        <Match when={scene() === "hardware"}>
          <Hardware f={local()} />
        </Match>
        <Match when={scene() === "pixels"}>
          <Pixels f={local()} />
        </Match>
        <Match when={scene() === "finale"}>
          <Finale f={local()} />
        </Match>
      </Switch>

      {/* The signature: three primaries across both edges, breathing on the
          beat. It is the only element that survives every cut, including the
          white flashes, so the frame reads as one piece for all 64 seconds. */}
      <Index each={EDGE_SEGMENTS}>
        {(segment) => {
          const i = segment();
          const lit = () => 0.3 + 0.6 * beatPulse(frame() - i * 6, BEAT, 5);
          return (
            <>
              <Box
                debugName="EdgeTop"
                style={{ insetL: i * 160, insetT: 0, width: 160, height: 3, bgColor: fade(PRIMARIES[i], lit()) }}
              />
              <Box
                debugName="EdgeBottom"
                style={{ insetL: i * 160, insetT: 269, width: 160, height: 3, bgColor: fade(PRIMARIES[2 - i], lit()) }}
              />
            </>
          );
        }}
      </Index>
    </View>
  );
}
