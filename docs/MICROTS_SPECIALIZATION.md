# MicroTS UI specialization

**MicroTS specialization reduces binding, layout, and drawing work in generated native applications.** It folds supported constant expressions, skips bindings whose dependencies have not changed, and reuses layout or drawing results when their inputs match. View IR, Model IR, admission, and guest compilation use the same formats and behavior with specialization on or off.

## Build and inspect

Native builds enable specialization by default. Use `--specialize off` to build a comparison program, and `--report specialization` to inspect binding dependencies and layout-region candidates.

```sh
bun microts/compiler/cli.ts build sensor-list --specialize on
bun microts/compiler/cli.ts build sensor-list --specialize off --out .pocket-build/sensor-reference
bun microts/compiler/cli.ts check sensor-list --report specialization
bun microts/compiler/cli.ts check sensor-list --report specialization --strict --json
```

### Read the analysis report

The report classifies values by when their inputs can change:

| Classification | Meaning | Examples |
| --- | --- | --- |
| `Build` | Inputs are fixed by the source program | Literals, constants, and expressions over fixed inputs |
| `Mount` | A value is fixed for one mounted instance or keyed row | A scalar factory parameter with no write path; a keyed row's key |
| `Frame` | A value can change while mounted, or its dependencies cannot be proven | Signals, memos, replaceable props, private fields, and handwritten model bindings |

The report lists component call sites, node bindings, per-property style candidates, dependencies, environment facts, existence, layout participation, animation writes, and region criteria. **Every `Frame` result includes its cause.** A private-field read or a handwritten model binding has an unknown dependency set. Aggregate factory parameters remain `Frame` because the analysis does not prove the absence of mutation through aliases.

`VS101` identifies auto-width region candidates. `VS102` identifies shrink=1 candidates. `--strict` emits these as warnings on stderr; they do not reject the program. JSON reports include findings without changing serialized IR.

**The report describes dependency proofs, not a guarantee that an optimization applies.** It does not enable regions or bake geometry. A `Build` classification does not authorize execution of model functions during compilation. A `Mount` classification does not guarantee a single generated update; rows in dynamic lists still update during reconciliation. Region activation also requires the host environment described below.

## Binding updates

The scalar evaluator uses MicroTS numeric normalization, integer widths, and f32 rounding. Wide integer operations use bigint. Unsupported operations and text conversions run at runtime. The pass does not execute model functions or external calls at build time.

**Bindings preserve their mount and first-update timing.** Source class and text literals are written during mount. Folding a dynamic property, class, or nonempty text expression preserves its first-update write. A constant-selected branch mounts during its first update. A node or list row whose bindings need no further evaluation skips those later updates; dispatch, placement, refs, and unmount behavior still run at their lifecycle boundaries.

Compiled models accumulate signal and memo changes until the frame ends. Generated `react` and `settle` capture changed bits before clearing their working flags. View guards compare those bits with the model's recorded read dependencies. Lifecycle rounds add to the same snapshot, which is cleared at the next frame boundary. Private reads, handwritten models, props replacement, external invalidation, and task recovery use full updates when dependency guards cannot establish that a binding is unchanged.

## Incremental layout synchronization

**The core synchronizes changes into its existing Taffy tree.** This applies to the primary and auxiliary outputs, with or without MicroTS specialization. A generation-tagged UI node keeps its layout handle while it remains in the solver. Insertion creates new layout nodes; removal and reordering update child lists. Destroyed nodes release their measurement contexts and handles before those slots can supply another node's layout.

Structural synchronization projects the current UI tree into layout nodes. A Text element owns one measured leaf for its concatenated inline run; an empty run has no layout leaf. Moving inline text updates its old and new measurement owners. Each output owns its handle map, so a move between outputs cannot reuse a handle from another Taffy tree.

**Paint changes whose resolved layout inputs are equal skip the solver.** Changes to layout styles, child lists, text measurement inputs, or viewport constraints require layout work. Measurement inputs include the text, font slot, tracking, line height and provider choice. Font or provider replacement invalidates cached measurements. Reuse preserves the missing-glyph increments of the replaced measurement work. Root computation lets Taffy propagate changes through auto sizing and flex constraints while reusing child results whose constraints still match.

Structural projection, layout rounding and result readback visit the tree. Reusing layout nodes and measurements reduces construction and shaping work, but does not make the whole operation proportional to the number of changed nodes. `Show` branches follow their mount, unmount, ref and cleanup behavior. The opt-in region solvers below have separate boundary, wrapper and baked-layout handling; structural changes there rebuild the affected solver.

## Environment and layout regions

Hosts configure environment-dependent specialization through the options to `buildAot` in [`microts/compiler/aot-build.ts`](../microts/compiler/aot-build.ts):

| Option | Purpose |
| --- | --- |
| `specialize: "on" \| "off"` | Enable or disable native specialization; defaults to `"on"` |
| `specializationEnvironment` | Supply `viewport`, `tickRate`, and `fontAtlases: [{ slot, bytes }]` for the target host |
| `specializationTarget` | Request layout and text-size baking for a supported target configuration |
| `specializationShapeCacheBytes` | Set the generated text-size cache budget; defaults to 32 KiB |

Without an explicit environment, the build reads `app.viewport.fixed.logical` from the `pocket.json` beside the root component, or uses 480 × 272 when that field is absent, and selects a tick rate of 60 Hz. It has no atlas identities until the host build supplies the atlas bytes. The application can run without them; optimizations that depend on those identities use runtime layout and painting.

Generated `prepare_specialization(&mut ui)` must run **before the host loads styles and font assets**. The core records SHA-256 identities of those loaded bytes. Missing identities, different bytes, a viewport or tick-rate mismatch, a native text provider, or streaming font data disable the application's environment-dependent regions and baked tables. Generated `specialization_diagnostics()` exposes the reason outside the model command channel. A later mismatch disables regions until the application is mounted again. Constant folding and binding dependency guards do not require this environment match. Guest asset loading performs no specialization hashing or region registration.

The generated application activates queued region roots after their initial update, lifecycle effects, and commands, before layout. This order also applies to roots created by later conditional or keyed-list updates.

Region roots need fixed pixel dimensions on both axes, `grow=0`, `shrink=0`, and compatible basis, minimum, and maximum sizes. Text roots and auxiliary outputs use the general layout path. The report explains which conditions a candidate fails; fixed width and height alone do not establish a region boundary.

**Each registered region has a separate Taffy tree.** Its root appears as a leaf in the parent solver. The child solver receives the parent's unrounded dimensions and cumulative origin; its readback retains the parent-relative root placement. Mutations dirty the affected solver. Invalid isolation or provider changes return the tree to the general layout path.

### Layout and text-size baking

`specializationTarget` supports `aarch64-apple-darwin-std`; `host` selects that configuration on the matching host. **Other targets use live layout.** Generated tables check the runtime target and `std` feature before use.

The compiler evaluates baked geometry in a separate wasm artifact built with `specialization-host`, which enables the core's `std` configuration. Guest wasm uses `no_std` and has no baking exports. Matching the configuration matters for pixel placement: the host configuration rounds a position of `0.49999997` pixels to 1, while the guest configuration rounds it to 0.

Baked layout tables contain parent indices, rectangles, and the region root's expected unrounded size and cumulative integer origin. Activation matches the live subtree against those parent indices. A size or placement mismatch discards the table and solves the region. Tables apply to the first solve; later geometry changes use Taffy. Nested registered regions and unsupported template geometry retain live layout. Regions whose wasm measurement or paint records missing glyphs retain live layout and painting to preserve `glyph_misses()`.

Baked text sizes prefill a bounded cache keyed by font slot, revision, text, tracking, and line height. The cache holds at most 64 entries with FIFO eviction. Its byte budget includes table and text storage but excludes allocator overhead. Font replacement invalidates entries. Cache hits reproduce the missing-glyph increments of runtime measurement. Native and streamed text use their provider's measurement paths. An empty cache adds no lookup.

## Drawing and damage

Region draw caches retain words under a 64 KiB default word budget. Hosts can set it with `core.set_draw_cache_budget(bytes)`; zero disables dynamic word caching while preserving damage metadata and static draw-table reuse. Node changes invalidate containing regions and affected descendant regions. Ancestor placement, clipping, opacity, transforms, font revisions, and texture replacement participate in reuse. Perspective and streamed text use the general painter; missing-glyph runs retain their measurement side effects. Movement regenerates words when the cached placement differs.

**Static draw tables are shared Rust statics generated from wasm snapshots.** The supported words are RECT, GRAD_RECT, GLYPH_RUN, and balanced scissor operations. Exact placement and clip guards protect first-frame reuse. Textures, native text, transforms, rounded-resource branches, and nested registered regions retain runtime painting. A single RECT can patch a finite background-color domain when every candidate has nonzero alpha and all other paint branches remain fixed. Opacity crossing zero and arbitrary model colors retain runtime painting.

`RenderResources::draw_segments()` has a default empty implementation. Each damage tracker saves its segment baseline on successful `commit`. Unchanged segments require no op decoding; movement and order changes add old and new bounds. Changed segments compare their own slices, and structural differences damage that segment. Nested comparisons skip unchanged children. Proven color patches add their rectangles without decoding. Hosts clear each damage rectangle and replay the complete DrawList clipped to it. **An empty segment history and table use ordinary DrawList comparison.**

## Work counters

The `counters` Cargo feature in `microts` forwards to `pocketjs-core`. It records UI calls, node creation and destruction, binding evaluations and writes, update entry counts, layout work, DrawList work, and damage work. Feature-disabled builds contain no counter storage or counter increments.

```rust
let ui_work = app.ui().counters();
let core_work = app.ui().core().counters();
app.ui_mut().reset_counters();
```

`reset_counters` clears accumulated UI and core work. Live Taffy-node counts and cache bytes remain gauges. Draw counters separate total words from `generated_words`, region hits, and static-plan hits. Shape counters separate cache hits from shaping calls. `DamageTracker` owns its counter snapshot and reset operation.

`structure_rebuilds` counts fresh Taffy trees; `structure_syncs` counts synchronization into existing trees. `layout_passes` counts root computations and `measure_callbacks` counts the leaf measurements Taffy requests. The `counters` feature also exposes `force_layout_rebuild_for_validation()` for comparison against fresh tree construction.

`segment_table_bytes` counts the allocated capacities of the current draw segment table and the segment tables retained in region caches. The word budget excludes this metadata; the gauge exposes that cost alongside `region_cache_bytes`.

## Compare builds

The native differential harness runs an input recording, called a tape, against builds with specialization off and on. The `sensor-list` sample uses simulated sensor values and a deterministic tape; it needs no sensor hardware.

```sh
bun microts/compiler/specialization-harness.ts sensor-list
bun microts/compiler/specialization-harness.ts sensor-list --release
bun tools/test.ts --stage='MicroTS UI specialization'
cargo test --manifest-path engine/core/Cargo.toml
cargo test --manifest-path engine/core/Cargo.toml --features counters
cargo test --manifest-path engine/crates/microts/Cargo.toml --features counters,harness
```

The harness builds two native programs from one fixture with specialization off and on. It bakes shared font assets and runs the same tape through both programs. **Comparison includes complete DrawList words, pixel hashes, glyph-miss counts, logical focus and hit identities, retained trees, command order, Ready snapshots, and cleanup commands.** Each program checks damage replay against a full software-rasterized framebuffer; a second tracker commits on alternate frames. Work counters and host timing samples remain outside the equality comparison. `bootCounters` records constructor work; each frame records work since the constructor or the preceding frame. The summary records the build profile, host identity, generated line counts, and executable bytes. Debug timings are validation diagnostics; use `--release` for host measurements.

Generated node identities combine source call sites, template positions, and keyed-row scopes. They do not use debug names or allocation IDs. Identity instrumentation requires the emitter's `harness` option and the runtime's `harness` feature. Retired identities remain available to normalize commands queued before a node's destruction.

Each run writes generated programs, build logs, shared IR, full frame observations, and a summary below `.pocket-build/validation/microts-specialization/<run>/`. A mismatch reports the frame and artifact directory. These files are ignored validation output.

The tape accepts a frame array or an object with `frames`, `viewport`, `hz`, and `services`. Frames can contain button masks, a two-entry `axes` array, native `MotionState` fields, `touch` points for hit comparison, a `press` point, viewport changes, atlas filenames in `fonts`, `invalidate`, `set_props`, and deliveries. `set_props` reuses the harness's configured props expression. Deliveries contain `request` and a result tagged `value`, `animation`, or `cancelled`; `{"$i32": 3}` preserves an i32 transport value. Atlas paths are relative to the fixture.

[`apps/sensor-list/tape.json`](../apps/sensor-list/tape.json) exercises empty text, numeric changes, keyed reorder and insertion/removal, conditional content, focus, scrolling, and viewport changes. START changes the first sensor value without changing the title or footer, for card-bounded damage checks. The harness accepts a handwritten model through `modelSource` and `modelExpression` for protocol boundary tests.

**Work counters measure computation, not device frame time.** Use release builds on the intended target to measure timing, binary sections, and memory use. Compare the same font assets, viewport, input tape, and build profile when selecting cache budgets or assessing a performance change.
