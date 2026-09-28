<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

const props = defineProps<{ name: string; value: i32 }>();
</script>

<template>
  <View debug-name="SensorCard" focusable class="shrink-0 flex-row items-center justify-between p-3 rounded-lg bg-slate-800 focus:bg-slate-700" :style="{ width: 448, height: 64 }">
    <View class="flex-col gap-1">
      <Text class="text-sm text-white">{{ props.name }}</Text>
      <Text class="text-xs text-slate-400">Temperature</Text>
    </View>
    <View class="flex-row gap-2 items-center">
      <Text class="w-12 h-7 text-lg text-cyan-300">{{ props.value }}</Text>
      <Text class="text-xs text-slate-400">C</Text>
    </View>
  </View>
</template>
