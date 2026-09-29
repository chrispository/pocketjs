import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import type { f64, i32 } from "@pocketjs/framework/solid/std";

export function createBrightness() {
  const [level, setLevel] = createSignal<i32>(3);
  const fill = createNodeRef();
  const thumb = createNodeRef();

  function updateBrightness(duration: i32): void {
    const scale: f64 = level() / 5;
    const offset: f64 = -(120 * (1 - scale)) / 2;
    animate(fill, "scaleX", scale, { dur: duration, easing: "out" });
    animate(fill, "translateX", offset, { dur: duration, easing: "out" });
    animate(thumb, "translateX", level() * 24 - 8, { dur: duration, easing: "out" });
  }

  function mountBrightness(): void {
    updateBrightness(1);
  }

  function cycle(): void {
    setLevel(level() >= 5 ? 1 : level() + 1);
    updateBrightness(150);
  }

  return { level, fill, thumb, mountBrightness, cycle };
}
