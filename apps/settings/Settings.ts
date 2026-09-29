import { createSignal } from "solid-js";
import type { ThemeName } from "./app";

export function createSettings() {
  const [theme, setTheme] = createSignal<ThemeName>("indigo");

  function pickTheme(value: ThemeName): void {
    setTheme(value);
  }

  return { theme, pickTheme };
}
