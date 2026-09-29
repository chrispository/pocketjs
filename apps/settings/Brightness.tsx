import { Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import type { ThemeName } from "./app";
import { createBrightness } from "./Brightness";

export default function Brightness(props: { theme: ThemeName }) {
  const { level, fill, thumb, mountBrightness, cycle } = createBrightness();
  onMount(() => mountBrightness());
  return (
    <View
      debugName="Brightness"
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
      onPress={() => cycle()}
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
        BRIGHTNESS
      </Text>
      <View class="flex-row items-center gap-2">
        <View
          class={
            props.theme === "indigo"
              ? "relative w-[120] h-3 rounded-full bg-indigo-100 border-indigo-200 shadow overflow-hidden"
              : props.theme === "emerald"
                ? "relative w-[120] h-3 rounded-full bg-emerald-100 border-emerald-200 shadow overflow-hidden"
                : props.theme === "amber"
                  ? "relative w-[120] h-3 rounded-full bg-amber-100 border-amber-200 shadow overflow-hidden"
                  : "relative w-[120] h-3 rounded-full bg-rose-100 border-rose-200 shadow overflow-hidden"
          }
        >
          <View
            ref={fill}
            class={
              props.theme === "indigo"
                ? "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600"
                : props.theme === "emerald"
                  ? "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600"
                  : props.theme === "amber"
                    ? "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-amber-400 to-amber-600"
                    : "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-rose-400 to-rose-600"
            }
            style={{ scaleX: 0.6, translateX: -24 }}
          />
          <View
            ref={thumb}
            class={
              props.theme === "indigo"
                ? "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-indigo-500 shadow-md translate-x-[64]"
                : props.theme === "emerald"
                  ? "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-emerald-500 shadow-md translate-x-[64]"
                  : props.theme === "amber"
                    ? "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-amber-500 shadow-md translate-x-[64]"
                    : "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-rose-500 shadow-md translate-x-[64]"
            }
            style={{ translateX: 64 }}
          />
        </View>
        <View class="w-9 flex-row justify-end">
          <Text
            class={
              props.theme === "indigo"
                ? "text-xs text-indigo-700"
                : props.theme === "emerald"
                  ? "text-xs text-emerald-700"
                  : props.theme === "amber"
                    ? "text-xs text-amber-700"
                    : "text-xs text-rose-700"
            }
          >
            {level()}/5
          </Text>
        </View>
      </View>
    </View>
  );
}
