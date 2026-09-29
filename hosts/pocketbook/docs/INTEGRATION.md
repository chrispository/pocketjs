# PocketBook host integration

The PocketBook host runs a PocketJS JavaScript bundle through QuickJS and
renders the retained UI through inkview. **The application uses the
`pocketbook` target profile; the host owns panel geometry, input translation,
and e-ink refresh.**

For the host build, deployment, and runtime environment variables, see the
[host README](../README.md). [Runtime design](IMPLEMENTATION.md) describes the
thread, framebuffer, and refresh ownership.

## Application build

Run from the repository root:

```sh
bun pocket compile --target pocketbook --manifest apps/hero/pocket.json --project-root .
```

The Hero manifest produces `dist/hero-main.js` and `dist/hero-main.pak`.
The JavaScript file is separate from the binary PAK archive. The PAK contains
the style table, font atlases, images, and other resources consumed by
`UiSurface::feed_pak`.

The host identity is `pocketbook`, host ABI 5. Its logical viewport is
**480×272 at raster density 2**, producing a 960×544 raster buffer. Build the
application for that profile so the guest viewport, baked resources, and host
geometry agree. A different panel size changes presentation scaling, not the
logical application viewport.

## Guest boot and frame order

The render thread performs these operations after inkview sends `Init`:

1. Create `Screen` and determine the displayed rectangle from the panel size.
2. Read the JS bundle and PAK from `POCKET_JS` and `POCKET_PAK`.
3. Create `UiSurface::new_with_density`, set the host identity, and feed the PAK.
4. Create a `pocket_mod::Guest`, mount the UI surface, and evaluate the bundle.
5. Check that the bundle installed `frame`, then draw the first frame.

Each turn samples the button mask and touch contact, calls
`Guest::frame_with_touches`, advances `UiSurface::tick`, obtains the DrawList,
rasterizes its damage, and submits changed pixels to inkview. The host's
33 ms timer controls when turns run. E-ink panel updates have their own
partial, dynamic, and cleanup policy.

**The host reuses `pocket-ui-surface`.** A custom PocketBook application does
not need a second `HostOps` implementation or a GPU renderer. Keep game or
application state in the guest; native code owns the device mechanisms.

## Display and input constraints

The retained RGBA buffer is centered on the panel. When it does not fit, the
host scales it down with nearest-neighbor sampling while preserving aspect
ratio. The same displayed rectangle maps pointer coordinates back to logical
coordinates. Contacts outside that rectangle clamp to the nearest edge.

The host publishes one touch contact with ID 0, or an empty contact list after
release. It packs coordinates into the framework's 9-bit-per-axis touch wire
format. The 480×272 logical surface fits this format. Hardware keys are mapped
to the shared button mask; page-turn keys act as left/right.

The host writes `RGB24` pixels through inkview. inkview converts them for a
grayscale panel or writes them to a color panel. **Panel waveform behavior,
ghosting, and input latency depend on the device and firmware.** The host
README lists the supported configuration and untested device behavior.

## Source references

| Source | Responsibility |
| --- | --- |
| [`src/main.rs`](../src/main.rs) | Boot, event forwarding, frame order, and geometry |
| [`src/input.rs`](../src/input.rs) | Key mask, single contact, and coordinate mapping |
| [`src/framebuffer.rs`](../src/framebuffer.rs) | Retained raster, damage, tile comparison, and blitting |
| [`src/refresh.rs`](../src/refresh.rs) | Partial, dynamic, and full panel updates |
| [`pocket-ui-surface`](../../../engine/crates/pocket-ui-surface/) | UI guest surface and PAK loading |
| [`pocket-mod`](../../../engine/crates/pocket-mod/) | QuickJS guest lifecycle and frame calls |
| [`platforms.ts`](../../../contracts/spec/platforms.ts) | Host identity, viewport, and capability profile |

The [inkview-rs API](https://github.com/simmsb/inkview-rs) supplies
the screen and event interfaces; `Cargo.toml` pins the revision used by this
host.
