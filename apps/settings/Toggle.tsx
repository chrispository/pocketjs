import { Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import type { ThemeName } from "./app";
import { createToggle } from "./Toggle";

export default function Toggle(props: {
  label: string;
  initialValue: boolean;
  theme: ThemeName;
}) {
  const { value, knob, mountToggle, toggle } = createToggle(props.initialValue);
  onMount(() => mountToggle());
  return (
    <View
      debugName="Toggle"
      class={
        props.theme === "indigo"
          ? "flex-row items-center justify-between px-2 py-1 bg-white border-indigo-200 rounded-lg shadow focus:bg-indigo-50 focus:border-indigo-500 transition-colors duration-150"
          : props.theme === "emerald"
            ? "flex-row items-center justify-between px-2 py-1 bg-white border-emerald-200 rounded-lg shadow focus:bg-emerald-50 focus:border-emerald-500 transition-colors duration-150"
            : props.theme === "amber"
              ? "flex-row items-center justify-between px-2 py-1 bg-white border-amber-200 rounded-lg shadow focus:bg-amber-50 focus:border-amber-500 transition-colors duration-150"
              : "flex-row items-center justify-between px-2 py-1 bg-white border-rose-200 rounded-lg shadow focus:bg-rose-50 focus:border-rose-500 transition-colors duration-150"
      }
      focusable
      onPress={() => toggle()}
    >
      <Text
        class={
          props.theme === "indigo"
            ? "text-sm text-indigo-950"
            : props.theme === "emerald"
              ? "text-sm text-emerald-950"
              : props.theme === "amber"
                ? "text-sm text-amber-950"
                : "text-sm text-rose-950"
        }
      >
        {props.label}
      </Text>
      <View
        class={
          value()
            ? props.theme === "indigo"
              ? "w-9 h-5 rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 border-indigo-500 shadow flex-row items-center"
              : props.theme === "emerald"
                ? "w-9 h-5 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 border-emerald-500 shadow flex-row items-center"
                : props.theme === "amber"
                  ? "w-9 h-5 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 border-amber-500 shadow flex-row items-center"
                  : "w-9 h-5 rounded-full bg-gradient-to-r from-rose-400 to-rose-600 border-rose-500 shadow flex-row items-center"
            : props.theme === "indigo"
              ? "w-9 h-5 rounded-full bg-gradient-to-r from-indigo-100 to-indigo-200 border-indigo-200 shadow flex-row items-center"
              : props.theme === "emerald"
                ? "w-9 h-5 rounded-full bg-gradient-to-r from-emerald-100 to-emerald-200 border-emerald-200 shadow flex-row items-center"
                : props.theme === "amber"
                  ? "w-9 h-5 rounded-full bg-gradient-to-r from-amber-100 to-amber-200 border-amber-200 shadow flex-row items-center"
                  : "w-9 h-5 rounded-full bg-gradient-to-r from-rose-100 to-rose-200 border-rose-200 shadow flex-row items-center"
        }
      >
        <View
          ref={knob}
          class={
            props.theme === "indigo"
              ? "w-4 h-4 rounded-full bg-white border-indigo-200 shadow-md m-[2] translate-x-[0.5]"
              : props.theme === "emerald"
                ? "w-4 h-4 rounded-full bg-white border-emerald-200 shadow-md m-[2] translate-x-[0.5]"
                : props.theme === "amber"
                  ? "w-4 h-4 rounded-full bg-white border-amber-200 shadow-md m-[2] translate-x-[0.5]"
                  : "w-4 h-4 rounded-full bg-white border-rose-200 shadow-md m-[2] translate-x-[0.5]"
          }
        />
      </View>
    </View>
  );
}
