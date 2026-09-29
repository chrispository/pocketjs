import { Text, View } from "@pocketjs/framework/solid/components";
import { createSettings } from "./Settings";
import Brightness from "./Brightness.tsx";
import ThemeRow from "./ThemeRow.tsx";
import Toggle from "./Toggle.tsx";

export default function Settings() {
  const { theme, pickTheme } = createSettings();
  return (
    <View
      debugName="SettingsScreen"
      class={
        theme() === "indigo"
          ? "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-indigo-50 to-slate-100"
          : theme() === "emerald"
            ? "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-emerald-50 to-slate-100"
            : theme() === "amber"
              ? "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-amber-50 to-slate-100"
              : "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-rose-50 to-slate-100"
      }
    >
      <View debugName="Header" class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text
            class={
              theme() === "indigo"
                ? "text-xs text-indigo-600 tracking-wide"
                : theme() === "emerald"
                  ? "text-xs text-emerald-600 tracking-wide"
                  : theme() === "amber"
                    ? "text-xs text-amber-600 tracking-wide"
                    : "text-xs text-rose-600 tracking-wide"
            }
          >
            POCKETJS SHOWCASE
          </Text>
          <Text
            class={
              theme() === "indigo"
                ? "text-2xl text-indigo-700 font-bold"
                : theme() === "emerald"
                  ? "text-2xl text-emerald-700 font-bold"
                  : theme() === "amber"
                    ? "text-2xl text-amber-700 font-bold"
                    : "text-2xl text-rose-700 font-bold"
            }
          >
            Settings
          </Text>
        </View>
        <Text
          class={
            theme() === "indigo"
              ? "text-xs text-indigo-700"
              : theme() === "emerald"
                ? "text-xs text-emerald-700"
                : theme() === "amber"
                  ? "text-xs text-amber-700"
                  : "text-xs text-rose-700"
          }
        >
          4 OPTIONS
        </Text>
      </View>

      <View debugName="OptionsList" class="flex-col gap-2">
        <Toggle label="SOUND EFFECTS" initialValue={true} theme={theme()} />
        <Toggle label="VIBRATION" initialValue={false} theme={theme()} />
        <Brightness theme={theme()} />
        <ThemeRow value={theme()} onPick={pickTheme} />
      </View>

      <Text
        class={
          theme() === "indigo"
            ? "text-xs text-indigo-700"
            : theme() === "emerald"
              ? "text-xs text-emerald-700"
              : theme() === "amber"
                ? "text-xs text-amber-700"
                : "text-xs text-rose-700"
        }
      >
        UP / DOWN move focus · CIRCLE toggle / cycle / select
      </Text>
    </View>
  );
}
