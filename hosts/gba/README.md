# GBA MicroTS Hero

This experimental host builds the 240 × 160 [`apps/gba-hero`](../../apps/gba-hero) scene into a Game Boy Advance ROM. **MicroTS compiles the TypeScript model and TSX view into Rust.** The ROM runs the generated application, button input, signals, conditional content and animations without a JavaScript VM or operating system.

**Steady animation meets the two-VBlank presentation target in mGBA 0.10.5: 29.86 FPS.** A 60-second emulated sample with the Spinner layout region enabled has no missed deadlines; the same scene with the region disabled measures 11.20 FPS. A 30-second A/B input sequence measures 29.27 FPS with 11 missed deadlines. Startup and interaction can exceed the frame budget. Physical hardware has not been tested.

## Build

Run from a repository checkout with Bun and Rustup installed:

```sh
bun install --frozen-lockfile
rustup toolchain install stable
rustup toolchain install nightly-2026-07-01 --component rust-src
bun hosts/gba/build.ts
```

The command writes `dist/gba/gba-hero.gba`, `gba-hero.elf` and `build.json`. The build record includes commands, toolchain selection, ROM and ELF SHA-256 hashes, and asset sizes. `bun hosts/gba/build.ts --outdir=<directory>` selects another output directory. This build entry is available in the repository checkout; it is not part of the published npm package.

The Spinner layout region is enabled by default. Use `--spinner-region=off` to build a reference ROM with the same generated app and graphical assets. `build.json` records this switch as `spinnerLayoutRegion`.

Open `gba-hero.gba` in mGBA. Emulator keyboard bindings depend on the user's configuration. The action button starts with focus.

| GBA control | Action |
| --- | --- |
| A | Increment the counter once per press |
| B | Reset the counter |
| Up / Down | Focus the action button |

The build performs four steps:

1. Compile the strict MicroTS app and prepare its font and image resources.
2. Run the [desktop baker](bake/src/main.rs) with the retained core's layout and RGBA rasterizer to produce the background and dynamic layers.
3. [Pack the layers](assets.ts) into RGB555 palettes, background tiles and sprite tiles.
4. Build `core` and `alloc` for `thumbv4t-none-eabi`, link the startup code and host, then write the cartridge header and checksum.

## Runtime

The [startup code](src/start.s) initializes RAM and the stack before entering Rust. The GBA host provides the allocator and the `critical-section` implementation used by MicroTS's atomic fallback. That implementation saves the interrupt-enable state and restores it on exit.

**The LCD controller composes a Mode 0 background and OBJ sprites.** The static background stays in VRAM. The CPU runs the generated app and the retained core's layout, then maps model and animation values to sprite positions, tile references and pre-rendered frames. DMA uploads changed artwork and OAM attributes during VBlank. There is no per-frame software framebuffer or `core.draw()` call.

**The Spinner has an independent live layout tree.** Its 32 × 32 boundary has `shrink-0`; swapping its conditional image child rebuilds that region without rebuilding the surrounding page or measuring its text. The host registers the region after generated initialization. This path does not use target-baked layout seeds or enable the generated asset contract. RAM diagnostic word 31 reports whether the region remains active. In the measured run, peak heap usage rises from 61,952 to 98,976 bytes; the stack watermark rises from 26,532 to 26,540 bytes.

The sprite presenter reserves 35 OAM slots and 17,920 OBJ VRAM bytes. The assets include eight spinner frames, 145 underline widths, 21 button colors, counter glyphs and a conditional message. Font and image pixels are consumed by the desktop baker; the cartridge uses the resulting tiles.

The application advances simulation time by 1/30 second per update and schedules presentation after two hardware VBlanks when work fits the deadline. Two VBlanks take about 33.49 ms at the GBA clock rate. Spinner phase changes fit this budget; startup width animation, button state, counter text and conditional message changes can still trigger work outside the isolated region.

## Limits

This is a fixed Hero scene presenter. It does not translate arbitrary draw lists or dynamic Flexbox results into GBA tiles. The 240 × 160 adapter remains separate from the shared Hero view; consolidating that layout requires changes to its baked crops and sprite bindings.

Palette reduction limits color precision. Shadows and edge coverage are blended against the baked background. Underline width is rounded to a pixel and button colors select one of 21 samples. Layout changes require rebuilding the assets and updating the presenter bindings.

There is no audio, storage, networking or OS service layer. Emulator checks do not establish physical GBA support or a steady frame rate across all interactions. The [native regression](../../tests/gba-spinner-region.test.ts) compares live tree structure, layout bits, draw words and input behavior with the region enabled and disabled; emulator captures compare the hardware presenter. Keep ROM copies, measurements and screenshots in ignored `.pocket-build/validation/gba/` output or an artifact store.
