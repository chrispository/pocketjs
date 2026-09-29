# MicroTS UI specialization

**Native builds fold proven scalar expressions and remove repeated Build binding work.** `buildAot` enables this pass by default. `--specialize off` retains the general AOT path for comparison. The pass runs on code generation's expanded nodes; View IR, Model IR, admission, and guest compilation retain their existing formats and behavior.

```sh
bun microts/compiler/cli.ts build sensor-list --specialize on
bun microts/compiler/cli.ts build sensor-list --specialize off --out .pocket-build/sensor-reference
bun microts/compiler/cli.ts check sensor-list --report specialization
bun microts/compiler/cli.ts check sensor-list --report specialization --strict --json
```

**Build bindings retain their first-update write boundary.** Static class and text writes that preceded specialization remain in mount. A constant-selected branch mounts during its first update. A node or list row with Build bindings skips its later binding updates while retaining dispatch, placement, refs, and unmount behavior.

The scalar evaluator uses MicroTS numeric normalization, integer widths, and f32 rounding. Wide integer operations use bigint. Unsupported operations and text conversions retain runtime evaluation. The pass does not execute model functions or external calls at build time.

**Compiled models retain signal and memo changes until the frame ends.** Generated `react` and `settle` capture changed bits before clearing their working flags. View guards intersect those bits with Ledger read dependencies. The frame boundary clears the view snapshot once; lifecycle rounds accumulate changes in that snapshot. Private reads, handwritten models, props replacement, external invalidation, and task recovery retain the required full-update path.

## Analysis report

The report lists component call sites, node bindings, per-property style candidates, dependencies, environment facts, existence, layout participation, animation writes, and region criteria. **Every Frame result includes its cause.** A private-field read or a handwritten model binding has an unknown dependency set. Scalar factory parameters require a write-path check before receiving Mount status; aggregate parameters require an alias proof that this report does not provide.

`VS101` identifies auto-width region candidates. `VS102` identifies shrink=1 candidates. `--strict` emits these as warnings on stderr; they do not reject the program. JSON reports include findings without changing serialized IR.

**A passing region criterion requires an environment contract before activation.** The generated application activates queued roots after their initial update, lifecycle effects, and commands, before layout. This order also applies to roots created by later conditional or keyed-list updates.

## Retained layout synchronization

**The general core layout path retains its Taffy tree across structural updates.** This applies to the primary and auxiliary outputs, with or without MicroTS specialization. A generation-tagged UI node keeps its layout handle while it remains in the solver. Insertion creates new layout nodes; removal and reordering update child lists. Destroyed nodes release their measurement contexts and handles before those slots can supply another node's layout.

Structural synchronization projects the current UI tree into layout nodes. A Text element owns one measured leaf for its concatenated inline run; an empty run has no layout leaf. Moving inline text updates its old and new measurement owners. Each output owns its handle map, so a move between outputs cannot reuse a handle from another Taffy tree.

**Only changed layout styles and text measurement inputs invalidate Taffy caches.** Paint changes whose resolved layout inputs are equal skip the solver. Measurement inputs include the text, font slot, tracking, line height and provider choice. Font or provider replacement invalidates retained measurements. Reuse preserves the missing-glyph increments of the replaced measurement work. Root computation lets Taffy propagate changes through auto sizing and flex constraints while reusing child results whose constraints still match.

Structural projection, layout rounding and result readback still visit the tree. This implementation removes repeated node construction and unchanged text shaping; it does not guarantee work proportional to the number of changed nodes. `Show` branches retain their mount, unmount, ref and cleanup behavior. The opt-in region solvers below retain their separate boundary, wrapper and baked-layout handling; structural changes there rebuild the affected solver.

## Environment and layout regions

The native build accepts `specializationEnvironment` with `viewport`, `tickRate`, and `fontAtlases: [{ slot, bytes }]`. Generated `prepare_specialization(&mut ui)` must run **before the host loads styles and font assets**. The opt-in core records SHA-256 identities of the loaded bytes. Missing identities, different bytes, a viewport or tick-rate mismatch, a native text provider, or streaming font data disable the dependent region path. Generated `specialization_diagnostics()` exposes the reason outside the model command channel. A later mismatch disables regions until the application is mounted again.

Without supplied atlas bytes, `buildAot` retains a contract that declines the dependent optimization. The ordinary native build remains usable. Guest asset loading performs no specialization hashing or region registration.

**Each registered region has a separate Taffy tree.** A fixed-size root appears as a leaf in the parent solver. The child solver receives the parent's unrounded dimensions and cumulative origin; its readback retains the parent-relative root placement. Mutations dirty the affected solver. Invalid isolation or provider changes return the tree to the general layout path.

The `specializationTarget` build option requests layout and text-size baking. It accepts `aarch64-apple-darwin-std`; `host` selects that configuration on the matching host. The compiler builds a separate wasm artifact with `specialization-host`, which enables core's `std` configuration. Ordinary guest wasm retains its `no_std` configuration and has no baking exports. **Unknown targets and device targets without a golden use live layout.** Generated seeds check the runtime target and `std` feature.

The target golden covers **the `std`/`no_std` rounding difference at `0.49999997` pixels**: Taffy's host configuration rounds that position to 1 while the guest configuration rounds it to 0. A separate `specialization-inspect` artifact records the guest result. Host seeds come from the matching compiler artifact; the unqualified target identity cannot authorize a seed at runtime.

Baked layout tables contain parent indices, rectangles, and the region root's expected unrounded size and cumulative integer origin. Activation matches the live subtree against those parent indices. A size or placement mismatch discards the table and solves the region. Tables apply to the first solve; later geometry changes use Taffy. Nested registered regions and unsupported template geometry retain live layout. Regions whose wasm measurement or paint records missing glyphs retain live layout and painting to preserve `glyph_misses()`.

Build text sizes use a bounded cache keyed by font slot, revision, text, tracking, and line height. The default generated budget is 32 KiB; `specializationShapeCacheBytes` sets it. Font replacement invalidates entries. Cache hits reproduce the missing-glyph increments of runtime measurement. Native and streamed text use their existing measurement paths. An empty cache adds no lookup.

## Drawing and damage

Region draw caches retain words under a 64 KiB default word budget. Hosts can set it with `core.set_draw_cache_budget(bytes)`; zero keeps damage metadata while generating words each draw. Node changes invalidate containing regions and affected descendant regions. Ancestor placement, clipping, opacity, transforms, font revisions, and texture replacement participate in reuse. Perspective and streamed text use the general painter; missing-glyph runs retain their measurement side effects. Movement regenerates words when the cached placement differs.

**Static draw tables are shared Rust statics generated from wasm snapshots.** The supported words are RECT, GRAD_RECT, GLYPH_RUN, and balanced scissor operations. Exact placement and clip guards protect first-frame reuse. Textures, native text, transforms, rounded-resource branches, and nested registered regions retain runtime painting. A single RECT can patch a finite background-color domain when every candidate has nonzero alpha and all other paint branches remain fixed. Opacity crossing zero and arbitrary model colors retain runtime painting.

`RenderResources::draw_segments()` has a default empty implementation. Each damage tracker saves its segment baseline on successful `commit`. Unchanged segments require no op decoding; movement and order changes add old and new bounds. Changed segments compare their own slices, and structural differences damage that segment. Nested comparisons skip unchanged children. Proven color patches add their rectangles without decoding. Hosts still clear each damage rectangle and replay the complete DrawList clipped to it. **An empty segment history and table retain the legacy damage path.**

## Work counters

The `counters` Cargo feature in `microts` forwards to `pocketjs-core`. It records UI calls, node creation and destruction, binding evaluations and writes, update entry counts, layout work, DrawList work, and damage work. Feature-disabled builds contain no counter storage or counter increments.

```rust
let ui_work = app.ui().counters();
let core_work = app.ui().core().counters();
app.ui_mut().reset_counters();
```

`reset_counters` clears accumulated UI and core work. Live Taffy-node counts and cache bytes remain gauges. Draw counters separate total words from `generated_words`, region hits, and static-plan hits. Shape counters separate cache hits from shaping calls. `DamageTracker` owns its counter snapshot and reset operation.

`structure_rebuilds` counts fresh Taffy trees; `structure_syncs` counts retained topology reconciliations. `layout_passes` counts root computations and `measure_callbacks` counts the leaf measurements Taffy requests. The `counters` feature also exposes `force_layout_rebuild_for_validation()` for comparison against fresh tree construction.

`segment_table_bytes` counts the allocated capacities of the current draw segment table and the segment tables retained in region caches. The word budget excludes this metadata; the gauge exposes that cost alongside `region_cache_bytes`.

## Native differential harness

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

`apps/sensor-list/tape.json` covers empty text, numeric changes, keyed reorder and insertion/removal, conditional content, focus, scrolling, and viewport changes. START changes the first sensor value without changing the title or footer, for card-bounded damage checks. The harness accepts a handwritten model through `modelSource` and `modelExpression` for protocol boundary tests.

## PRD implementation status

| Requirement | State |
| --- | --- |
| R1.1–R1.2 analysis and warnings | Conservative report implemented; environment and geometry proofs remain prerequisites for baking |
| R1.3 counters | UI, layout, shaping, draw generation, cache, and damage work behind a Cargo feature |
| R1.4 sensor-list | Implemented with a deterministic tape |
| R2.1 scalar folding | Implemented for supported numeric operations, conditions, templates, and builtins; unsupported cases retain runtime evaluation |
| R2.2–R2.3 Build bindings and branches | Implemented with first-update timing preserved |
| R2.5 Build list rows | Implemented; dynamic rows retain existing reconciliation and memo comparison |
| R2.4 signal dependency guards | Ledger read masks with pre-clear changed snapshots and full-update fallbacks |
| R2.6 focus table | Optional; existing traversal retained |
| R3 environment contracts and regions | Byte identities, guarded activation, independent solvers, and deoptimization |
| R3 baking and shaping cache | Target-gated wasm tables, raw placement guards, and bounded text-size seeds |
| R4 draw cache and static plans | Bounded region words, shared Build tables, guarded root RECT color patches |
| R4.2 runtime texture-handle patches | Image and texture-backed paint retain runtime generation; no static handle patch |
| R4 segmented damage | Per-tracker committed baselines, nested comparisons, structural and order changes, patch rectangles |
| Section 6.5 representation changes | Conditional on device measurements; no representation change |
| Section 7 verification | Native differential harness, full-word and pixel comparisons, region/cache boundaries, host target golden; device measurements pending |

PSP/ESP32 timing, binary section sizes, cache capacity selection, and target baking enablement require device or target-build evidence. Work counts establish a reduction in computation; they do not establish a device frame-time reduction.
