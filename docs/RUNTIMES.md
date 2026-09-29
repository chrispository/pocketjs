# Runtime composition

This document defines native-core and guest-interface ownership for the 2D UI
runtime (`engine/core/` and its hosts), the 3D libraries (`engine/pocket3d/`)
and game hosts such as [OpenStrike](https://github.com/pocket-stack/open-strike).

## 1. Runtime composition

**A runtime combines native cores, declared guest interfaces and one guest
program.** Each core owns a specific subsystem, such as retained UI, physics
or audio. A surface exposes that subsystem through versioned operations,
events and asset formats. The guest combines the mounted surfaces through their
SDKs.

A UI runtime exposes nodes, styles, layout and focus. An FPS runtime exposes
rounds, weapons, hits and bots. These interfaces can differ while sharing guest
hosting, transport, rendering and resource code.

## 2. Components and ownership

### Core (Rust) — state and time

A core is a native simulation that owns its domain state and its clock:
`pocketjs-core` owns the retained UI tree, taffy layout, animation tracks and
the DrawList; an FPS core owns the map, player physics, ballistics, bot
navigation and the 3D scene. Cores are the only place where per-entity,
per-frame work happens. Cores never call into the guest.

Cores may share native substrate — `pocket3d` (wgpu device, render passes,
BSP collision, skeletal animation) is substrate, not a runtime: it has no
guest-facing vocabulary of its own. The 2D UI core renders through the same
substrate on desktop (`pocket-ui-wgpu`), which is what puts 2D and 3D on one
foundation.

### Surface — the declared vocabulary

A surface is the *entire* boundary between a core and the guest, pinned as
data in a spec (the `contracts/spec/spec.ts` pattern):

- **ops** — guest → core intent: commands and queries, synchronous, numeric
  codes, append-only. (`ui.createNode`, `ui.setStyle`, … / `strike.setPhase`,
  `strike.configureWeapon`, …)
- **events** — core → guest facts, delivered in per-tick batches.
  (`hit`, `kill`, `roundEnded`, …)
- **assets** — the binary formats the surface consumes (style tables, font
  atlases, paks; maps, models).
- **frame contract** — when the guest runs relative to the core's clock.

A surface is mounted into the guest as one named namespace (`globalThis.ui`,
`globalThis.strike`). Specs are single-source-of-truth TypeScript data,
code-generated into Rust, with a drift guard that byte-compares the generated
file in CI (`tests/contract.ts`). A surface is versioned by append: codes are
never renumbered, never reused.

**Capability = surface.** A guest can affect exactly what its mounted
surfaces express — nothing else. There is no ambient filesystem, network, or
process access. The host controls access by choosing which surfaces it mounts.

### Guest (QuickJS) — where products live

The guest is one QuickJS realm evaluating one bundled program. Apps, games,
and mods are indistinguishable in kind here; they differ only in which
surfaces they were given. QuickJS because it is embeddable everywhere Pocket
targets (it already runs on a 333 MHz PSP), deterministic, small, and fast
enough when the boundary is designed correctly (see the laws below).

### SDK — application-facing APIs

Raw surfaces are wire protocols. Their SDKs provide APIs suited to the
subsystem:

- The `ui` surface uses a reactive tree; its SDK provides **JSX**
  (Solid, Vue Vapor or Octane through the universal renderer, Tailwind
  classes, `animate()`).
- An FPS surface uses event handlers and configuration through a
  **mod API**: `strike.on("kill", …)`, `strike.rules.roundTime = 90`,
  weapon/bot config tables.
- Other genres choose their own: data tables, state machines, timelines.

The SDK must preserve the underlying surface’s operations and ownership
boundaries.

## 3. The three laws

Runtime interfaces follow these ownership and scheduling rules.

**Law 1 — State lives in cores; guests hold mirrors.**
Guest-side reads never cross the boundary in hot paths. The Solid renderer
keeps a JS mirror tree so the reconciler reads JS objects, not FFI; a game
SDK keeps mirrored snapshots updated from event batches. Ops are one-way
writes; queries exist but are for cold paths.

**Law 2 — Intent crosses as ops, facts cross as events, both spec-pinned.**
No shared memory, no callbacks-from-native mid-tick, no stringly-typed side
channels. Everything that crosses is enumerable, versioned, and cheap to
marshal (numbers, strings, buffers). This is what makes surfaces composable
and mods auditable.

**Law 3 — One guest turn per host tick.**
The host calls the guest exactly once per fixed-step tick
(`frame(buttons)` for UI runtimes; game runtimes add their event pump in the
same turn). The guest never owns a timer or a thread. Frame content is a pure
function of tick index + inputs, which is what makes byte-exact goldens,
headless tests and deterministic replay possible for a fixed build and
resource set.

## 4. The mechanism crates

The shared crates provide guest hosting, rendering and platform adapters:

| Crate | Role |
| --- | --- |
| `pocket-mod` | Guest hosting: QuickJS realm lifecycle, surface mounting (`mount("ui", ops)`), per-tick pump (frame call + job drain + timers), console, hot reload. The "mod runtime" capability, as a library. |
| `pocket-net` | Transport-neutral NET core and `globalThis.net` surface: validates bounded HTTP requests, owns handles/bodies and tick event batches, and accepts a host-owned `HttpTransport` adapter. See [NET.md](./NET.md). |
| `pocket-ui-wgpu` | The `ui` surface, desktop edition: feeds paks to `pocketjs-core`, exposes the 17 `HostOps` ops to the guest, renders the DrawList through wgpu into any render target — a window (standalone app host) or an overlay pass over a 3D scene (game HUD). |
| `pocket-widget` | The desktop-widget capability (WIDGET.md): a widget window shell whose guest ticks at a fixed rate while GPU frames render on demand, embedded `ui` surfaces bound onto meshes, and cursor-ray part picking mapped to declared inputs. `pocket-stage` is the first runtime on it; its bundled PSP stage runs admitted fixed-viewport apps unmodified. |
| `pocketjs-core` | The 2D UI core with a host-selected viewport. |
| `pocket3d` | Native substrate, desktop edition: wgpu bootstrap, forward renderer, glTF models, headless capture. |
| `pocket3d-bsp` | The portable half of the 3D substrate (no_std + alloc): GoldSrc maps, hull collision, the character controller, PVS visibility, and the cooked `.p3d` world format. Runs identically under wgpu and on the PSP. |
| `pocket3d-gu` | The 3D substrate, PSP edition: renders cooked worlds through the GE (sceGu) with PVS culling, CLUT8 textures, and dynamic meshes. |
| `pocketjs-psp` (lib) | Guest hosting + `ui` surface, PSP edition: the arena allocator, the QuickJS embedding, the DrawList GE backend (with an overlay mode for 3D compositing), pak feeding, and the DevTools mailbox — everything the 2D EBOOT proved, linkable by game EBOOTs. |
| `pocket3d-vita` | The 3D substrate, Vita edition: CPU projection and six-plane clipping into vita2d/GXM at 960x544, painter-sorted so a PocketJS HUD can share the same scene. |
| `pocketjs-vita` (lib) | Guest hosting + `ui` surface, Vita edition: QuickJS, density-2 pak/font resources, controller/dual-analog input, logical-coordinate front-panel contacts and a native-density 960x544 vita2d backend over the portable 480x272 logical layout. |

A specialized runtime is then a thin composition. OpenStrike is:

```
openstrike (Rust bin)
  = FPS core (pocket3d substrate + game systems)
  + mounts `strike` surface  (its own spec: ops/events for rules, weapons, bots, rounds)
  + mounts `ui` surface      (pocket-ui-wgpu, composited as the HUD overlay pass)
  + pocket-mod guest         (one realm running the product bundle)

product bundle (JS, built by the PocketJS two-pass pipeline)
  = gameplay mod  (strike SDK: round rules, scoring, weapon/bot tuning, kill feed)
  + HUD app       (ui SDK: Solid JSX, Tailwind, animations)
```

The PSP UI runtime combines a QuickJS guest, the `ui` surface and the sceGu
backend.

[Pocket Voxel](https://github.com/pocket-stack/pocket-voxel) inverts the
ownership split the other instances share: the GAME STATE lives in the
QuickJS guest (a TypeScript port of a Game Boy RPG engine) and the Rust core
owns only the retained diorama scene — cooked voxel chunks, billboards,
camera rungs, a GB UI tile layer — behind its own `voxel` surface, next to
the mounted `audio` module. It vendors this engine from its own repository.

**The PSP OpenStrike host combines** `openstrike-core` (the same FPS simulation) + `pocket3d-gu` over a cooked
map + the `pocketjs-psp` host library + the same `strike` surface mounted
through the raw QuickJS API. It executes the same rules and JSX HUD bundle as
the desktop host.

The HUD uses the PocketJS UI framework inside the game runtime. Mounting `ui`
provides that framework’s layout, input and rendering interfaces.

## 5. Discipline for new runtimes

To add a runtime for a new domain:

1. **Write the vocabulary first.** A `spec.ts` for your surface: ops, events,
   asset formats, enums. Keep it closed and small — if the list of nouns
   doesn't fit in a page, the domain is cut too wide. Codegen the Rust side;
   add the drift guard.
2. **Build the core against the spec**, on whatever substrate fits
   (`pocket3d`, `pocketjs-core`, neither).
3. **Mount surfaces with `pocket-mod`**, obeying the three laws.
4. **Provide an SDK and headless tests** with scripted input, deterministic
   randomness and screenshot or state assertions.
5. **Let the base game be the first mod.** If the built-in behavior can't be
   expressed through the surface, the surface is too weak — fix the surface,
   not the game. (OpenStrike's round rules, scoring and weapon tables are JS
   for exactly this reason.)

The shared runtime interfaces do not require a universal scene graph or
editor. Game code depends on the surfaces it uses and need not be portable to
a runtime that exposes different operations.
