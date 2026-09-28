import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAot } from "../microts/compiler/aot-build.ts";

test("GBA Hero Spinner isolation preserves the live tree, layout, draw words and button behavior", async () => {
  const directory = resolve(".pocket-build/validation/gba", `spinner-region-native-${process.pid}-${Date.now()}`);
  const generated = resolve(directory, "generated");
  mkdirSync(resolve(directory, "src"), { recursive: true });
  // Match the cartridge build options. Both instances use this one generated
  // program; the only difference is native registration of the Spinner region.
  await buildAot(resolve("apps/gba-hero/app.tsx"), { outDir: generated, strict: true, format: false });
  writeFileSync(resolve(directory, "Cargo.toml"), `[package]
name = "gba-spinner-region-regression"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
microts = { path = ${JSON.stringify(resolve("engine/crates/microts"))}, features = ["std", "counters"] }
`);
  writeFileSync(resolve(directory, "src/main.rs"), `extern crate alloc;
#[path = ${JSON.stringify(resolve(generated, "mod.rs"))}]
mod generated;
use generated::AppViewModel;
use microts::{Input, NodeId, Ui, spec::btn};
use std::collections::BTreeSet;

type App = generated::AppApp<generated::AppModel>;

fn named(ui: &Ui, id: NodeId, name: &str) -> Option<NodeId> {
    if ui.debug_name(id) == Some(name) { return Some(id); }
    ui.core().node_children(id.0).iter()
        .find_map(|&child| named(ui, NodeId(child), name))
}
fn node(app: &App, name: &str) -> NodeId {
    named(app.ui(), NodeId::ROOT, name).unwrap_or_else(|| panic!("missing {name}"))
}
fn app(region: bool) -> App {
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(240.0, 160.0);
    assert!(ui.core_mut().set_tick_rate(30));
    // The hardware presenter consumes offline art. The retained cartridge UI
    // loads only styles; adding resident fonts here would test a different host.
    assert!(ui.load_styles(include_bytes!(${JSON.stringify(resolve(generated, "styles.bin"))})));
    let mut app = generated::AppApp::new(ui, generated::AppProps {}, generated::AppModel::default());
    assert!(!app.specialization_enabled(), "this host must retain its failed compiler contract");
    let spinner = node(&app, "Spinner");
    let style = app.ui().core().resolved_style(spinner.0).unwrap();
    assert_eq!((style.width, style.height, style.grow, style.shrink), (32.0, 32.0, 0.0, 0.0));
    assert!(!app.ui().core().is_layout_region(spinner.0));
    if region { assert!(app.ui_mut().set_layout_region(spinner, true)); }
    let button = node(&app, "HeroAction");
    app.ui_mut().set_focus(button);
    // Resolve layout without ticking the async model or the underline animation.
    app.ui_mut().core_mut().hit_test_bounds(-1.0, -1.0);
    app
}

#[derive(Debug, PartialEq, Eq)]
struct LiveNode {
    path: Vec<usize>,
    kind: u8,
    text: String,
    debug_name: Option<String>,
    child_count: usize,
    rect: [u32; 4],
    focused: bool,
}
fn tree(ui: &Ui, id: NodeId, path: &mut Vec<usize>, out: &mut Vec<LiveNode>) {
    let core = ui.core();
    let (x, y, w, h) = core.layout_of(id.0).unwrap();
    let children = core.node_children(id.0);
    out.push(LiveNode {
        path: path.clone(), kind: core.node_type(id.0).unwrap(),
        text: core.node_text(id.0).unwrap_or("").to_owned(),
        debug_name: ui.debug_name(id).map(str::to_owned), child_count: children.len(),
        rect: [x.to_bits(), y.to_bits(), w.to_bits(), h.to_bits()],
        focused: ui.focused() == id,
    });
    for (index, &child) in children.iter().enumerate() {
        path.push(index); tree(ui, NodeId(child), path, out); path.pop();
    }
}
fn equivalent(on: &mut App, off: &mut App, frame: usize) {
    assert!(!on.specialization_enabled() && !off.specialization_enabled());
    assert!(on.ui().core().is_layout_region(node(on, "Spinner").0), "region lost at frame {frame}");
    assert!(!off.ui().core().is_layout_region(node(off, "Spinner").0), "reference gained region at frame {frame}");
    let words_on = on.ui_mut().core_mut().draw().words.clone();
    let words_off = off.ui_mut().core_mut().draw().words.clone();
    assert_eq!(words_on, words_off, "draw words at frame {frame}");
    let (mut left, mut right) = (Vec::new(), Vec::new());
    tree(on.ui(), NodeId::ROOT, &mut Vec::new(), &mut left);
    tree(off.ui(), NodeId::ROOT, &mut Vec::new(), &mut right);
    assert_eq!(left, right, "live tree and layout bits at frame {frame}");
    assert_eq!(on.model.count(), off.model.count(), "count at frame {frame}");
    assert_eq!(on.model.phase(), off.model.phase(), "phase at frame {frame}");
    for name in ["HeroAction", "Underline"] {
        let a = on.ui().core().resolved_style(node(on, name).0).unwrap();
        let b = off.ui().core().resolved_style(node(off, name).0).unwrap();
        assert_eq!((a.bg_color, a.width.to_bits(), a.translate_x.to_bits()),
                   (b.bg_color, b.width.to_bits(), b.translate_x.to_bits()),
                   "presenter style {name} at frame {frame}");
    }
    // Conditional text must mount and unmount at the same count threshold.
    let message = node(on, "ReactiveMessage");
    assert_eq!(on.ui().core().node_children(message.0).len(), usize::from(on.model.count() > 3));
}

fn main() {
    let (mut on, mut off) = (app(true), app(false));
    equivalent(&mut on, &mut off, 0);
    let mut phases = BTreeSet::new();
    let mut colors = BTreeSet::new();
    let mut counts = vec![0];
    let mut saw_intermediate_width = false;
    let mut isolated_changes = 0;
    let (mut on_nodes, mut off_nodes, mut off_shapes) = (0, 0, 0);
    for frame in 0..180 {
        // Four distinct down edges, including held frames, then B reset. Focus
        // is cleared and restored through directional input after the reset.
        let buttons = match frame {
            40..=42 | 50..=52 | 60..=62 | 70..=72 => btn::CIRCLE,
            100..=102 => btn::CROSS,
            121 => btn::DOWN,
            123 => btn::UP,
            _ => 0,
        };
        if frame == 120 {
            on.ui_mut().set_focus(NodeId::NONE); off.ui_mut().set_focus(NodeId::NONE);
        }
        let previous_phase = on.model.phase();
        on.ui_mut().core_mut().reset_counters(); off.ui_mut().core_mut().reset_counters();
        on.frame(&Input::buttons(buttons)); off.frame(&Input::buttons(buttons));
        equivalent(&mut on, &mut off, frame + 1);
        let expected_count = match frame { 0..=39 => 0, 40..=49 => 1, 50..=59 => 2, 60..=69 => 3, 70..=99 => 4, _ => 0 };
        assert_eq!(on.model.count(), expected_count, "button down-edge semantics at frame {frame}");
        if counts.last() != Some(&on.model.count()) { counts.push(on.model.count()); }
        if frame == 120 { assert_eq!(on.ui().focused(), NodeId::NONE); }
        else { assert_eq!(on.ui().focused(), node(&on, "HeroAction")); }
        phases.insert(on.model.phase());
        let width = on.ui().core().resolved_style(node(&on, "Underline").0).unwrap().width;
        saw_intermediate_width |= width > 0.0 && width < 144.0;
        colors.insert(on.ui().core().resolved_style(node(&on, "HeroAction").0).unwrap().bg_color);
        // After the startup/interaction effects settle, a phase change must
        // rebuild only the Spinner tree and never reshape text outside it.
        if frame >= 150 && previous_phase != on.model.phase() {
            let a = on.ui().core().counters().layout;
            let b = off.ui().core().counters().layout;
            assert_eq!(a.structure_rebuilds, 1, "one region rebuild at frame {frame}");
            assert_eq!(b.structure_rebuilds, 1, "one general rebuild at frame {frame}");
            assert_eq!(a.shaping_calls, 0, "outside text reshaped at frame {frame}");
            assert!(b.shaping_calls > 0);
            assert!(a.taffy_nodes_created < b.taffy_nodes_created);
            isolated_changes += 1; on_nodes += a.taffy_nodes_created;
            off_nodes += b.taffy_nodes_created; off_shapes += b.shaping_calls;
        }
    }
    assert_eq!(phases, (0..8).collect());
    assert_eq!(counts, [0, 1, 2, 3, 4, 0]);
    assert!(saw_intermediate_width);
    assert_eq!(on.ui().core().resolved_style(node(&on, "Underline").0).unwrap().width, 144.0);
    assert!(colors.len() > 1, "active/focus transition must affect the presenter");
    assert!(isolated_changes >= 16);
    println!("checked 181 snapshots; phases=8; counts=0,1,2,3,4,0; isolated_changes={isolated_changes}; on_nodes={on_nodes}; off_nodes={off_nodes}; on_shapes=0; off_shapes={off_shapes}");
}
`);
  const command = ["cargo", "run", "--quiet", "--manifest-path", resolve(directory, "Cargo.toml")];
  const child = Bun.spawn(command, {
    env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/gba/native-test-target") },
    stdout: "pipe", stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(resolve(directory, "cargo.log"), output + errors);
  writeFileSync(resolve(directory, "receipt.json"), JSON.stringify({ command, status, output, acceptance: "181 paired snapshots: live tree, f32 layout bits, DrawList words, button/focus behavior; isolated phase changes do not reshape outside text", host: "native std, 240x160, 30 Hz, no resident fonts or images; not an ARM timing measurement" }, null, 2) + "\n");
  expect(status, output + errors).toBe(0);
  expect(output).toContain("checked 181 snapshots; phases=8; counts=0,1,2,3,4,0");
}, 120_000);
