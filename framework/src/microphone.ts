// Framework-agnostic access to host microphone capture. This input module is
// intentionally separate from audio-api.ts, which owns playback.

import { MICROPHONE_SAMPLE_FORMAT, MICROPHONE_SAMPLE_RATE } from "../../contracts/spec/microphone.ts";

export { MICROPHONE_SAMPLE_FORMAT, MICROPHONE_SAMPLE_RATE };

/** Native microphone operations mounted by a host that advertises
 *  `audio.capture`. Each read returns newly copied PCM bytes, or an empty view
 *  when no samples have arrived since the previous read. */
export interface MicrophoneOps {
  start(): boolean;
  read(): ArrayBuffer | Uint8Array;
  stop(): void;
}

/** The microphone namespace, or null when this build's host has no capture
 *  input. The lookup stays live so a host may mount it before app evaluation. */
export function microphoneHost(): (MicrophoneOps & { read(): Uint8Array }) | null {
  const ns = (globalThis as { microphone?: unknown }).microphone;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as MicrophoneOps;
  if (typeof ops.start !== "function" || typeof ops.read !== "function" || typeof ops.stop !== "function") return null;
  return {
    start: () => ops.start(),
    read: () => {
      const data = ops.read();
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    },
    stop: () => ops.stop(),
  };
}
