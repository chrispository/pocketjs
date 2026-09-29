# MicroTS reference

**MicroTS compiles Vue templates or Solid TSX and TypeScript contracts into Rust.**
This page covers the shared native build tools, runtime configuration, and
Vue template syntax. See [Solid TSX to Rust](/docs/microts-solid/) for the
Solid source subset.
Use [Getting started](/docs/microts/) for the build workflow and
[Components](/docs/microts-components/) for props, events, models,
slots, instance state, generics and shared context.
For the connection between template bindings and generated Rust methods,
read [Compilation and runtime](/docs/microts/#compilation-and-runtime).
The [TypeScript support reference](/docs/typescript-support/) defines the
source subsets. The [model guide](/docs/microts-model/) explains execution
of compiled model bodies, and [TypeScript and native code](/docs/microts-boundaries/)
defines the model and host contracts.

**The supported source language is TypeScript.** JavaScript mentioned in
runtime or formatting rules is generated output or engine behavior. It does
not imply an AOT support contract for `.js` models or untyped view scripts.

## Files and setup

A Vue AOT component has one `<template>` and one `<script setup lang="ts">`.
Its view-model import uses the component's basename without an extension:
`Dial.vue` imports from `./Dial`. Other script blocks, `<style>` blocks and
custom SFC blocks are rejected.

| File | What you write |
|---|---|
| `Dial.vue` | Template, imports and component declarations |
| `Dial.ts` | TypeScript state and functions; compiled mode translates their bodies, while Rust mode uses their types as the native contract |
| `Dial.d.ts` | Contract declarations for Rust mode; use this instead of `Dial.ts` |
| Rust source | Connect the app to a native host; in Rust mode, also implement the generated view-model trait |

**A component cannot have both basename module forms.** A `.d.ts` browser
preview supplies default values, such as zero, empty strings and empty arrays;
it does not execute the Rust application logic.

`app.model` defaults to `"rust"`. Set `app.aot: true` and
`app.model: "compiled"` to compile the `.ts` model. This selection applies to
the root model and child factories. Unsupported compiled model source is an
error; model selection does not change after admission fails.

`<script setup>` accepts these declarations:

| Form | Example |
|---|---|
| PocketJS host imports | `import { View, Text } from "@pocketjs/framework/vue-vapor/components"` |
| Child imports | `import Row from "./Row.vue"` |
| View-model imports | `import { count, increment } from "./Dial"` |
| Standard functions and types | `import { len, type i32 } from "@pocketjs/framework/vue-vapor/std"` |
| Types | `import type { Item } from "./types"`, `interface`, `type` |
| Component macros | `defineProps`, `withDefaults`, `defineEmits`, `defineModel`, `defineSlots` |
| Instance state | `const { count, increment } = createRow()` from the basename module |
| Shared context | `provide` and `inject`, imported from `vue` |

Put `ref`, `computed`, functions and other application logic in the `.ts`
view-model module. Import `ref` and `computed` from `vue`. In compiled models,
import `watch` and `watchEffect` from
`@pocketjs/framework/vue-vapor/reactive`. Setup does not accept local
runtime variables or statements beyond the factory, macros, context and PocketJS lifecycle forms.

## Host elements and input

Import these elements from `@pocketjs/framework/vue-vapor/components`.

| Element | Accepted attributes | Event |
|---|---|---|
| `View` | `class`, `:class`, `:style`, bare `focusable`, static `debug-name`, `:ref` to a model node slot | `@press` requires `focusable` |
| `Text` | `class`, `:class` | — |
| `Image` | `class`, `:class`, static `src` asset name | — |
| `ActionHandler` | Static `:button="BTN.NAME"`, boolean `active`, static `latched` | `@press` |
| `AxisHandler` | Static `axis="primary"` or `"secondary"`, boolean `active` | `@delta` |
| `MotionHandler` | Static `value` motion value, static `minQuality`, boolean `active` | `@update` |

Put text and interpolation inside `Text`. `Image` has no children. Register
image names with the Rust host's `Ui::register_image` before mounting views
that use them; the host loads font atlases.

For example, a dial exposes a count, a reset action and incremental motion:

```vue
<!-- Dial.vue -->
<script setup lang="ts">
import { ActionHandler, AxisHandler, Text, View }
  from "@pocketjs/framework/vue-vapor/components";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
import { count, resetCount, adjustCount } from "./Dial";
</script>

<template>
  <View class="flex-col gap-2 p-4">
    <ActionHandler :button="BTN.CROSS" :active="count !== 0"
      latched @press="resetCount()" />
    <AxisHandler axis="primary" @delta="adjustCount($event)" />
    <Text>{{ count }}</Text>
    <View focusable @press="resetCount()"><Text>Reset</Text></View>
  </View>
</template>
```

```ts
// Dial.d.ts — implement these methods in the Rust view model.
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
export declare const count: i32;
export declare function resetCount(): void;
export declare function adjustCount(delta: i32): void;
```

**Axis events carry signed `i32` millidegrees: `1000` means one degree.**
The app chooses sensitivity and retains any remainder between steps. An
`AxisHandler` consumes the hardware-neutral relative-axis channel; device
adapters translate physical motion into this channel.

Each axis handler receives one nonzero accumulated delta per frame. Deltas
for an axis sum with `i32` saturation. `active` gates delivery. A `latched`
button handler waits for a release before accepting a press. Action and axis
handlers run in document order.

Rust hosts provide motion through `Input::default().with_axis(0, delta)`;
axis `0` is primary and axis `1` is secondary. A host needs
the generated app's `HasButton<MASK>` and `HasRelativeAxis<ID>` implementations
for the inputs the template uses.

### Motion state

**A `MotionHandler` receives fused device attitude, never sensor readings.**
The host's native motion driver owns sampling, calibration and fusion, and
publishes one `MotionState` per estimate. Vectors use the W3C DeviceMotion
device frame: +x toward the right edge, +y toward the top edge, +z out of the
screen. `contracts/spec/motion.ts` defines the state.

| `value` | Payload after the components | Components | Driver level |
|---|---|---|---|
| `gravityDirection` | `quality`, `timestamp` | unit vector toward the ground: `x`, `y`, `z` | gravity |
| `inclination` | `quality`, `timestamp` | `degrees` between the screen normal and up: 0 face up, 90 upright | gravity |
| `linearAcceleration` | `quality`, `timestamp` | m/s² with gravity removed: `x`, `y`, `z` | inertial |
| `rotationRate` | `quality`, `timestamp` | bias-corrected degrees per second: `x`, `y`, `z` | inertial |
| `orientation` | `quality`, `referenceFrame`, `epoch`, `timestamp` | unit quaternion `w`, `x`, `y`, `z` from the device frame to the reference frame | inertial |
| `heading` | `quality`, `referenceFrame`, `timestamp` | `degrees` clockwise from north, `accuracy` in degrees | geomagnetic |
| `screenRotation` | `quality`, `timestamp` | clockwise `degrees` that keep content upright | gravity |
| `tilt` | `quality`, `timestamp` | W3C `beta`, `gamma` degrees | gravity |
| `angles` | `quality`, `referenceFrame`, `epoch`, `timestamp` | W3C `alpha`, `beta`, `gamma` degrees | inertial |

Components are `f32`; `quality` and `referenceFrame` are `u8`, `epoch` is
`u32` and `timestamp` is `u64` microseconds on the driver's clock. A handler
declares the leading parameters it uses. `screenRotation`, `tilt` and
`angles` are conveniences the driver derives from `gravityDirection` and
`orientation` and publishes with its own quality; `angles` carries the
orientation's `referenceFrame` and `epoch`. The runtime passes every value
through unchanged.

**Quality gates delivery.** `MotionQuality` is `unavailable`, `unreliable`,
`low`, `medium` or `high`; the handler fires on each frame whose state carries
the value at `minQuality` or better, default `low`. A driver marks
`screenRotation` `unreliable` while the screen lies near horizontal, where
the upright direction is undefined.
`referenceFrame` is `local` for an inertial driver, whose horizontal origin is
arbitrary, and `magneticNorth` or `trueNorth` for a geomagnetic one. `epoch`
increments whenever the driver re-establishes its reference frame.

```vue
<MotionHandler value="screenRotation" @update="upright" />
<MotionHandler value="rotationRate" minQuality="high" @update="spin" />
```

As in Vue, a method handler receives the payload values its parameters name
(`spin(x, y, z)` above), and an inline statement reads only the first value,
as `$event`.

Rust hosts pass the driver's estimate with
`Input::default().with_motion(state)`, where `state` is a
`microts::MotionState`. A driver at the gravity level supplies
`gravityDirection` and `inclination`; the inertial level adds linear
acceleration, rotation rate and local orientation; the geomagnetic level adds
north-referenced orientation and heading. The generated app requires
`HasMotion<LEVEL>` for each level its values need, with levels from
`spec::motion::level`.

## Template lookup

| Feature | Accepted form and requirement |
|---|---|
| Conditional branches | `v-if`, `v-else-if`, `v-else`; conditions must be `boolean` |
| Visibility | `v-show="visible"` on a host element keeps its subtree mounted |
| Text | `{{ value }}` or `<Text v-text="value" />`; `v-text` allows no children |
| Lists | `v-for="item in items"` or `v-for="(item, index) in items"`; `items` must be an array |
| Keys | Every `v-for` needs `:key`; use `i32`, `i64`, `string` or a string-literal enum |
| Child props | `:title="title"`; expression types must match the child's declarations |
| Child models | `v-model="value"`, `v-model:name="value"` |
| Slots | `<slot />`, named outlets and typed scoped slots; see [Components](/docs/microts-components/) |

**List keys must be unique and stable for each item.** A keyed child keeps
its instance state when its row moves. An unmounted child loses that state.
The loop index has type `i32`.

A handler accepts `save()`, `save(id)`, `save($event)`, `count = value`,
`count += 1`, `count -= 1`, `count++`, `count--`, or `emit('saved', id)`.
Assignments target view-model values or `defineModel` bindings. Statement
sequences and `if` branches combine these operations:
`@press="if (count < 10) count++; resetAxis();"`. An emission ends the
handler or a branch of its final `if`; loops, local variables and early returns
are rejected. Arguments are evaluated once per statement. Owned payloads used
by several calls are cloned before the last use.

Roots and children with a model factory can register `onMounted` and
`onUnmounted` from `@pocketjs/framework/vue-vapor/lifecycle`. Each hook calls
a zero-argument model method. Cleanup runs in reverse creation order, then
mount hooks run in creation order. Hook writes trigger another update before
the frame renders.

Model node references use `createNodeRef` from `@pocketjs/framework/animation`
in the basename module and `<View :ref="target" />` in the template. The
reference binds to a native UI node and is cleared on unmount. It supplies
an animation target; it does not expose DOM methods or a device SDK handle.

HTML elements, DOM events, directive modifiers, `v-html`, `v-once`, `v-memo`,
object `v-bind`, dynamic event names, arbitrary Vue template refs, dynamic components,
`Teleport`, `Transition`, `KeepAlive` and `Suspense` are outside the accepted
template language. Use `transition-*` classes for style transitions.

### Classes and styles

Static `class` values use the [PocketJS styling classes](/docs/styling/).
**Dynamic classes select complete class strings with a ternary.** Nested
ternaries are accepted; class objects, arrays and string construction are not.
A prop typed `StyleClass`, imported from `@pocketjs/framework/vue-vapor/std`,
forwards a compiled style ID through `:class="props.tone"`. Pass a class literal,
a ternary of class literals, or an unchanged `StyleClass` prop. A static class
cannot accompany a style-prop binding.

```vue
<View class="p-4"
  :class="selected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900'"
  :style="{ width: 80 + count * 12, opacity: 0.8 }" />
```

`:style` belongs on `View` and takes an object literal with fixed property
names. Use PocketJS names such as `width`, `paddingT`, `bgColor` and `rotate`.
Values must match the property's numeric type or unit below.

## Types and Rust methods

The shared [TypeScript support reference](/docs/typescript-support/#data-types-and-rust-values)
contains the type-to-Rust table, rejected data shapes, tuple restrictions,
generic component rules and capacity semantics. The same data mapping is used
by Solid and Vue contracts.

This section describes how a view's use of a binding determines its Rust
method. Function arguments, results, setters and event payloads use owned
values; rendering getters can borrow storage.

| Template use | Generated view-model method |
|---|---|
| Read `count: i32` | `fn count(&self) -> i32` |
| Read `title: string` | `fn title(&self) -> &str` |
| Assign to `count`, or bind it with `v-model` | Additional `fn set_count(&mut self, value: i32)` |
| Call `label(): string` in a binding | `fn label(&self) -> String` |
| Call `reset(): void` in handlers | `fn reset(&mut self)` |
| Start compiled `async load(): Promise<T>` in a handler | `fn load(&mut self, cmds: &mut Vec<Cmd>)` |

A function used in both a binding and a handler receives `&self`. Bindings
can call a function on each view update. Expose a list through a value getter
when the template iterates it, to borrow its storage during rendering.
In compiled mode, a function used in a binding must be synchronous and cannot
write state or emit host commands. Async calls start compiled tasks; their
source results go to awaiting tasks, while the public Rust method returns
`()`. A native Promise object does not cross the trait boundary.

An exported literal declaration such as `export declare const LIMIT: 20`
supplies a compile-time constant. A numeric constant adopts its use's expected
numeric type. A distinct identifier type can use the `__newtype` form above.
A homogeneous literal tuple such as
`export declare const FILTERS: readonly ["ALL", "ACTIVE", "DONE"]`
becomes a fixed native constant array. Literal indices and `len(FILTERS)` fold
at compile time; a variable index produces an optional value.
For `string | undefined`, the getter returns `Option<&str>` and stored values
use `Option<String>`.

An optional function such as `export declare const refresh: (() => void) |
undefined` has an empty default Rust method. A browser call does nothing
when the function is absent. Optional functions must return `void`.

Function-valued callbacks and slots are designated view contracts, not general
model data. See [functions and callbacks](/docs/typescript-support/#functions-and-callbacks)
for the distinction and the rules for model function signatures.

## Numeric rules and units

The [numeric rules](/docs/typescript-support/#numbers) define annotations,
literal inference, integer widths, floating precision, units, division and
formatting for each execution path. **View and model arithmetic have different
admission rules.** For example, integer `/` is rejected in a view binding;
model `/` promotes integer operands to `f64`. Use `idiv` for integer division.

A host style property can supply an expected unit or width. A numeric width
binding may widen to the property's `f32` storage type. A dimensionless `f32`
value cannot substitute for a different declared unit.

## Expressions and standard functions

The [view/model expression table](/docs/typescript-support/#view-and-model-expressions)
is the source-language reference. A Vue template binding uses the view column;
its basename `.ts` model uses the model column when `app.model` is `"compiled"`.
The [collection rules](/docs/typescript-support/#collections-and-indexing)
list the standard functions and explain the different array-index results.

In Vue bindings, `value !== undefined` and string discriminant checks narrow
values inside `v-if`. Text accepts scalars and optional scalars, with empty
text for an absent optional value. Read a scalar field or call a read-only
model method to format an object or array.

Object/array literals in model bodies do not make them general template
expressions. `:style`, prop values and other designated template forms retain
their own rules above. Move admitted business computation into the model;
that does not remove the model's own restrictions.

## Command-line reference

Run from the repository root:

```sh
bun microts/compiler/cli.ts check vue-sfc-lab --strict
bun microts/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml
```

The input can be an app name under `apps/`, an app directory or a root `.vue`
or `.tsx` path. `check` analyzes the component tree and any selected compiled
models without writing generated code. `build` writes view Rust and
`styles.bin` to `gen/` beside the root component; compiled mode adds model Rust
modules. Demo `gen/` directories are ignored by Git. Run `build` before Cargo.

| Option | Effect |
|---|---|
| `--strict` | Reject unannotated `number` in contracts |
| `build --out <directory>` | Choose the generated output directory |
| `build --no-format` | Skip `rustfmt`; the default uses it when installed |
| `build --specialize <mode>` | Select `on` or `off` for native specialization; defaults to `on` |
| `check --report specialization` | Report binding dependencies, resolved property candidates, and layout-region criteria |
| `build/check --ir <file>` | Save View IR; compiled mode also writes a sibling `.model.json` with Model IR |
| `check --json` | Print analysis and requested board results as JSON; with `--report specialization`, print the specialization report |
| `check --boards` | Report input coverage for all existing board profiles |
| `--board <name>` | Require a board's input profile to cover the app; a build checks before writing output |

`bun microts/compiler/cli.ts run <app> --tape <file>` executes the compiled model
with the reference tape player. It does not launch a native display host.
See the [model guide](/docs/microts-model/) for tape fields and explicit
view targets.

**Board reports cover input mappings.** They do not establish a target
toolchain or display integration. Existing profiles have no relative-axis
adapter; an `AxisHandler` produces a missing-adapter error for those profiles.
Each profile declares the level of its motion driver; `meowbit` has none.
A native host states its own motion level by implementing the
`HasMotion<LEVEL>` bounds the generated app requires.
An AOT build generates application source assets; a device host's build
compiles and packages the application.

## Native build options

Native builds enable specialization by default. Use separate output directories
when comparing generated source:

```sh
bun microts/compiler/cli.ts build sensor-list --specialize on
bun microts/compiler/cli.ts build sensor-list --specialize off --out .pocket-build/sensor-reference
```

**Specialization does not change View IR, Model IR, source admission, or guest
compilation.** `--specialize off` disables native compiler specialization; the
core's general incremental layout remains enabled in both builds.

Host build scripts use the options to
[`buildAot`](https://github.com/pocket-stack/pocketjs/blob/main/microts/compiler/aot-build.ts)
for environment-dependent reuse. These options apply to both Vue and Solid:

| Option | Value and default |
|---|---|
| `specialize` | `"on"` or `"off"`; default `"on"` |
| `specializationEnvironment` | `{ viewport: [width, height], tickRate, fontAtlases?: [{ slot, bytes }], fontSlots?: [...] }` |
| `specializationTarget` | Request layout, text-size, and static draw-table baking for a supported target; omitted means no build-time baking |
| `specializationShapeCacheBytes` | Nonnegative integer byte budget for the generated text-size cache; default 32 KiB |
| `harness` | Emit logical node identities for a runtime built with the `harness` Cargo feature; default off |

Environment viewport dimensions must be finite and between 1 and 32000.
`tickRate` must be an integer from 1 through 240. Atlas slots must be valid and
unique, and each atlas header must encode the supplied slot. Omit `fontSlots`
to infer all potentially used slots, including inherited fonts; an explicit
list must cover the fonts on which specialization depends.

Without an explicit environment, the build reads
`app.viewport.fixed.logical` from the `pocket.json` beside the root component,
or uses 480×272 if absent, and sets 60 Hz. It has no font content identities
until the host build supplies atlas bytes. The application still runs;
environment-dependent optimizations use live layout and painting when their
required identities are missing.

**Call generated `prepare_specialization(&mut ui)` before loading styles and
font assets.** The core records SHA-256 identities of the loaded bytes;
revision counters alone do not identify those bytes. Generated application
construction checks the environment, and frame boundaries check it again
before newly mounted regions are activated.

Any of these conditions disables the application's environment-dependent
regions and baked tables:

- A different viewport or tick rate.
- Missing or mismatched style or required font identities.
- A native text-measurement provider or streamed data in a required font slot.

`specialization_enabled()` reports the result and
`specialization_diagnostics()` returns reasons outside the model command
channel. A mismatch after activation leaves these optimizations disabled
until the application is mounted again. Constant folding and binding
dependency guards do not require an environment match. Guest asset loading
does not enable specialization hashing or region registration.

## Specialization report

Inspect source proofs without generating native code:

```sh
bun microts/compiler/cli.ts check sensor-list --report specialization
bun microts/compiler/cli.ts check sensor-list --report specialization --strict --json
```

The report classifies a value by when its inputs can change:

| Stage | Meaning | Examples |
|---|---|---|
| `Build` | Inputs are fixed by the source program | Literals, constants, expressions over fixed inputs |
| `Mount` | Fixed for one mounted instance or keyed row | A scalar factory parameter with no write path; a keyed row's key |
| `Frame` | Can change while mounted, or lacks a complete dependency proof | Signals, memos, replaceable props, private fields, handwritten model bindings |

It lists component call sites, node bindings, dependencies, environment facts,
existence, layout participation, per-property style values, animation writes,
and region criteria. Property values are `Known`, finite `Candidates`, or
`Unknown`. **Every `Frame` result includes its cause.** Private-field reads
and handwritten model bindings have `deps: "top"`, meaning unknown
dependencies. Aggregate factory parameters remain `Frame` because mutation
through aliases is not excluded.

The analysis accounts for focus/active style variants, transitions, timelines,
and model animation or jump commands targeting node references. One property
can be `Build` even when another property in the same style is `Frame`.
`VS101` and `VS102` explain auto-width and shrink=1 region candidates.
`--strict` prints these warnings to stderr; they do not reject the program.
JSON findings are separate from serialized IR.

**A report classification does not activate an optimization.** The report
neither registers regions nor bakes geometry. `Build` does not authorize the
compiler to execute model functions or external calls. Scalar folding uses
MicroTS integer widths, bigint for wide integer arithmetic, and f32 rounding;
unsupported operations and text conversions retain runtime evaluation.
`Mount` does not promise one generated update: keyed rows can still update
during reconciliation. Region activation also needs the environment and
geometry checks below.

## Layout region requirements

A region root must satisfy every geometry criterion:

| Property | Required value |
|---|---|
| Width and height | Known, finite, nonnegative pixel dimensions |
| Grow and shrink | Both zero |
| Basis | `auto`, or equal to the fixed dimension along the parent's proven main axis |
| Minimum and maximum sizes | `auto`, or finite pixel limits that do not constrain the fixed dimensions |

If parent direction is unknown, a numeric basis can still match both axes
when width and height are equal. Percentage-based, dynamic, or unresolved
dimensions do not qualify. **Fixed width and height alone do not establish
an isolated region.** The report records each failed criterion. Text roots
and auxiliary outputs use the general layout path.

Generated roots are queued during mount. Activation follows their initial
update, lifecycle effects, and commands, before layout. The same ordering
applies to roots created by later conditional or keyed-list updates.

Each registered region has a separate Taffy tree. Its root is a leaf in the
parent solver. The child solver receives the parent's unrounded dimensions
and cumulative origin, and readback retains the parent-relative root
placement. Invalid isolation or provider changes return the tree to general
layout. Structural changes rebuild the affected region solver; they do not
use the general solver's retained-topology synchronization.

### Layout and text-size baking

`specializationTarget` supports `aarch64-apple-darwin-std` when building on
ARM64 macOS. `host` and `aarch64-apple-darwin` select the same configuration
on that build host. Other targets and build hosts retain live layout.
Generated tables also check the runtime architecture, operating system, and
`std` feature.

The compiler builds a separate wasm artifact with `specialization-host`,
which enables the core's `std` configuration. Guest wasm uses `no_std` and
has no baking exports. The distinction affects rounding: a position of
`0.49999997` pixels rounds to 1 in the host configuration and to 0 in the
guest configuration. Baking also requires an integer logical viewport and
known values for the geometry it materializes.

Baked layout tables contain parent indices, rectangles, and the root's
expected unrounded size and cumulative integer origin. Activation matches the
live subtree against the parent indices. A size or placement mismatch discards
the table and solves the region. Tables apply to the first solve; later
geometry changes use Taffy. Nested registered regions and unsupported template
geometry retain live layout. Regions whose wasm measurement or paint records
missing glyphs retain live layout and painting to preserve `glyph_misses()`.

Baked text sizes prefill a cache keyed by font slot, revision, text, tracking,
and line height. The cache holds at most 64 entries with FIFO eviction. Its
byte budget includes the cache header, entry table, and text storage, but
excludes allocator overhead. Zero disables it. Font replacement invalidates
entries; a cache hit reproduces the missing-glyph increments of runtime
measurement. Native and streamed text use their provider's measurement path.
An empty cache adds no lookup.

## Draw cache and damage rules

The core's region draw cache has a **64 KiB default word budget**. Set it with
`core.set_draw_cache_budget(bytes)`. Zero disables dynamic word caching while
preserving damage metadata and static draw-table reuse. The word budget does
not include segment metadata; inspect `segment_table_bytes` alongside
`region_cache_bytes` when assessing memory use.

Node changes invalidate containing regions and affected descendant regions.
Reuse accounts for ancestor placement, clipping, opacity, transforms, font
revisions, and texture replacement. A changed cached placement regenerates
words. Perspective and streamed text use the general painter; missing-glyph
runs retain their measurement side effects.

### Static draw tables

Static tables are shared Rust statics generated from wasm snapshots, usable
on the first frame when their guards match. The supported words are `RECT`,
`GRAD_RECT`, `GLYPH_RUN`, and balanced scissor operations. Exact placement,
size, viewport, clip, and opacity guards protect reuse. Textures, native text,
transforms, rounded-resource branches, and nested registered regions retain
runtime painting. Ancestor transforms, translation, clipping, or opacity
changes also prevent use of this subset.

A single-node region containing one `RECT` can patch its background color
when the compiler proves a finite set of integer color candidates with
nonzero alpha. All other properties and paint branches must be `Build`:
opacity is 1, and radius, border, shadow, gradient, arc, and bevel branches
are absent. The color must have no transition, timeline, or model-command
writes. Other dynamic colors and opacity that can cross zero retain runtime
painting; finite candidates alone do not prove a safe word patch.

### Segment damage

`RenderResources::draw_segments()` defaults to an empty implementation.
A `DamageTracker` saves its own segment baseline on successful `commit`.
Unchanged segments require no operation decoding. Movement and order changes
add old and new bounds; changed segments compare their own slices, and
structural differences damage that segment. Nested comparisons skip unchanged
children. Proven color patches add their rectangles without decoding.

The host clears each damage rectangle and replays the complete DrawList
clipped to it. An empty segment history and table use ordinary DrawList
comparison. Aborted or uncommitted plans do not advance the tracker's baseline.

## Work counters

The `counters` Cargo feature in `microts` forwards to `pocketjs-core`.
**Counters are off by default, and specialization does not depend on them.**
Feature-disabled builds contain no counter storage or increments.

Enable the feature on the application's `microts` dependency. For an
application under `apps/<name>/`, the dependency can be declared as:

```toml
[dependencies]
microts = { path = "../../engine/crates/microts", features = ["counters"] }
```

Read the snapshots around the operation being measured:

```rust
let ui_work = app.ui().counters();
let core_work = app.ui().core().counters();
app.ui_mut().reset_counters();
```

| Counter group | Meaning |
|---|---|
| `set_style`, `set_prop`, `set_text` | Calls made through the typed UI wrapper |
| `nodes_created`, `nodes_destroyed` | UI node creation and destruction, including destroyed descendants |
| `update_at`, `memo_evaluations`, `memo_writes` | Generated update entries, binding evaluations, and writes |
| `structure_rebuilds`, `structure_syncs` | Fresh Taffy trees and synchronization into retained trees |
| `layout_passes`, `measure_callbacks` | Root layout computations and leaf measurements requested by Taffy |
| `style_updates`, `taffy_nodes_created` | Layout style updates and layout-node allocations |
| `shaping_calls`, `shaping_cache_hits` | Text shaping and text-size cache reuse |
| `words`, `generated_words` | Total draw words and words generated by painting, excluding reused words |
| `region_cache_hits`, `static_plan_hits` | Dynamic region-cache and generated static-table reuse |
| Damage `decoded_ops`, `prepares`, `area`, `full_redraws` | Decoded operations, successful prepares, logical damage area, and full redraws |

`reset_counters` clears accumulated UI and core work. Live `taffy_nodes`,
`shaping_cache_bytes`, and draw-cache byte counts remain gauges.
`DamageTracker` owns its counter snapshot and reset operation; resetting
counters does not change its committed baseline.

`segment_table_bytes` counts allocated capacities of the current draw segment
table and tables retained in region caches. It excludes vector headers,
region maps/stacks, allocator bookkeeping, word storage, and external damage
tracker snapshots. `region_cache_bytes` reports retained word storage.

The feature also exposes `force_layout_rebuild_for_validation()` for tests
that compare against fresh tree construction. It is a manual test hook and
is not called by normal application frames or enabled by specialization.

## Compare native builds

The native differential harness compiles specialization off and on, supplies
shared font assets, and runs the same input recording through both programs.
The `sensor-list` fixture uses simulated sensors and needs no device hardware.
From the repository root:

```sh
bun microts/compiler/specialization-harness.ts sensor-list
bun microts/compiler/specialization-harness.ts sensor-list --release
bun microts/compiler/specialization-harness.ts sensor-list path/to/tape.json --release
```

**Comparison includes complete DrawList words, pixel hashes, glyph-miss
counts, logical focus and hit identities, retained trees, command order,
Ready snapshots, and cleanup commands.** Both programs check damage replay
against a full software-rasterized framebuffer; a second tracker commits on
alternate frames. The harness also checks that serialized View IR and Model
IR are equal. Work counters and timing samples are excluded from equality.

`bootCounters` records constructor work. Counters reset before each frame,
which records work for that frame. The summary records build profile, host
identity, generated Rust line counts, and executable bytes. Use `--release`
for host measurements; debug timing is useful for diagnosis, not performance
claims. Work counts do not measure device frame time. Measure timing, binary
sections, and memory on the intended target with matching assets, viewport,
input recording, and build profile.

Each run writes generated programs, build logs, shared IR, full observations,
and a summary under the ignored directory
`.pocket-build/validation/microts-specialization/<run>/`. A mismatch reports
the frame and artifact directory.

### Tape fields and programmatic use

The harness accepts a frame array, or an object with `frames`, `viewport`,
`hz`, and `services`. These are the native differential harness's tape fields;
the model interpreter's tape is described in the [model guide](/docs/microts-model/).

| Frame field | Value |
|---|---|
| `buttons` | Button bitmask |
| `axes` | Two signed relative-axis deltas |
| `motion` | Native `MotionState` fields |
| `touch` | Array of `[x, y]` points to hit-test after the frame |
| `press` | `[x, y]` point whose hit node becomes the frame's input target |
| `viewport` | Replacement `[width, height]` |
| `fonts` | Atlas filenames resolved relative to the fixture |
| `invalidate` | Call the generated app's invalidation entry when true |
| `set_props` | Reapply the harness's configured props expression when true |
| `deliveries` | Service completions matched to emitted request IDs |

Each delivery has `request: { task: { region, function, call }, wait, member }`
and `result: { kind, value }`. `kind` is `value`, `animation`, or `cancelled`;
cancelled results omit `value`. Animation values are `ended`, `replaced`, or
`dropped`. A value payload of `{"$i32": 3}` preserves an i32 transport value;
ordinary JSON numbers use the model's number transport representation.

[`sensor-list/tape.json`](https://github.com/pocket-stack/pocketjs/blob/main/apps/sensor-list/tape.json)
exercises empty text, numeric changes, keyed reorder and insertion/removal,
conditional content, focus, scrolling, and viewport changes. START changes the
first sensor value without changing the title or footer, for card-bounded
damage comparison.

For custom fixtures,
[`executeSpecialization`](https://github.com/pocket-stack/pocketjs/blob/main/microts/compiler/specialization-harness.ts)
accepts `tape`, `release`, `propsExpression`, and `specializationTarget` options.
The target option enables supported baking in the on build. `modelSource`
and `modelExpression` supply a handwritten Rust model for a fixture without a
compiled model.

Generated logical identities combine source call sites, template positions,
and keyed-row scopes. They do not use debug names or allocation IDs. Identity
instrumentation needs both the emitter's `harness` option and the runtime's
`harness` Cargo feature. Retired identities remain available to normalize
commands queued before node destruction.

Run the corresponding compiler/runtime suites with:

```sh
bun tools/test.ts --stage='MicroTS UI specialization'
cargo test --locked --manifest-path engine/core/Cargo.toml
cargo test --locked --manifest-path engine/core/Cargo.toml --features counters
cargo test --locked --manifest-path engine/crates/microts/Cargo.toml --features counters,harness
```

## Common diagnostics

| Diagnostic | Fix |
|---|---|
| Cannot resolve root component | Supply its `.vue` path or an app directory containing `app.vue`, `App.vue` or the configured entry |
| View-model import must use the SFC basename | For `Dial.vue`, use `./Dial` and keep one `Dial.ts` or `Dial.d.ts` |
| Unannotated `number`, or numeric type mismatch | Annotate the contract with `i32`, `f32` or another numeric type; convert floats before integer use |
| `:class` must be a ternary | Select complete class literals with `condition ? '...' : '...'` |
| `@press` requires a focusable View | Add bare `focusable`, or use `ActionHandler` for a named button |
| Invalid `v-for` source or key | Supply an array and a unique key with a supported type |
| Text interpolation requires a scalar | Select a field, call `len`, or expose a formatting method |
| Missing prop, slot parameter or context provider | Match the child's declarations; see [Components](/docs/microts-components/) |
| Board has no relative-axis adapter | Use a host that implements the required axis capability, or change the app's input requirement |
| Board has no motion driver at a value's level (VB106) | Subscribe to values of the board's level, or use a board whose driver fuses the required sensors |
| Rust view-model trait implementation is incomplete | Regenerate after contract changes, then implement the trait's required methods and associated child types |
| Compiled model source is outside the supported subset | Change the TypeScript body according to the source diagnostic, or select Rust mode and provide its native implementation |

Specialization findings describe skipped optimizations rather than rejected
source. They are separate from the admission errors above:

| Finding | Meaning and response |
|---|---|
| `VS101` | Auto width prevents an isolated layout region. Supply a fixed pixel width if that matches the intended layout, or keep general layout. |
| `VS102` | `shrink=1` prevents an isolated layout region. Use `shrink=0` only when the parent must not shrink this node. |
| `VS205` | The build-time environment has no atlas bytes for a required font slot. Supply the host's atlas bytes to `specializationEnvironment`; dependent optimizations otherwise use the general path. |

`VS101` and `VS102` are report diagnostics printed as warnings with `--strict`.
`VS205` is produced by build-time environment-contract analysis;
it is not a source-type error. Runtime environment mismatches are exposed by
`specialization_diagnostics()` and do not enter the model command stream.
