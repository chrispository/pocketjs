# PocketBook runtime design

**The main thread owns inkview's event loop; a render thread owns the PocketJS
guest, UI surface, framebuffer, and panel refresh state.** The threads exchange
`inkview::Event` values through an `mpsc` channel. The guest and UI do not share
mutable state across threads.

Build and deployment commands are in the [host README](../README.md).
[Host integration](INTEGRATION.md) describes application packaging and boot.

## Module ownership

| Module | Owns |
| --- | --- |
| [`main.rs`](../src/main.rs) | inkview startup, channel lifetime, guest boot, 33 ms turn timer, and display geometry |
| [`input.rs`](../src/input.rs) | Held button bits and the current pointer contact |
| [`framebuffer.rs`](../src/framebuffer.rs) | Current and previously presented RGBA buffers, damage tracking, and RGB24 blits |
| [`refresh.rs`](../src/refresh.rs) | Panel update mode, accumulated damage, and cleanup deadline |

`UiSurface` provides the shared native `ui` operations. `Guest` owns QuickJS.
The host loads `libinkview.so` at runtime and waits for the first `Init` event
before creating `Screen`. A closed event channel or `Exit` ends the render
loop. The main thread joins the render thread after inkview exits.

## Frame transaction

The render loop waits for events until its next turn deadline, then drains the
queued event burst. `KeyDown` and `KeyRepeat` set held bits; `KeyUp` clears
them. Pointer down/move replaces contact 0, and pointer up removes it.
`Show` requests a full redraw.

A turn performs the following sequence:

```text
input snapshot
  → Guest::frame_with_touches(buttons, centered analog, contacts)
  → UiSurface::tick()
  → Ui::draw()
  → retained RGBA raster update
  → changed-tile comparison
  → inkview pixel writes
  → panel refresh
```

The guest has fixed-step frame semantics. Wall-clock scheduling in the host
controls the interval between turns and panel update deadlines; it does not
supply a variable delta to `Ui::tick`.

## Geometry

The target profile fixes the logical viewport at 480×272 and density at 2.
The raster buffer is 960×544. If that buffer fits on the panel, it is centered
without enlargement. Otherwise, integer arithmetic chooses the limiting axis,
scales the other dimension to preserve aspect ratio, and centers the result.
Panel reads use nearest-neighbor sampling into the retained raster.

Pointer mapping subtracts the display origin, scales by
`logical_size / displayed_size`, and clamps to the logical bounds. This keeps
input aligned with the displayed content, including downscaled panels.

The packed touch word is `(id << 18) | (y << 9) | x`; each coordinate occupies
nine bits. The host uses contact ID 0 and leaves the analog lane centered.
The logical viewport must remain within the touch format's coordinate range.

## Retained raster and panel damage

`FramebufferPipeline` owns a complete current RGBA8 frame, the previously
blitted RGBA8 frame, and a core `DamageTracker`. It calls
`render_scaled_incremental` with the DrawList and the target density.

**An unchanged DrawList produces no raster work or tile scan.** For a changed
frame, the pipeline examines 16×16 tiles intersecting DrawList damage. It
compares pixels against the previous buffer and returns only tiles whose
pixels differ. A DrawList change that produces identical pixels causes no
panel update.

`blit_dirty` maps each changed tile into panel coordinates and writes its
sampled colors through `Screen::draw(..., RGB24(...))`. The caller then latches
the blitted tiles into the previous buffer. inkview performs grayscale
conversion for grayscale panels. The host does not maintain a separate Gray8
buffer or dithering pass.

A full redraw blits the complete retained frame, calls `full_update`, and
latches the entire buffer. The first frame and `Show` use this path. The
retained buffer already contains the current frame, so a panel redraw does
not require a second raster pass.

## Refresh policy

`Refresh::present` merges the changed tile rectangles for panel submission:

- When the panel is idle, it issues a `partial_update` over the damage box.
- When an update is in flight, it accumulates damage and issues
  `dynamic_update` calls more than 20 ms apart.
- After 200 ms without further dynamic-update damage, it issues a cleanup
  `partial_update` over the accumulated region.

The loop still calls `present` with an empty damage list so cleanup can run
on an otherwise idle frame. `Refresh::full` clears the accumulated region and
cleanup deadline after a full panel update. Panel timing and visual quality
remain device-dependent.

## Build and test dependencies

The standalone crate targets ARM Linux with glibc 2.23 through
`cargo-zigbuild`. The ARM build enables rquickjs's `bindgen` feature and needs
libclang. `build.rs` links the math compatibility shims in `src/compat.c` for
symbols absent from the target glibc. The inkview dependency is pinned in
`Cargo.toml`; no local sibling checkout is required.

Run the host's portable tests from the repository root:

```sh
cargo test --locked --manifest-path hosts/pocketbook/Cargo.toml
```

The input tests cover bit masks, touch packing, and display-to-logical
mapping. Framebuffer tests compare incremental output with full raster output,
check damage scoping, and check that identical pixels do not request panel
refresh. These tests do not simulate e-ink waveforms or firmware event timing.
