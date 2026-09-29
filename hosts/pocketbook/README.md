# pocketbook-host

The PocketJS UI runtime on **PocketBook e-readers**, rendered through the
[inkview](https://github.com/simmsb/inkview-rs) SDK.

It reuses the backend-agnostic `ui` surface (`pocket-ui-surface`) and the
core's software rasterizer unchanged, then:

- rasterizes the DrawList **incrementally** to a retained RGBA8 buffer at
  `480×272 @2x` = 960×544 (`pocketjs_core::raster::render_scaled_incremental`
  with a core `DamageTracker`), matching the `pocketbook` target profile in
  `contracts/spec/platforms.ts` — an idle frame costs zero raster work;
- pixel-diffs 16×16 tiles **inside the damage regions** and blits the changed
  pixels as `RGB24` (`framebuffer.rs`). The DrawList damage bounds the raster
  and the scan; the pixel diff trims the e-ink refresh to tiles that actually
  changed (a DrawList edit that renders identical pixels flashes nothing).
  inkview's `Screen::draw` converts `RGB24`→Gray8 internally on **grayscale**
  panels (PocketBook Verse) and writes RGB directly on **color** panels
  (PocketBook Era Color, Kaleido 3) — one blit path serves both;
- drives the panel with a partial/dynamic/full update policy ported from
  `inkview-slint` (`refresh.rs`);
- maps inkview keys → the spec BTN bitmask and the touchscreen → the framework's
  packed touch wire format (`input.rs`);
- runs the inkview event loop on the main thread forwarding into a channel, with
  a second thread owning the `Screen` and the fixed-cadence tick/render loop
  (`main.rs`, the `inkview-slint` demo model).

The 960×544 render is integer-fit centered on the actual panel (which varies by
model), so the host works across devices without per-model configuration.

See [Runtime design](docs/IMPLEMENTATION.md) for module ownership and
[Host integration](docs/INTEGRATION.md) for application packaging and boot.

## Device constraints

The host targets ARM Linux with glibc 2.23 and loads `libinkview.so` at runtime.
The grayscale PocketBook Verse is the known device configuration for rendering,
scale-to-fit centering, and animated partial updates. **Touch and hardware-key
behavior, idle ghosting, return from background, and color-panel output are
untested on hardware.**

## Build

One-time toolchain setup:

```sh
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild
# zig (brew install zig) and libclang (for rquickjs bindgen) are also required.
```

Cross-compile the host (from this directory):

```sh
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23
# → target/armv7-unknown-linux-gnueabi/release/pocketbook-host
```

Notes:

- `libinkview.so` is `dlopen`'d at runtime (`inkview::load`) — no SDK at build
  time.
- `rquickjs` ships pre-generated FFI bindings for common targets but not the
  soft-float `armv7-unknown-linux-gnueabi`, so the ARM build enables its
  `bindgen` feature (needs `libclang`). Native builds use the pre-generated
  bindings.
- LLVM lowers `f32::max/min` to C23 math symbols (`fmaximum_numf`, …) that
  PocketBook's glibc 2.23 predates; `build.rs` links a tiny shim
  (`src/compat.c`) providing them for the cross-build.
- `Cargo.toml` pins `inkview` to a git revision. A local sibling checkout is
  not required.

## Build the app bundle

From the repo root:

```sh
bun pocket compile --target pocketbook --manifest apps/hero/pocket.json --project-root .
# → dist/hero-main.js + dist/hero-main.pak
```

## Deploy

Connect the PocketBook over USB, then from the repo root:

```sh
bun hosts/pocketbook/deploy.ts             # auto-detects the mount point
# or explicitly:
bun hosts/pocketbook/deploy.ts /run/media/$USER/PB626
```

It installs `applications/pocketjs-hero/{pocketjs-hero, app.js, app.pak}`.
Eject safely and launch **pocketjs-hero** from the launcher (a firmware rescan
or restart may be needed for a new app to appear).

## Runtime configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `POCKET_PAK` | `app.pak` | path to the app pak |
| `POCKET_JS` | `app.js` | path to the JS bundle |
| `RUST_LOG` | `info` | log filter (the host logs the panel size + geometry at startup) |

## Controls

| Device input | Guest input |
| --- | --- |
| Up / Down / Left / Right | Directional buttons |
| Prev / Next page keys | Left / Right |
| OK / Back | Cross / Circle |
| Menu / Home | Start / Select |
| Plus / Minus | Right / Left trigger |
| Touchscreen | One contact mapped to the displayed logical surface |

## Tests and logs

Run portable input and framebuffer tests from the repository root:

```sh
cargo test --locked --manifest-path hosts/pocketbook/Cargo.toml
```

The startup log records panel dimensions, render dimensions, displayed size,
and centering offsets. On a 758×1024 panel, the 960×544 render becomes
758×429 and is centered vertically. Use that geometry when diagnosing touch
offsets or clipped output.

The `.app` launcher redirects the host's stdout/stderr to
`applications/<app>/pocketjs.log` on the device storage (visible over USB), so
the startup geometry line and any `RUST_LOG` output survive a run. Bump the
filter with `RUST_LOG=debug` in the launcher for verbose traces.
