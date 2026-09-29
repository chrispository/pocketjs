# Application packages and runtime admission

**A guest package carries its manifest and target-specific artifacts.** The
build resolver admits each target variant against its host capabilities,
viewport and ABI. Hosts reject variants they cannot execute. The
[launcher](LAUNCHER.md) switches whole guests through the app-switching surface;
package loading and delivery belong to the host.

This document covers the `guest` execution class. The manifest also reserves
`aot` in `execution.classes`; guest hosts require a guest artifact.

## Package format

Spec: `contracts/spec/pocket-package.ts` (TS encoder/decoder) + `engine/core/src/package.rs`
(no_std zero-copy reader), pinned to one committed fixture so the two
implementations cannot drift. One file per app:

```
header   "PCKT" v1, manifest length, variant count
manifest pocket.json verbatim (the SAME file the build resolver admitted)
variants TARGET VARIANTS — dist bundles are target-flavored (psp density 1,
         vita density 2, a desktop widget's live viewport…), so the app is
         manifest × variants. Each variant: target id + hostAbi + a typed,
         APPEND-ONLY section table (1 identity, 2 plan, 3 js — NUL-included
         for zero-copy device eval, 4 pak, 5 cover, 6 reserved qjsc,
         7 fixed-width ESP-IDF host inputs; unknown kinds skip).
         Per-variant FNV-1a64: `thin` extracts a device subset from a
         universal file without changing any variant's identity.
footer   FNV-1a64 over the whole file
```

Tools: `bun run pocket:pack build --manifest … --target psp --target vita`
(each target compiles into its own output directory), plus `inspect`, `thin`, `verify` (footer + per-variant
re-admission of the embedded manifest). The launcher chain
(`tools/launcher.ts pack --target psp|vita`) emits target-thinned packages
into separate trees. Both native binaries embed the `.pocket` files verbatim
and boot guests zero-copy out of them; the site serves the PSP packages to the
wasm host.

Design rules:

- The manifest travels INSIDE the package and is re-admitted on device
  (below) — a package is self-describing, never trusted by filename.
- The hash footer detects incomplete copies and content changes.
  **FNV checksums provide integrity checks, not publisher authentication.**
- Corrupt or inadmissible packages fail into the launcher's existing
  broken-guest path (log + return to deck), never a halt.
- ESP-IDF variants duplicate their target ABI in the variant entry and binary
  host-input record. The device compares target, ABI, tick rate, viewport,
  density, presentation, and host-profile SHA-256 before exposing JS/PAK spans.

## Host admission and delivery

A host must verify package integrity and its target-specific admission contract
before exposing JavaScript or PAK bytes. Build-time admission uses
`validateAndResolveBuildPlan`; the package carries the admitted manifest and
resolved plan. A filename does not establish target identity or capability
support.

**Package format support does not imply a device installer.** Delivery paths
belong to the target host: embedded launcher packages, browser fetch, USB
transfer, or device storage. Consult the host's deployment instructions. A host
that loads packages into RAM must budget for the active JavaScript and PAK in
addition to the guest heap, native tree and textures.

Section kind 6 is reserved for QuickJS bytecode. The packer does not emit it.
A bytecode loader would also need to verify the exact QuickJS engine ABI;
source-based hosts must retain a compatible source artifact.

## Guest switching

The host completes and presents the outgoing frame before destroying its
QuickJS realm and UI core. It then initializes the incoming package with a
fresh realm, core and resources. **Switching does not preserve guest state.**
The frozen outgoing image is a visual transition asset, not a saved heap.

The PSP host can draw its baked switch veil outside the input-indexed guest
frame loop. It holds that image while the incoming JavaScript is evaluated;
the incoming guest's first presentation replaces it. Host transition frames
do not advance the guest tape. The veil uses one 128×128 RGBA texture and
host-rendered alpha geometry.

## Validation

Use deterministic sim traces and tree assertions for guest behavior. Exercise
GPU and lifecycle behavior through the target's emulator, then check the
physical device:

- PPSSPPHeadless exercises PSP GE sampling, texture-cache behavior and RAM
  limits. PSPLINK provides `reset`, `ldstart` and `pspsh cp` for device runs.
- Vita3K exercises the Vita host lifecycle, 960×544 CPU-reference captures,
  LiveArea packaging and GXM resource reuse. Install the corresponding
  `dist/vita/launcher-main.vpk` for a device check.
- Repeated guest switches must release the outgoing resources and preserve
  the input-frame identity used by captures and replay.

`tools/launcher.ts scan|covers|build` generates the launcher inputs. Package
hashes bind each validation run to its guest artifacts. Keep per-run captures,
logs and measurements in ignored `.pocket-build/validation/` output.
