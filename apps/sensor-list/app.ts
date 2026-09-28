import { computed, ref } from "vue";
import { clamp, idiv, imod, len, map, type i32 } from "@pocketjs/framework/vue-vapor/std";

export interface Sensor { id: i32; name: string; value: i32 }
export const sensors = ref<Sensor[]>([
  { id: 1, name: "Greenhouse", value: 24 },
  { id: 2, name: "Workshop", value: 21 },
  { id: 3, name: "Outside", value: 18 },
]);
export const sample = ref<i32>(0);
export const offset = ref<i32>(0);
export const detail = ref(true);
export const status = computed<string>(() => imod(sample.value, 2) === 0 ? "" : "Sample received");

export function updateSample(): void {
  sample.value += 1;
  sensors.value = map(sensors.value, (sensor, index) => ({ id: sensor.id, name: sensor.name, value: sensor.value + (index === 0 ? 1 : 0) }));
}
export function updateSensor(): void {
  sensors.value = map(sensors.value, (sensor, index) => ({ id: sensor.id, name: sensor.name, value: sensor.value + (index === 0 ? 1 : 0) }));
}
export function toggleDetail(): void { detail.value = !detail.value; }
export function reorder(): void {
  sensors.value = map(sensors.value, (sensor, index) => sensors.value[len(sensors.value) - index - 1]);
}
export function resizeList(): void {
  if (len(sensors.value) > 2) sensors.value = [sensors.value[0], sensors.value[1]];
  else sensors.value = [sensors.value[0], sensors.value[1], { id: 4, name: "Storage", value: 16 }];
}
export function scroll(delta: i32): void {
  offset.value = clamp(offset.value + idiv(delta, 1000), 0, 96);
}
