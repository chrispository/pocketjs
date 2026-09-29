import { createSignal } from "solid-js";
import { copyRange, copyRect, embedBytes, fill, fillRange, fillRect, idiv, imod, len, push, removeAt, truncate, f32, f64, i8, i16, i32, i64, u8, u16, usize, type i32 as I32, type u8 as U8, type i8 as I8, type u16 as U16 } from "@pocketjs/framework/solid/std";
type Id = I32 & { readonly __newtype?: "Id" };
type Name = string & { readonly __newtype?: "Name" };
interface P { x: I32 }
interface E { tag?: I32 }
interface Bank { data: I32[] }
export const [result, setResult] = createSignal<I32[]>([]);
const NAMES: Name[] = ["ab", "c"];
const BYTES: U8[] = embedBytes("./bytes.bin");
let rows: I32[][] = [[1, 2, 3]];
let bank: Bank = { data: [1, 2, 3, 4, 5, 6] };
function bump(): I32 {
  rows[0] = [7, 8, 9];
  return 1;
}
export function press(): void {
  const out: I32[] = [];
  // Conversions follow the argument's static type: floats saturate, integers wrap.
  push(out, i32(f64(1e10)));
  push(out, i32(i8(f32(200))));
  push(out, i32(u8(i32(300))));
  push(out, i32(f64(usize(-1)) / f64(65536)));
  // Remainders by zero are zero.
  push(out, i32(i64(7) % i64(0)));
  // idiv and imod truncate toward zero; a zero divisor gives 0.
  const m = -7;
  push(out, imod(m, 2));
  push(out, idiv(m, 2));
  push(out, i32(idiv(i64(7), i64(0))));
  // 8- and 16-bit shifts run on 32-bit values.
  const a: U8 = u8(200), b: I8 = i8(-1), c: U16 = u16(1);
  push(out, i32(a >>> 8));
  push(out, i32(u8(1) << 8));
  push(out, i32(a >> 8));
  push(out, i32(b >>> 1));
  push(out, i32(i8(-128) >> 1));
  push(out, i32(c << 16));
  // for…of reads a copy of its source.
  const xs: I32[] = [1, 2];
  for (const v of xs) push(xs, v);
  push(out, len(xs));
  // Out-of-range removeAt returns the element type's default; a negative truncate clears.
  const empty: I32[] = [];
  push(out, removeAt(empty, 0) + 1);
  const ps: P[] = [];
  push(out, removeAt(ps, 3).x + 1);
  const t: I32[] = [1, 2, 3];
  truncate(t, -1);
  push(out, len(t));
  // fillRange and fillRect store a copy in each element.
  const qs: P[] = fill(4, { x: 0 });
  fillRange(qs, 0, 2, { x: 1 });
  fillRect(qs, 2, 1, 1, 2, { x: 2 });
  qs[0].x = 5;
  qs[2].x = 6;
  for (const q of qs) push(out, q.x);
  // An index that calls a function is evaluated after its row is read.
  push(out, rows[0][bump()]);
  // Optional fields of elements, in and out of range.
  const es: E[] = [{ tag: 4 }, {}];
  push(out, es[0].tag ?? -1);
  push(out, es[1].tag ?? -1);
  const far = len(es) + 3;
  push(out, es[far].tag ?? -1);
  // Newtype elements.
  const ids: Id[] = fill(2, 3 as Id);
  push(out, ids[1] + len(NAMES) + len(NAMES[0]));
  // A copy within a field of a struct.
  copyRange(bank.data, 0, bank.data, 1, 5);
  copyRect(bank.data, 3, 1, bank.data, 0, 1, 1, 2);
  for (const v of bank.data) push(out, v);
  // A for loop whose body changes its counter re-evaluates its condition.
  let count = 0;
  for (let i = 0; i < 10; i++) {
    i += 2;
    count++;
  }
  push(out, count);
  for (const byte of BYTES) push(out, i32(byte));
  setResult(out);
}
