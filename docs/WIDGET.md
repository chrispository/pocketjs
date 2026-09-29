# Desktop widgets and embedded app surfaces

**`pocket-widget` combines a desktop window, fixed-rate guest ticks and
rendering on demand.** A 3D widget binds PocketJS output to a model’s screen
material. A flat widget renders the same UI surface into its window.
`pocket-stage` supplies the 3D host and `pocket-note` supplies the flat host.
See [runtime composition](RUNTIMES.md) for guest and native ownership.

## 1. Components

A widget window is transparent, undecorated and always on top. The guest keeps
its fixed simulation rate while the host renders when visual state changes.
Models, part maps and application behavior belong to the package or guest.

| Piece | Role |
| --- | --- |
| `shell` | The window contract and its event loop: transparent / undecorated / always-on-top with occlusion suspend, per-press drag-to-move / resize-grip policy hooks, optional live resizing, and the governor of §4 — fixed-rate guest ticks, demand-driven GPU frames, with a frames-vs-ticks receipt logged on exit. One governor, two widget shapes: `WidgetGame` (3D — scene, camera, embedded screens) and `FlatWidget` (2D — the window IS the `ui` surface, one `render_words_scaled` pass, no scene). |
| `embed` | A full PocketJS `ui` surface rendered off-window: `pocket-ui-wgpu` draws the core's DrawList into a persistent `OffscreenTarget`. A semantic glTF material override binds that texture view directly to the authored screen primitive. A screen inside a widget is a *real app*, not a video or a second overlay window. The per-tick DrawList content hash is the dirty signal. |
| `parts` + `pick` | The interaction vocabulary: named part shapes (`btn_cross`, `dpad_up`, `nub`, `screen`) → spec BTN bits, analog packing (raw extremes 255/1, never 0), the shared uihost keyboard map, and cursor-ray picking against oriented part bounds (event-driven, CPU, cold path). Procedural shells can register parts directly; authored shells declare cheap proxies in package data, so visual topology never enters the picking hot path. |

The crate does not own product-specific models, part maps or guest behavior.

## 2. The 3D host: pocket-stage

**Pocket Stage** is the model-neutral process contract that combines an
authored 3D asset, camera policy, interactions, and one or more live Pocket app
surfaces inside a low-power widget window. The checked-in PSP and iPod nano
packages use `EmbeddedUi` and `PartMap`:

- Borderless, transparent, always-on-top window framing a 3D PSP.
- The PSP's screen is a live 480×272 PocketJS `ui` surface — the same
  DrawList renderer that drives PSP hardware, **not** an emulator. PPSSPP
  renders a machine; we render the *app*, because the app was never
  PSP-binary-shaped to begin with.
- The PSP's buttons are pickable meshes. Click CROSS and the guest's next
  `frame(buttons, analog)` carries `BTN_CROSS` — the identical bit the real
  hardware's pad register produces. Drag the analog nub and the guest sees
  the same packed axes a real nub produces.
- Therefore: **any PocketJS app whose fixed viewport variant passes the
  Stage surface admission boots unmodified.** The outer macOS window has
  `form: "widget"`, but the guest is mounted on a screen mesh and therefore
  resolves against `form: "embedded"`. A fixed 480×272 PSP/Vita app fits;
  a dynamic-only desktop app such as Pocket Note is correctly rejected until
  it declares a compatible fixed variant.
- The iPod package selects a different 176×132 surface and tall camera/window
  framing through the same profile loader. Its click wheel is the first
  `rotary-wheel@1` adapter: circular drag or trackpad scroll over the ring is
  quantized to ordinary UP/DOWN BTN edges, while tap sectors deliver MENU,
  previous, next, and play/pause. No iPod-only guest ABI or native process
  exists.
- Its music demo uses the existing svc queue as a companion boundary. The
  guest owns navigation and displays metadata; the macOS host owns local WAV
  paths and playback. Paused audio and a settled DrawList produce no periodic
  GPU work. Launch the complete package with `bun run widget:ipod`.

The source remains in the historical `engine/pocket3d/examples/handheld` directory
but the Cargo package, binary, process, and window title are `pocket-stage`.
Asset type is data, not a process fork:
an iPod, phone, laptop, TV, or room-with-monitor should change the package and
typed manifest extension, not introduce another native runtime.
**The host reads `profile.json`.** Section 6.1 describes a package-manifest
design; that schema is not an accepted input to this loader.

The host components are:

```
pocket-stage (Rust bin, macOS)
  = widget shell        (pocket-widget: window, picking, part input, power)
  + stage package       (glTF LODs, views, interactions, provenance)
  + mounts `ui` slots   (pocket-ui-wgpu → OffscreenTarget → display material)
  + pocket-mod guest    (one unmodified PocketJS app bundle + pak)
```

The guest uses the existing `ui` surface. Window composition, model picking
and screen-material binding belong to the host.

## 2b. The flat host: pocket-note

`examples/note-widget` and `apps/note` provide a **markdown sticky note** whose borderless, resizable,
always-on-top window is nothing but a `ui` surface — no scene, no camera,
one `render_words_scaled` pass on dirty frames. It exercises everything the
3D form doesn't:

- **The window is the app.** `FlatWidget` + `run_flat` share the governor;
  a settled note requests no GPU frames until its DrawList or window changes.
- **Live resize is a relayout, not a reboot.** The host tracks the window,
  calls `Ui::set_viewport` (clamped to the DrawList i16 range) and tells the app, which re-wraps text against
  the new width via the framework’s `resizeViewport()`. Borderless
  windows keep macOS edge-resize; the shell also tracks an explicit
  grip-corner drag (`resize_at`, `WidgetConfig::resizable`/`min_size`).
- **The svc channel is the desktop companion contract.** The spec mailbox
  (ops 30..32) needs no new ops for a host that lives in-process: real
  keyboard/mouse/wheel/resize go to the guest as JSON lines
  (`{t:"ch"|"key"|"mouse"|"scroll"|"resize"|"load"}`), save/quit intents
  come back (`{t:"save"|"quit"}`). The app source retains a svc-less
  read-only fallback, but the current Note manifest is dynamic-only; it must
  add a fixed viewport variant before a PSP or embedded host can admit that
  fallback. No separate `widget` surface is exposed.
- **The desktop profile declares six capabilities** (`input.text`, `input.pointer`,
  `input.ime`, `host.clipboard`, `display.viewport.live`,
  `text.glyphs.runtime` — each a distinct observable guarantee; a real
  pointer is NOT `input.cursor`), and a `macos-widget` target
  profile (hostAbi 3, density 2, `dynamicViewport` range) provides them.
  Target semantics live in queryable profile FIELDS (`platform`,
  `form` — takeover/window/widget/kiosk/embedded); ids are labels
  (convention `<platform>-<form>`),
  and apps declare viewport intent per policy (`fixed`/`dynamic`
  variants), not per target. Pocket Note currently declares only a dynamic
  variant and is therefore intentionally admitted by `macos-widget`, not by
  PSP/Vita or an embedded Stage screen. Its desktop-only APIs sit in
  `enhances`; if the app later adds a fixed variant, the same source can
  degrade to a read-only note on hosts without those features. Native hosts
  assert identity (`__host`/`__hostAbi` vs the plan's target), and
  `bun run note` builds through the manifest — density and features come from
  the profile, not flags.
- **Clicks are CIRCLE.** The host synthesizes the spec press button while
  the mouse is down; the app resolves hover → focus (`hitFocusable` +
  `focusNode`) from svc mouse moves, and the framework's stock onPress
  pipeline dispatches — including into Portal overlays (the hit-test root
  includes the overlay layer).
- **Text editing without an OSK.** The `pocket3d` `Input` provides a per-frame
  edit-keystroke stream (chars with layout applied, named keys, repeats)
  and a wheel accumulator; the guest's editor (measured soft wrap, caret
  math, click-to-caret, drag selection, a coalescing undo/redo stack
  driven by ⌘Z/⇧⌘Z) is pure JS over `measureText`, unit-tested in bun.
  Preview mode gets browser-style drag selection over the rendered rows
  (select.ts — (row, char) space, boundary rows clipped, code blocks
  atomic) and clicks are inert, exactly like a real markdown preview —
  edit mode is entered through the eye/pencil toggle. ⌘C/⌘X/⌘V complete
  the clipboard both ways (the host pipes copy intents to the system
  clipboard and reads it back for paste).
- **IME input without a charset.** The shell enables OS composition
  (`WidgetConfig::ime`); preedit/commit ride the Input's `ime_events`
  stream into svc lines, the guest splices the preedit at the caret with
  an underline, and reports its caret rect back so candidate windows dock
  next to the text. Coverage is solved at RUNTIME: the host rasterizes
  unseen codepoints from a system CJK font (mmapped), appends them to the
  pak's FONT ATLAS v3 blobs (cmap stays sorted, coverage is gid-linear —
  appending is cheap) and reloads the slot through the spec
  `loadFontAtlas` op; the wgpu renderer re-uploads any slot whose glyph
  count moved. No charset guessing, no megabyte paks — a note types 你好
  and two glyphs are baked on the spot.
  Mouse lines carry the primary-button state so the guest sees press/
  drag/release, and the guest tells the host while its menu is up so
  header clicks reach the menu backdrop instead of starting a window
  drag.

## 3. Input: from meshes to BTN bits

The bridge is deliberately dumb — a static table, no gameplay logic:

- **Buttons.** `btn_cross/circle/square/triangle`, `dpad_up/down/left/right`,
  `btn_start/select`, `trig_l/r` map 1:1 to the spec BTN bits. Mouse-down on
  a profile proxy sets the bit until mouse-up; keyboard chords compose into
  the same word (the OSK needs them). The visual model stays a single scene
  instance; input does not traverse or mutate its 80k–132k triangles.
- **Analog nub.** Drag within the nub's radius maps to the packed axes
  (`(x << 8) | y`, 0–255, 128 center); release springs back to center.
  Extremes are raw 255/1 — never 0 — matching the input-tape convention.
- **Rotary wheel.** A package-declared canonical XY annulus uses ray/plane
  intersection plus `atan2`, unwraps the ±π seam, accumulates 12° detents,
  and inserts a neutral guest tick between UP/DOWN pulses. A tap that never
  crosses a detent resolves to the nearest named angular sector. Trackpad
  scroll is consumed by the wheel only while the pointer is over the ring;
  elsewhere the same gesture continues to orbit the stage.
- **Keyboard, always.** The uihost key map (arrows, Z/Enter = CROSS, …) is
  mounted for keyboard input. Mouse and keyboard input produce one
  `buttons` word per tick.
- **Picking is event-shaped.** A cursor ray against profile-authored oriented
  boxes runs only on mouse events, never per frame. Mesh triangle count is
  therefore irrelevant to picking cost. Profiles can be generated or hand
  tuned once per shell without adding model-specific runtime code.
- **Transparent pixels do not enable click-through.** The window retains its
  input region. Dragging an inert part moves the window through the shell’s
  per-press `drag_at` policy.

## 4. Power: two rates, one clock

The determinism laws stay intact — and they are what make low power *cheap*
to implement:

- **The guest ticks at a fixed 60 Hz, always.** One guest turn per host tick
  (Law 3); tapes, goldens, and replays hold inside the widget. An idle
  QuickJS tick over a settled app is microseconds — the PSP does it at
  333 MHz.
- **GPU frames are demand-driven.** A frame renders only when something is
  dirty: the `ui` core produced a different DrawList (cheap content hash per
  tick — DrawLists are small), a pose/morph changed (button press), the
  camera or window moved, or hover state changed. No dirt → no render pass,
  no present; the compositor retains the last frame. A PSP showing a settled
  menu costs **zero GPU frames**.
- Native baked animations (the styles.bin timelines) run in the core, so
  "app is animating" is a core-side fact, not a guess.
- `max_fps` pacing (sleep, not spin) bounds the active case; macOS occlusion
  events suspend rendering entirely while ticks continue, so the app stays
  live behind other windows.
- The windowed shell explicitly requests wgpu's `LowPower` adapter. On Apple
  Silicon that remains Metal on the integrated Apple GPU; headless tooling and
  full-screen game hosts keep the existing `HighPerformance` default.
The shell reports guest ticks, rendered frames and redraw sources on exit.
Use those counts with process CPU time and resident memory to measure idle and
active behavior. Process measurements do not measure GPU power.

## 5. Screen fidelity

A 480×272 texture sampled in perspective shimmers. Levers, in order:

- **Render the surface at density 2** (960×544) — the Vita host already
  proved the same logical layout renders at density 2 with density-2 paks;
  the widget can reuse that asset path. The handheld's v1 renders density 1
  (480×272, the byte-exact golden flavor) and leans on the framing instead.
  The flat form (§2b) uses `UiRenderer::render_words_scaled`
  multiplies DrawList coordinates into the physical target while density-2
  atlases land 1:1 — the Vita presentation model on wgpu, built with
  `bun tools/build.ts <app> --density=2`.
- Mipmaps + anisotropic filtering on the screen material; default framing
  keeps the screen near-parallel to the view.
- **Two framings**: "desk" (whole device, ambient) and "focus" (screen fills
  the window, near-flat — effectively uihost with a bezel). Double-click the
  screen to toggle; framing and orbit animate to exact front together. The
  second double-click restores the exact pre-focus desk orbit, including across
  repeated or mid-animation reversals. Focus mode is how you actually *use* the
  app for minutes at a time. Two-finger trackpad scrolling is reserved for
  orbiting the model and pauses during focus transitions, so framing and
  rotation cannot conflict.

## 6. The stage package convention

**The host loads model and interaction data from `profile.json`.** The package
contains GLB assets and semantic display materials:

- The bundled PSP shell is Dibad's CC BY 4.0 community model, cooked into a
  131,680-triangle settled LOD and an 80,879-triangle orbit LOD. Attribution
  and trademark caveats ship beside both GLBs. Runtime loading downsizes any
  overlarge embedded texture to 1024 px.
- The screen material exports `extras.pocket3d_role = "dynamic_screen"` (a
  `P3D_dynamic_screen__` name prefix is the compatibility fallback) and valid
  normalized `TEXCOORD_0` UVs. The loader requires exactly the primitive count
  declared by the profile, replaces its base-color view with the persistent
  480×272 `EmbeddedUi` target, and forces that material white, unlit, and
  opaque. Nothing deletes or edits mesh geometry at runtime.
- The transitional `profile.json` declares the two relative LOD paths,
  attribution file, model width and orientation, screen semantic, and named
  CPU pick boxes. LOD bounds
  must agree after canonical scaling. Two-axis `MouseWheel` input is the
  primary orbit control (precise macOS pixel deltas make this a natural
  two-finger gesture); right-drag remains the ordinary-mouse fallback. Either
  path swaps only the model asset, then restores the quality LOD after the
  gesture settles, renders once, and lets the compositor retain that
  framebuffer. A small exact-front magnetic dead zone plus a wider release
  threshold makes `(0, 0)` easy to land on without jitter; raw gesture input
  keeps accumulating inside the dead zone so a deliberate movement can always
  pull the camera away. An optional `suppressed_materials` list binds a
  transparent 1×1 texture to cosmetic layers such as an overly dark LCD glass
  sheet; geometry remains untouched and the policy stays model data.
- Independently cooked LODs share a content-addressed `ModelTextureCache`.
  This PSP uploads 19 unique material textures and records 19 reuse hits for
  LOD3, instead of retaining duplicate GPU texture sets; only the two geometry
  buffers remain separate.
- A package for another device or room uses the same binary and render mechanism: cook one or more GLBs, tag every live display material,
  and provide a stage manifest. Different geometry, material count, triangle
  count, screen count, camera layout, and controls do not require a new
  runtime. A single visual artifact can serve every LOD role when
  simplification is unnecessary.

### 6.1 Package manifest design

**The following manifest describes a design, not an accepted loader input.**
The `profile.json` format above remains the host’s input. The proposed records
separate app requirements, package assets and runtime state:

| Term | Meaning |
| --- | --- |
| `pocket-widget` | Reusable OS-window, fixed-tick, dirty-frame, and embedding capability. |
| `pocket-stage` | The model-neutral runtime/binary/process that loads one stage package. |
| stage package | Versioned distributable directory rooted at `pocket-stage.json`. |
| artifact | One immutable package file: a GLB LOD, interaction sidecar, IBL, or notice. |
| surface slot | Stable injection point such as `display.main`; never a material index. |
| instance | Runtime state such as current LOD, orbit, focus, and app bindings. |
| scene | Internal `pocket3d::scene::Scene`; not a second product or process name. |

The stage manifest follows `pocket.json` conventions: JSON Schema 2020-12, a
`$schema` URI, one integer major discriminator (`pocketStage`), reverse-DNS
IDs, SemVer, `additionalProperties: false`, and package-relative paths that
cannot escape the package root. It does **not** replace the app manifest. The
authority boundary introduced by the platform contracts remains intact:

| Input | Owns |
| --- | --- |
| app `pocket.json` | App intent: entry, framework, capabilities, fixed/dynamic viewport variants. |
| `pocket-stage.json` | Package facts: visual artifacts, semantic screen slots, display facts, views, interaction adapters, notices. |
| Stage host profile | Runtime facts: actual platform, `form: "embedded"`, host ABI, implemented capabilities. |
| `ResolvedBuildPlan` | The one admitted app variant and its resolved viewport/features. |
| `ResolvedStageLaunchPlan` | The verified app plan + package digest + chosen LOD/surface binding used by the binary. |

The outer desktop process still uses the `pocket-widget` window mechanism;
that does not make the guest a `macos-widget` target. A guest drawn into a
screen mesh resolves against an `embedded` profile derived from the selected
surface. Target ids are labels and must never be parsed to recover these
facts.

The current PSP package would describe its fixed display like this. Density 2
changes `physicalViewport` to `[960, 544]` and `rasterDensity` to `2`
without changing the app's logical coordinates:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-stage-1.json",
  "pocketStage": 1,
  "id": "dev.pocket-stack.stage.psp-eg02",
  "name": "psp-eg02",
  "title": "PSP EG02",
  "version": "1.0.0",
  "artifacts": {
    "visual.settled": {
      "path": "models/settled.glb",
      "mediaType": "model/gltf-binary"
    },
    "notice.attribution": {
      "path": "ATTRIBUTION.md",
      "mediaType": "text/markdown"
    }
  },
  "visual": {
    "canonical": { "units": "meters", "up": "+Y", "front": "+Z" },
    "lods": [{ "id": "settled", "artifact": "visual.settled" }]
  },
  "surfaces": [{
    "id": "display.main",
    "required": true,
    "binding": {
      "materialRole": "dynamic_screen",
      "texcoord": 0,
      "expectedPrimitives": 1
    },
    "display": {
      "physicalViewport": [480, 272],
      "logicalViewports": [[480, 272]],
      "presentations": ["native", "integer-fit"],
      "rasterDensity": 1
    },
    "uvContract": "normalized-full-span"
  }],
  "views": {
    "default": "desk",
    "focus": { "surface": "display.main", "restoreOrbit": true },
    "orbit": { "snapEnterDegrees": 2, "snapExitDegrees": 4 }
  },
  "provenance": {
    "noticeArtifact": "notice.attribution"
  }
}
```

The mounted app separately declares its policy, for example:

```json
"viewport": {
  "fixed": { "logical": [480, 272], "presentation": "integer-fit" }
}
```

An app intended for both a resizable flat widget and an embedded screen may
declare both `fixed` and `dynamic` variants. Resolution selects exactly one;
the stage package never copies or overrides app intent.

Core v1 should accept only fields with a real consumer. Identity, canonical
coordinates, visual artifacts/LOD roles, one verified surface slot, display
facts, view presets, material exclusions, and an attribution notice already
map to the transitional loader. Content hashes, byte counts, multiple live
surfaces, generic `kind`, and typed device/room extensions require matching
verifiers or adapters; a loader must reject fields it does not consume. Device controls (buttons, nub, rotary wheel) and
room controls (cameras, lighting, entities) belong behind named, versioned
adapters—not branches in the render governor.

The schema itself should have one TypeScript source
(`contracts/spec/pocket-stage.ts`), a generated byte-exact
`contracts/schema/pocket-stage-1.json`, JSON-Pointer diagnostics, strict unknown-field
rejection, and contract fixtures. Unsupported adapters, missing or multiply
matched surfaces, invalid full-span UVs, cross-LOD bound drift, package path
escape, and every declared-but-unconsumed field fail before GPU startup.

The bundled PSP launcher uses the app manifest: it resolves
the selected demo's `pocket.json` against a transitional
`macos-embedded` profile, writes a `ResolvedBuildPlan`, compiles from that
plan, and publishes the same target id/ABI through `UiSurface`. Full package
launch should extend that path rather than add a second resolver:

```text
pocket.json + pocket-stage.json + actual Stage host facts
                    │ resolve once
                    ▼
       ResolvedBuildPlan + ResolvedStageLaunchPlan
                    │
                    ▼
          compiler + one pocket-stage binary
```

The generalized launcher should accept `--manifest`, `--stage`, `--surface`,
`--project-root`, and `--outdir`; runtime-only flags follow `--`. The binary
then receives the two verified plans instead of guessing
`dist/<app>-main.{js,pak}` from `--app`. The scheduler (`tick_hz`, dirty-frame
latch, fps cap, occlusion policy) stays a `pocket-widget` invariant and is not
author-controlled stage metadata.

## 7. Guest interface limits

**Widget hosts expose `ui`, with host services through the existing `svc`
channel.** They do not expose `widget.led`, `widget.focus` or `widget.quit`
operations. Model hover, part presses, framing and occlusion remain host state
unless the host sends them through its declared service interface.

## 8. Validation

- Compare offscreen UI output against the shared core using the same DrawList,
  resources, viewport and raster density. Pixel comparisons require a matched
  render configuration.
- Picking tests cover ray/OBB intersections, rotation, ties, behind-origin
  rejection, nearest-part selection and analog extremes 255/1.
- `--click x,y` routes a window pixel through picking and button dispatch;
  `--tap circle@30` injects a button at a selected tick. The Hero proof script
  checks the named CIRCLE hit and final DrawList hash. Captures preserve the
  window’s alpha channel.
- The exit record reports ticks, rendered frames and redraw sources: content,
  resize, occlusion and scale. It also counts skipped redraws with no pending
  visual changes. Measure settled content and animation in separate runs.

## 9. Source locations and support limits

| Source | Interface |
| --- | --- |
| `pocket3d` | Semantic `load_glb*_with_overrides`, `Camera::screen_ray`, `Input::inject_cursor`, material alpha and double-sided policy |
| `pocket-ui-wgpu` | `UiRenderer::render_words` and `render_words_scaled` for an existing DrawList |
| `pocket-widget` | Window shell, frame scheduling, embedding, parts and picking |
| `examples/handheld` | `pocket-stage`, profile-driven GLB assets, LODs, screens, input and camera controls |
| `examples/note-widget`, `apps/note` | Flat widget, text editing, resize, clipboard and autosave; `tests/note.test.ts` covers guest behavior |

The bundled PSP and iPod profiles select raster density 1. The Stage host
reads `display.raster_density`; the flat host also supports density-scaled
rendering. Transparent-window click-through, per-camera sorting for overlapping
transparent layers, bold CJK fallback faces and line-start kinsoku are not
provided by these hosts. The Stage loader reads `profile.json`, not the package
manifest design in §6.1.

Disabling a window’s hit testing also stops mouse-move delivery. A click-through
implementation would need a way to detect pointer re-entry before it could
restore input; transparent pixels alone cannot supply that signal.

Dirty detection is an FNV-1a hash of the DrawList words — texture
generations ride along in the handles, so re-uploaded pixels change the
hash too.
