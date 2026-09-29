import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import type { ThemeName } from "./app";

export default function ThemeRow(props: {
  value: ThemeName;
  onPick: (theme: ThemeName) => void;
}) {
  return (
    <View
      debugName="ThemeRow"
      class={
        props.value === "indigo"
          ? "flex-col gap-2 px-2 py-2 bg-white border-indigo-200 rounded-xl shadow-md"
          : props.value === "emerald"
            ? "flex-col gap-2 px-2 py-2 bg-white border-emerald-200 rounded-xl shadow-md"
            : props.value === "amber"
              ? "flex-col gap-2 px-2 py-2 bg-white border-amber-200 rounded-xl shadow-md"
              : "flex-col gap-2 px-2 py-2 bg-white border-rose-200 rounded-xl shadow-md"
      }
    >
      <Text
        class={
          props.value === "indigo"
            ? "text-sm text-indigo-950"
            : props.value === "emerald"
              ? "text-sm text-emerald-950"
              : props.value === "amber"
                ? "text-sm text-amber-950"
                : "text-sm text-rose-950"
        }
      >
        THEME
      </Text>
      <View class="flex-row gap-2">
        <View
          debugName="ThemeIndigo"
          class={
            props.value === "indigo"
              ? "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-indigo-500 to-indigo-700 border-indigo-950 transition-colors duration-150 items-center justify-center"
              : "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-indigo-500 to-indigo-700 border-indigo-300 focus:border-indigo-950 transition-colors duration-150 items-center justify-center"
          }
          focusable
          onPress={() => props.onPick("indigo")}
        >
          <Show when={props.value === "indigo"}>
            <View class="w-2 h-2 rounded-full bg-white shadow" />
          </Show>
        </View>
        <View
          debugName="ThemeEmerald"
          class={
            props.value === "emerald"
              ? "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-950 transition-colors duration-150 items-center justify-center"
              : "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-300 focus:border-emerald-950 transition-colors duration-150 items-center justify-center"
          }
          focusable
          onPress={() => props.onPick("emerald")}
        >
          <Show when={props.value === "emerald"}>
            <View class="w-2 h-2 rounded-full bg-white shadow" />
          </Show>
        </View>
        <View
          debugName="ThemeAmber"
          class={
            props.value === "amber"
              ? "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-amber-400 to-amber-600 border-amber-950 transition-colors duration-150 items-center justify-center"
              : "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-amber-400 to-amber-600 border-amber-300 focus:border-amber-950 transition-colors duration-150 items-center justify-center"
          }
          focusable
          onPress={() => props.onPick("amber")}
        >
          <Show when={props.value === "amber"}>
            <View class="w-2 h-2 rounded-full bg-white shadow" />
          </Show>
        </View>
        <View
          debugName="ThemeRose"
          class={
            props.value === "rose"
              ? "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-rose-400 to-rose-600 border-rose-950 transition-colors duration-150 items-center justify-center"
              : "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-rose-400 to-rose-600 border-rose-300 focus:border-rose-950 transition-colors duration-150 items-center justify-center"
          }
          focusable
          onPress={() => props.onPick("rose")}
        >
          <Show when={props.value === "rose"}>
            <View class="w-2 h-2 rounded-full bg-white shadow" />
          </Show>
        </View>
      </View>
    </View>
  );
}
