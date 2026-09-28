// apps/mv/stage.tsx — the four primitives every scene is built out of.
//
// Classes are frozen at build time (/docs/styling/), so an MV that repaints
// itself every tick cannot put its motion in class strings. Each primitive
// therefore pins ONE literal — position, font slot, alignment — and takes
// everything that moves through `style`, whose keys are spec PROP names and
// whose colors travel as packed u32 ABGR (apps/mv/timeline.ts `abgr`), so a
// frame's hot path allocates one plain object per node and no strings.
//
// Text is laid out full-width with `text-center`, which lets a scene place a
// line by its baseline alone and never measure a string.

import type { JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { RED, GREEN, BLUE, WHITE } from "./timeline.ts";

/** Spec PROP names to values — the per-frame channel of every node here. */
export type Style = Record<string, number>;

/** An absolutely positioned rectangle. Width, height, offset, color, radius,
 *  border and transform all arrive per frame through `style`. */
export function Box(props: { style: Style; debugName?: string }): JSX.Element {
  return <View debugName={props.debugName} class="absolute left-0 top-0" style={props.style} />;
}

/** A full-width centered line. `style` carries insetT, textColor and opacity. */
export function Caption(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 w-[480] text-center text-xs font-bold tracking-wide" style={props.style}>
      {props.text}
    </Text>
  );
}

/** A full-width centered monospace line, for the numeric facts. */
export function Mono(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 w-[480] text-center text-xs font-mono" style={props.style}>
      {props.text}
    </Text>
  );
}

/** A label placed by its own top-left corner, sized to its text. */
export function Label(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 text-xs font-bold" style={props.style}>
      {props.text}
    </Text>
  );
}

/** A label centered inside a column `style.width` wide — the device captions. */
export function CellLabel(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 text-center text-xs font-bold" style={props.style}>
      {props.text}
    </Text>
  );
}

/** The monospace half of a device caption: its logical viewport. */
export function CellMono(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 text-center text-xs font-mono" style={props.style}>
      {props.text}
    </Text>
  );
}

/** The 20px line under a title. */
export function Sub(props: { text: string; style: Style }): JSX.Element {
  return (
    <Text class="absolute left-0 top-0 w-[480] text-center text-xl font-bold" style={props.style}>
      {props.text}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Split type — the chromatic fringe the whole MV is named after.
//
// Four copies of the same line: red pulled left, green pushed down-right, blue
// pushed right, white on top. The three primaries are only visible where the
// white glyph does not cover them, so the fringe rides the letterforms and the
// word stays readable at any split distance.
// ---------------------------------------------------------------------------

interface SplitProps {
  readonly text: string;
  /** Baseline, in screen pixels. */
  readonly y: number;
  /** Fringe distance in px. 0 collapses the four copies into plain white. */
  readonly split: number;
  readonly opacity: number;
  readonly scale: number;
}

const ghost = (props: SplitProps, dx: number, dy: number, color: number): Style => ({
  insetT: props.y + dy,
  translateX: dx,
  textColor: color,
  opacity: props.opacity,
  scale: props.scale,
});

/** 36px title. */
export function Title(props: SplitProps): JSX.Element {
  const cls = "absolute left-0 top-0 w-[480] text-center text-4xl font-bold";
  return (
    <>
      <Text class={cls} style={ghost(props, -props.split, 0, RED)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, props.split * 0.5, props.split * 0.5, GREEN)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, props.split, 0, BLUE)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, 0, 0, WHITE)}>{props.text}</Text>
    </>
  );
}

/** 54px wordmark. The same four copies, one font slot up. */
export function Wordmark(props: SplitProps): JSX.Element {
  const cls = "absolute left-0 top-0 w-[480] text-center text-5xl font-bold";
  return (
    <>
      <Text class={cls} style={ghost(props, -props.split, 0, RED)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, props.split * 0.5, props.split * 0.5, GREEN)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, props.split, 0, BLUE)}>{props.text}</Text>
      <Text class={cls} style={ghost(props, 0, 0, WHITE)}>{props.text}</Text>
    </>
  );
}
