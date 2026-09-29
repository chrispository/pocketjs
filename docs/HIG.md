# Pocket HIG: one vocabulary, one guideline per modality

Pocket applications do not run on one kind of device. A PSP has a d-pad,
four face buttons, two shoulders, START and SELECT, and no touch. An iPod
touch 4 has a touch panel, one Home button and nothing else. A Vita and a
New 3DS have both. **An application is written for a modality, and a
device is admitted only when its modality meets what the application
declares** (`contracts/spec/modality.ts`, `app.modality` and
`app.presentations[].modality` in `pocket.json`). Pocket Clear declares
`{ "touch": "primary" }` and the PSP refuses it at build time; Pocket
YouTube declares nothing at the app level and a two-screen presentation on
top, so every stock device compiles one of its two entries.

This document therefore has three parts: the intent vocabulary every
application declares, the guideline for the **buttons modality**, and the
guideline for the **touch modality**. A device with both (Vita, 3DS) follows
the buttons guideline for focus and the legend and the touch guideline for
direct manipulation, and the framework renders both from one declaration.

## 1. Intents, declared once

A presentation declares what it can do, not which button does it:

```ts
import { useActions } from "@pocketjs/framework/actions";

useActions({
  confirm: { label: "play", run: () => store.play(focused()) },
  action:  { label: "search", run: () => osk.open() },
  option:  { label: "save", run: () => downloads.start(focused()), hold: { label: "delete", run: remove } },
  back:    { run: () => store.stopPlayback() },
});
```

| Intent | Meaning |
| --- | --- |
| `confirm` | The primary verb on the focused or tapped item: play, open, submit. |
| `back` | Up one level of the presentation's own stack. At the root it does nothing; leaving the application belongs to the system layer. |
| `action` | The presentation's one contextual verb: search, compose, type. |
| `option` | A secondary verb on the item: save, share, details. `hold` names its destructive variant, which confirms through a `ClassicSheet`. |
| `sections` | Move between top-level sections, or skip in media. |
| `media` | Play/pause on a media screen, submit on a form. |

`useActions` (`@pocketjs/framework/actions`) binds the intents for the
presentation's lifetime and hands them to the modality: buttons render a
legend, contacts render controls, and a device with both renders both. A component that takes
focus, the OSK or a `ClassicSheet`, pushes the button-handler block, so the
intents stay bound and stay muted while it is up.

## 2. Buttons modality (PSP; Vita and 3DS with the pad)

### 2.1 Buttons

| Intent | PSP / Vita | 3DS | Rule |
| --- | --- | --- | --- |
| `confirm` | ○ | A | Acts on the focused control. |
| `back` | × | B | One level up; nothing at the root. |
| `action` | △ | X | Opens the keyboard wherever a field exists. |
| `option` | □ | Y | Hold 400 ms for the destructive variant. |
| `sections` | L / R | L / R | Also skip ±10 s in media. |
| `media` | START | START | |
| system | hold SELECT | hold SELECT | Never an application verb (§4). |

`glyph()` from `@pocketjs/framework/modality` spells these in hints, so one
literal renders `○ play` on a PSP and `A play` on a 3DS.

### 2.2 Focus is the selection

The d-pad moves one focus; `confirm` acts on it; the focused row carries the
`ClassicSelection` wash (tint plus left bar) on every device. A list with
no focused row shows no wash. **The keyboard opens on the layer and key the
user left** (`osk-session.ts`), because a d-pad user pays for every step
back to a key.

### 2.3 The legend

The footer strip states the live mapping: counter or status at the left,
the legend at the right, spelled with `glyph()`. **A verb without a legend
entry is not bound.** Errors turn the footer text red; nothing else moves.

### 2.4 Screen anatomy, 480×272

```
┌────────────────────────────────────────────────┐ 36  title bar: title · field · status
│ Pocket YouTube   [Search YouTube      ]  USB   │
├────────────────────────────────────────────────┤
│ ▌row                                         › │ 64  rows: flush, 1 px rule, selection wash
│  row                                         › │
│  row                                         › │
├────────────────────────────────────────────────┤ 24  footer: counter · legend
│            1/12 · ↕ browse · ○ play · △ search │
└────────────────────────────────────────────────┘
```

- **Title bar, 36 px**: title at the left with a 12 px margin, a search or
  filter field in the middle when the screen has one, status at the right.
  One strip; no second row under it.
- **Rows, 64 px**: flush with the screen edges, separated by the row's own
  1 px rule, selected with `ClassicSelection`.
- **Footer, 24 px**: the legend (§2.3).
- **Keyboard**: docks over the footer in the grid layout; the list shrinks
  by `oskHeight()`. The keyboard owns every button while open.
- **Modal**: `ClassicSheet` slides from the bottom over a scrim; × closes.

## 3. Touch modality (iPod touch 4; Vita and 3DS with the panel)

### 3.1 Gestures

| Intent | Gesture | Rule |
| --- | --- | --- |
| `confirm` | tap | Release inside the control; sliding off cancels (`ClassicButton`). |
| `back` | a left-edge swipe, or the bar's Back button | Both exist; the button is the legend of the gesture. |
| `action` | the field itself, or a bar button | Tapping a field opens the keyboard (`TextField`). |
| `option` | long press 500 ms | The row lifts; the destructive variant confirms through a `ClassicSheet`. |
| `sections` | swipe between pages, or a segmented bar | |
| `media` | tap the transport tile | |
| scroll | pan and fling | `VirtualList` owns rubber-band and decay. |
| scrub | drag along the rail | Previews live, commits one seek on release (`createMediaScrubber`). |

### 3.2 Targets and layout

- **Controls are at least 26 px tall on a 320-wide screen and 44 px on a
  phone-density panel**; rows are 64 px on both. A hit target may exceed
  the drawn cap (the 3DS tiles use pow2 caps clipped to the target).
- **No d-pad focus ring appears until the d-pad is used.** On a device with
  both inputs the wash follows the last tap and the ring stays hidden
  (`osk.tsx` and `VirtualList` apply this rule).
- **Legends name buttons only where buttons exist.** A pure touch device
  shows no `○ play`; its verbs are visible controls.
- **Keyboard**: the staggered layout at 30 px rows, characters on the down
  edge, backspace repeat, hold-space caret drag, double-shift caps lock.

### 3.3 Second screen (3DS)

The top screen shows content; the bottom screen is the touch modality's
control surface. Every intent renders there as a tile, and the pad's
buttons keep their §2 meaning at the same time, so a `ClassicSelection`
wash on the bottom list follows both the tap and the d-pad.

## 4. System controls

**Launcher switching destroys the outgoing guest and mounts the selected app
from scratch.** The frozen outgoing image remains available to the launcher;
it does not preserve application state. See [LAUNCHER.md](LAUNCHER.md) for the
host-owned SELECT interception used by multi-app hosts.

`installSystemLayer()` from `@pocketjs/framework/system` provides a guest-side
sheet with application identity, status, registered actions and a Close row.
On hosts that deliver SELECT to the guest, holding it for 400 ms of virtual
time opens the sheet. Applications can also call the returned `open()` method.
Touch controls should invoke that method from an explicit system control.

The launcher host can consume SELECT before it reaches the guest. The
framework does not expose a universal host chord table or an `app.state`
suspend/restore capability. Applications that need persistence must use an
admitted storage capability.

## 5. Framework APIs

| Feature | API or contract |
| --- | --- |
| Modality admission | `app.modality`, `presentations[].modality`, `framework/src/manifest/resolve.ts` |
| Per-device button names | `glyph()` from `@pocketjs/framework/modality` |
| Selection, buttons, sheets, bars, lists and spinners | `@pocketjs/framework/classic` |
| Keyboard and focus memory | `@pocketjs/framework/osk` |
| Whole-guest switching and frozen images | `@pocketjs/framework/launcher` |
| Intent bindings and legends | `useActions` from `@pocketjs/framework/actions`; touch controls read `entries()` |
| Guest-side system sheet | `@pocketjs/framework/system` |
| Coverage and indexed-image uploads on PSP and 3DS | `offload.uploadCoverage`, `offload.uploadIndexedImage` |
