<script setup lang="ts">
import { ActionHandler, AxisHandler, Text, View } from "@pocketjs/framework/vue-vapor/components";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
import { len } from "@pocketjs/framework/vue-vapor/std";
import { sensors, sample, offset, detail, status, updateSample, updateSensor, toggleDetail, reorder, resizeList, scroll } from "./app";
import SensorCard from "./SensorCard.vue";
</script>

<template>
  <View class="w-full h-full flex-col p-4 gap-2 bg-slate-950">
    <ActionHandler :button="BTN.CROSS" @press="updateSample()" />
    <ActionHandler :button="BTN.START" @press="updateSensor()" />
    <ActionHandler :button="BTN.TRIANGLE" @press="toggleDetail()" />
    <ActionHandler :button="BTN.SQUARE" @press="reorder()" />
    <ActionHandler :button="BTN.CIRCLE" @press="resizeList()" />
    <AxisHandler axis="primary" @delta="scroll($event)" />
    <View class="shrink-0 flex-row justify-between" :style="{ width: 448, height: 28 }">
      <Text class="text-lg text-white">Sensors</Text>
      <Text class="text-xs text-slate-400">Sample {{ sample }}</Text>
    </View>
    <View class="shrink-0 overflow-hidden" :style="{ width: 448, height: 160 }">
      <View class="flex-col gap-2" :style="{ translateY: -offset }">
        <SensorCard v-for="sensor in sensors" :key="sensor.id" :name="sensor.name" :value="sensor.value" />
      </View>
    </View>
    <View class="shrink-0 flex-row justify-between" :style="{ width: 448, height: 24 }">
      <Text class="text-xs text-slate-400">{{ status }}</Text>
      <Text v-if="detail" class="text-xs text-slate-400">{{ len(sensors) }} connected</Text>
    </View>
  </View>
</template>
