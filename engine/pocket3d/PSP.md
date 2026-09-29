# Pocket3D on PSP

**`pocket3d-gu` records sceGu commands into a display list owned by the host.**
It consumes cooked `.p3d` worlds, portable BSP visibility data, and dynamic
colored meshes. The same host can draw a PocketJS UI after the 3D pass.
Application rules, input mapping, and scene composition belong to the game.
[OpenStrike](https://github.com/pocket-stack/open-strike) is one consumer.

## Components

| Component | Responsibility |
| --- | --- |
| [`pocket3d-bsp`](crates/pocket3d-bsp/) | GoldSrc BSP/WAD data, collision, PVS, and the cooked reader |
| [`pocket3d-cook`](crates/pocket3d-cook/) | Desktop BSP/WAD-to-P3D conversion |
| [`pocket3d-gu`](crates/pocket3d-gu/) | PSP camera state, world batches, sky, and dynamic meshes |
| [`hosts/psp`](../../hosts/psp/) | QuickJS hosting, UI DrawList submission, memory, and presentation |

The cooked reader and renderer use `no_std` with `alloc`. The desktop cooker
uses `std`. The GU crate is outside the desktop workspace so the PSP target
and its toolchain do not enter ordinary desktop builds.

## Cook a world

From the repository root, with BSP and WAD assets available:

```sh
cargo run --locked --manifest-path engine/Cargo.toml -p pocket3d-cook -- \
  /path/to/maps/de_dust2.bsp --wads /path/to/support -o dust2.p3d --verify
cargo run --locked --manifest-path engine/Cargo.toml -p pocket3d-cook -- \
  --verify-cooked dust2.p3d
```

The cooker also searches the map directory and sibling `support/` and `wads/`
directories. `--subdivide UNITS` controls the maximum edge length used when
baking lighting into vertices. Missing textures fail verification unless
`--allow-missing-textures` is set.

The binary starts with a `P3D1` header, version, and section count. A
little-endian table contains `(tag, offset, length)` records. Payloads are
16-byte aligned; section order is unrestricted and unknown tags are ignored.

| Section | Contents |
| --- | --- |
| `WVTX` | 20-byte vertices: float UV, ABGR lighting color, i16 XYZ, padding |
| `WIDX` | u16 indices relative to each batch's vertex base |
| `WBAT` | Texture and surface-kind batches |
| `WFAC` / `WRUN` | BSP face runs and brush-entity runs |
| `WTEX` | Swizzled CLUT8 texels, RGBA8 palettes, and mip chains |
| `WVIS` | Render BSP, leaves, marksurfaces, and compressed PVS |
| `WCLP` | Planes, collision hulls, and solid entities |
| `WENT` | Spawns, lighting parameters, and map bounds |
| `WSKY` | Optional sky data |

`pocket3d_bsp::cooked::read` borrows vertex, index, texture, and palette bytes
from the input. It allocates CPU-side collision and visibility structures.
**Keep the cooked byte buffer alive while the renderer uses it.** Embedded
assets can be read from the module image after a data-cache writeback.
The reader requires a little-endian target.

## Frame ownership

The caller owns display-list allocation, synchronization, framebuffer/depth
storage, swapping, and pacing. The renderer does not call `sceGuStart`,
`sceGuFinish`, `sceGuSync`, or `sceGuSwapBuffers`.

A frame composes these passes:

```text
host starts the GU display list
  → begin_3d(camera)
  → sky::draw
  → WorldRenderer::draw
  → mesh::draw_color_tris for actors or a viewmodel
  → end_3d()
  → host's 2D UI DrawList pass
host finishes, synchronizes, and presents
```

`begin_3d` sets projection/view matrices, inverted 16-bit depth, modulated
texturing, and bilinear/nearest-mip filtering. `end_3d` disables depth,
clipping, alpha testing, and texturing before the UI backend restores its
own per-batch state. `mesh::clear_depth_for_viewmodel` clears the depth buffer
before drawing first-person geometry.

The world renderer combines PVS with camera-frustum and face-facing tests.
It groups visible index ranges by material, uses the cooked vertex-lighting
color, and applies alpha testing to masked surfaces. `last_faces`,
`last_tris`, `last_indices`, `last_visibility_us`, and `last_submission_us`
report work from the last world draw.

## Memory and synchronization

`FramePool` retains 64 KiB blocks for transient index and vertex uploads.
Allocations are 16-byte aligned, and one allocation cannot exceed a block.
**Reset or overwrite a frame pool only after the GE has finished reading it.**
Use `upload` to copy data and write back the CPU cache before GE access.
Caller-owned buffers need the same lifetime and cache discipline.

`WorldRenderer::new_cached` can copy complete texture mip chains and geometry
into caller-supplied bounded storage, such as spare VRAM. Data that does not
fit remains in its original storage. Residency does not change per frame.
The renderer reports copied texture and geometry byte counts.

The application must budget for embedded assets, parsed collision/visibility
structures, retained frame pools, the guest heap, UI resources, and framebuffer
storage. A cooked file's size is not the application's total RAM requirement.

## Tests and debugging

Run the portable BSP and cooker tests from the repository root:

```sh
cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d-bsp -p pocket3d-cook
POCKET3D_TEST_MAPS=/path/to/game-data \
  cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d-bsp --test real_maps
```

`POCKET3D_TEST_MAPS` points to a directory containing `maps/*.bsp` and WAD
resources. Without it, tests requiring those external maps are skipped.
Use the consuming game's build and input script for a PSP EBOOT. The shared
[DevTools guide](../../docs/DEVTOOLS.md) describes the host debug transport.
Emulator captures exercise rendering and replay; hardware measurements are
needed for GPU timing and presentation behavior.
