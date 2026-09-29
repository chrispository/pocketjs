import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import type { i32 } from "@pocketjs/framework/solid/std";

export function createToggle(initialValue: boolean) {
  const [value, setValue] = createSignal(initialValue);
  const knob = createNodeRef();

  function mountToggle(): void {
    animate(knob, "translateX", value() ? 15.5 : 0.5, { dur: 1 as i32, easing: "out" });
  }

  function toggle(): void {
    setValue(!value());
    animate(knob, "translateX", value() ? 15.5 : 0.5, { dur: 160 as i32, easing: "out" });
  }

  return { value, knob, mountToggle, toggle };
}
