//! Generic retained layout versus a fresh Taffy tree. No fixture registers
//! specialization regions, disables flex shrink, or substitutes Show lifetimes.
#![cfg(feature = "counters")]

use pocketjs_core::{raster, spec, Ui};

fn atlas(advance: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    for (cp, gid) in [(b'a', 0u16), (b'b', 1)] {
        bytes.extend_from_slice(&(cp as u32).to_le_bytes());
        bytes.extend_from_slice(&gid.to_le_bytes());
        bytes.extend_from_slice(&[advance, 0]);
    }
    bytes.extend_from_slice(&[255; 80]);
    bytes
}

fn view(ui: &mut Ui, parent: i32, width: Option<f64>, height: Option<f64>) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    if let Some(width) = width {
        ui.set_prop(id, spec::prop::WIDTH, width);
    }
    if let Some(height) = height {
        ui.set_prop(id, spec::prop::HEIGHT, height);
    }
    ui.set_prop(id, spec::prop::FLEX_DIR, spec::FlexDir::Col as u8 as f64);
    ui.set_prop(id, spec::prop::BG_COLOR, 0xff22_3344u32 as f64);
    ui.insert_before(parent, id, 0);
    id
}

fn text(ui: &mut Ui, parent: i32, run: &str) -> i32 {
    let id = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(id, run);
    ui.insert_before(parent, id, 0);
    id
}

#[derive(Debug, PartialEq)]
struct NodeSnapshot {
    path: Vec<usize>,
    id: i32,
    kind: u8,
    text: String,
    children: Vec<i32>,
    rect_bits: [u32; 4],
}

fn snapshot(ui: &Ui, root: i32) -> Vec<NodeSnapshot> {
    fn walk(ui: &Ui, id: i32, path: &mut Vec<usize>, nodes: &mut Vec<NodeSnapshot>) {
        let rect = ui.layout_of(id).unwrap();
        nodes.push(NodeSnapshot {
            path: path.clone(),
            id,
            kind: ui.node_type(id).unwrap(),
            text: ui.node_text(id).unwrap().to_owned(),
            children: ui.node_children(id).to_vec(),
            rect_bits: [
                rect.0.to_bits(),
                rect.1.to_bits(),
                rect.2.to_bits(),
                rect.3.to_bits(),
            ],
        });
        for (index, child) in ui.node_children(id).iter().enumerate() {
            path.push(index);
            walk(ui, *child, path, nodes);
            path.pop();
        }
    }
    let mut nodes = Vec::new();
    walk(ui, root, &mut Vec::new(), &mut nodes);
    nodes
}

struct Pair {
    incremental: Ui,
    rebuilt: Ui,
}

impl Pair {
    fn new() -> Self {
        let make = || {
            let mut ui = Ui::new();
            ui.set_viewport(160.0, 120.0);
            assert!(ui.load_font_atlas(&atlas(5)));
            ui
        };
        Self {
            incremental: make(),
            rebuilt: make(),
        }
    }

    fn edit<T: PartialEq + core::fmt::Debug>(&mut self, mut f: impl FnMut(&mut Ui) -> T) -> T {
        let result = f(&mut self.incremental);
        assert_eq!(
            result,
            f(&mut self.rebuilt),
            "identical mutations allocate identical node IDs"
        );
        result
    }

    fn check(&mut self, step: &str) {
        // This drops the reference solver, not the retained UI nodes or fonts.
        // Both sides still execute the same public draw and hit-test calls.
        self.rebuilt.force_layout_rebuild_for_validation();
        let actual = self.incremental.draw().words.clone();
        let expected = self.rebuilt.draw().words.clone();
        assert_eq!(
            snapshot(&self.incremental, spec::ROOT_ID),
            snapshot(&self.rebuilt, spec::ROOT_ID),
            "{step}: live tree and f32 layout bits"
        );
        assert_eq!(actual, expected, "{step}: primary DrawList");
        let (width, height) = self.incremental.viewport();
        let mut actual_pixels = vec![0; width as usize * height as usize * 4];
        let mut expected_pixels = actual_pixels.clone();
        raster::render(&self.incremental, &actual, &mut actual_pixels);
        raster::render(&self.rebuilt, &expected, &mut expected_pixels);
        assert_eq!(actual_pixels, expected_pixels, "{step}: primary pixels");
        for (x, y) in [
            (0.0, 0.0),
            (7.0, 7.0),
            (41.0, 17.0),
            (79.0, 47.0),
            (159.0, 119.0),
        ] {
            assert_eq!(
                self.incremental.hit_test(x, y),
                self.rebuilt.hit_test(x, y),
                "{step}: hit test"
            );
            assert_eq!(
                self.incremental.hit_test_bounds(x, y),
                self.rebuilt.hit_test_bounds(x, y),
                "{step}: bounds hit test"
            );
        }
        assert_eq!(
            self.incremental.focused(),
            self.rebuilt.focused(),
            "{step}: focus"
        );
        let auxiliary = self.incremental.auxiliary_surface_root();
        if auxiliary != 0 {
            let actual = self.incremental.draw_auxiliary().unwrap().words.clone();
            let expected = self.rebuilt.draw_auxiliary().unwrap().words.clone();
            assert_eq!(
                snapshot(&self.incremental, auxiliary),
                snapshot(&self.rebuilt, auxiliary),
                "{step}: auxiliary layout"
            );
            assert_eq!(actual, expected, "{step}: auxiliary DrawList");
            assert_eq!(
                self.incremental.hit_test_bounds_auxiliary(7.0, 7.0),
                self.rebuilt.hit_test_bounds_auxiliary(7.0, 7.0),
                "{step}: auxiliary hit test"
            );
        }
    }
}

#[test]
fn show_like_image_replacement_retains_unrelated_text_and_solver_nodes() {
    let mut pair = Pair::new();
    let (container, label, mut image) = pair.edit(|ui| {
        let outer = view(ui, spec::ROOT_ID, Some(120.0), None);
        ui.set_prop(outer, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
        let label = text(ui, outer, "ababab");
        let container = view(ui, outer, Some(32.0), Some(32.0));
        let image = ui.create_node(spec::NodeType::Image as u8);
        ui.set_prop(image, spec::prop::WIDTH, 32.0);
        ui.set_prop(image, spec::prop::HEIGHT, 32.0);
        ui.insert_before(container, image, 0);
        (container, label, image)
    });
    pair.check("initial");
    let label_rect = pair.incremental.layout_of(label);
    let live_nodes = pair.incremental.counters().layout.taffy_nodes;
    for phase in 0..8 {
        pair.incremental.reset_counters();
        pair.rebuilt.reset_counters();
        image = pair.edit(|ui| {
            ui.destroy_node(image); // A real unmount and fresh generation, as in Show.
            let id = ui.create_node(spec::NodeType::Image as u8);
            ui.set_prop(id, spec::prop::WIDTH, 32.0);
            ui.set_prop(id, spec::prop::HEIGHT, 32.0);
            ui.set_prop(id, spec::prop::BG_COLOR, (0xff00_0010u32 + phase) as f64);
            ui.insert_before(container, id, 0);
            id
        });
        pair.check(&format!("phase {phase}"));
        let work = pair.incremental.counters().layout;
        assert_eq!(
            work.structure_rebuilds, 0,
            "ordinary topology mutation must retain Taffy"
        );
        assert_eq!(
            work.taffy_nodes_created, 1,
            "only the new image needs a solver node"
        );
        assert_eq!(
            work.shaping_calls, 0,
            "sibling text measurement remains reusable"
        );
        assert_eq!(
            work.taffy_nodes, live_nodes,
            "destroyed generations must leave no solver nodes"
        );
        assert_eq!(work.structure_syncs, 1);
        assert_eq!(work.layout_passes, 1);
        assert!(
            work.measure_callbacks < pair.rebuilt.counters().layout.measure_callbacks,
            "unchanged sibling Taffy measurement cache must survive the swap"
        );
        assert_eq!(pair.incremental.layout_of(label), label_rect);
    }
}

#[test]
fn auto_parents_and_default_flex_shrink_propagate_new_constraints() {
    let mut pair = Pair::new();
    let (row, left, right, label) = pair.edit(|ui| {
        let row = view(ui, spec::ROOT_ID, Some(100.0), None);
        ui.set_prop(row, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
        let left = view(ui, row, Some(80.0), None);
        let right = view(ui, row, Some(80.0), None);
        let label = text(ui, left, "ab");
        text(ui, right, "ba");
        (row, left, right, label)
    });
    pair.check("two shrinking columns");
    assert_eq!(pair.incremental.layout_of(left).unwrap().2, 50.0);
    assert_eq!(pair.incremental.layout_of(right).unwrap().2, 50.0);
    let inserted = pair.edit(|ui| view(ui, row, Some(80.0), Some(17.0)));
    pair.check("third sibling reduces widths and grows auto height");
    assert!(pair.incremental.layout_of(left).unwrap().2 < 50.0);
    assert_eq!(pair.incremental.layout_of(row).unwrap().3, 17.0);
    pair.edit(|ui| {
        ui.set_text(label, "abababababab");
        ui.set_prop(right, spec::prop::MIN_W, 27.25);
        ui.set_prop(row, spec::prop::WIDTH, 99.5);
        ui.set_prop(row, spec::prop::PADDING_L, 0.25);
    });
    pair.check("intrinsic minimum and fractional parent constraints");
    pair.edit(|ui| ui.destroy_node(inserted));
    pair.check("auto height shrinks after deletion");
    for width in [80.0, 160.0, 121.0] {
        pair.edit(|ui| {
            ui.set_prop(row, spec::prop::WIDTH, -1.0); // 100% of the viewport.
            ui.set_viewport(width, 120.0);
        });
        pair.check("viewport constraints recompute retained descendants");
    }
}

#[test]
fn empty_text_and_inline_subtree_changes_match_fresh_collection() {
    let mut pair = Pair::new();
    let (first, second, inline) = pair.edit(|ui| {
        let row = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(row, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
        let first = text(ui, row, "a");
        let inline = text(ui, first, "b");
        let second = text(ui, row, "");
        (first, second, inline)
    });
    pair.check("inline run and excluded empty sibling");
    assert_eq!(pair.incremental.layout_of(first).unwrap().2, 10.0);
    for run in ["", "abba", "a"] {
        pair.edit(|ui| ui.set_text(inline, run));
        pair.check("inline content changes parent measurement");
    }
    pair.edit(|ui| ui.insert_before(second, inline, 0));
    pair.check("inline moves into previously empty text root");
    pair.edit(|ui| ui.set_text(first, ""));
    pair.check("top-level text leaves layout");
    assert_eq!(pair.incremental.layout_of(first).unwrap().2, 0.0);
    let nested = pair.edit(|ui| text(ui, inline, "bab"));
    pair.check("nested inline insertion");
    pair.edit(|ui| ui.destroy_node(nested));
    pair.check("nested inline deletion");
    pair.edit(|ui| ui.remove_child(second, inline));
    pair.check("last inline removed from text root");
    pair.edit(|ui| {
        ui.set_text(inline, "abab");
        ui.insert_before(first, inline, 0);
    });
    pair.check("detached inline edited and reattached");
}

#[test]
fn reparenting_detached_edits_order_and_generation_reuse_match() {
    let mut pair = Pair::new();
    let (left, right, moving, label, anchor) = pair.edit(|ui| {
        let left = view(ui, spec::ROOT_ID, Some(70.0), None);
        let right = view(ui, spec::ROOT_ID, Some(95.0), None);
        let moving = view(ui, left, None, None);
        let label = text(ui, moving, "ab");
        let anchor = view(ui, right, Some(20.0), Some(11.0));
        (left, right, moving, label, anchor)
    });
    pair.check("initial parents");
    pair.edit(|ui| ui.insert_before(right, moving, anchor));
    pair.check("move existing subtree before sibling");
    pair.edit(|ui| ui.insert_before(right, moving, 0));
    pair.check("reorder within same parent");
    pair.edit(|ui| ui.remove_child(right, moving));
    pair.check("detached subtree is absent from solver");
    pair.edit(|ui| {
        ui.set_text(label, "abababab");
        ui.set_prop(moving, spec::prop::PADDING_T, 3.5);
        ui.insert_before(left, moving, 0);
        ui.set_focus(label);
    });
    pair.check("reattach with changed inherited constraints");
    pair.edit(|ui| ui.destroy_node(moving));
    pair.check("focused subtree destroyed");
    assert_eq!(pair.incremental.focused(), 0);
    let replacement = pair.edit(|ui| text(ui, right, "b"));
    assert!(!pair.incremental.node_exists(moving));
    assert!(!pair.incremental.node_exists(label));
    assert_ne!(replacement, moving);
    assert_ne!(replacement, label);
    assert!(
        [moving, label].iter().any(
            |old| (*old as u32 & spec::ID_SLOT_MASK) == replacement as u32 & spec::ID_SLOT_MASK
        ),
        "the test must reuse a freed arena slot"
    );
    pair.edit(|ui| {
        ui.set_text(label, "stale generation");
        ui.insert_before(left, moving, 0);
    });
    pair.check("reused slot ignores old generation operations");
}

#[test]
fn auxiliary_moves_resizes_and_font_replacement_invalidate_both_solvers() {
    let mut pair = Pair::new();
    let (main, auxiliary, side, label, side_label) = pair.edit(|ui| {
        let main = view(ui, spec::ROOT_ID, None, None);
        let auxiliary = ui.create_auxiliary_surface(71.0, 43.0);
        let side = view(ui, auxiliary, None, None);
        for parent in [main, side] {
            ui.set_prop(
                parent,
                spec::prop::FLEX_DIR,
                spec::FlexDir::Row as u8 as f64,
            );
        }
        let label = text(ui, main, "ababa");
        let side_label = text(ui, side, "bb");
        (main, auxiliary, side, label, side_label)
    });
    pair.check("two output roots");
    for destination in [side, main, side, main] {
        pair.edit(|ui| ui.insert_before(destination, label, 0));
        pair.check("text moves between solver owners");
    }
    pair.edit(|ui| {
        ui.set_viewport(123.0, 97.0);
        assert_eq!(ui.create_auxiliary_surface(53.0, 39.0), auxiliary);
    });
    pair.check("independent viewport resize");
    pair.edit(|ui| assert!(ui.load_font_atlas(&atlas(7))));
    pair.check("font replacement refreshes retained measurements");
    assert_eq!(pair.incremental.layout_of(label).unwrap().2, 35.0);
    assert_eq!(pair.incremental.layout_of(side_label).unwrap().2, 14.0);
    pair.edit(|ui| {
        let font = atlas(3);
        let mut handles = [123];
        ui.load_assets(
            &[pocketjs_core::assets::AssetInput {
                kind: pocketjs_core::assets::AssetKind::Font,
                bytes: &font,
            }],
            &mut handles,
        )
        .unwrap();
        assert_eq!(handles, [-1]);
    });
    pair.check("atomic asset replacement invalidates both output measurements");
    assert_eq!(pair.incremental.layout_of(label).unwrap().2, 15.0);
    assert_eq!(pair.incremental.layout_of(side_label).unwrap().2, 6.0);
    pair.edit(|ui| {
        ui.set_prop(side, spec::prop::DISPLAY, spec::Display::None as u8 as f64);
        text(ui, side, "abab");
    });
    pair.check("hidden auxiliary subtree gains text");
    pair.edit(|ui| ui.set_prop(side, spec::prop::DISPLAY, spec::Display::Flex as u8 as f64));
    pair.check("auxiliary subtree becomes visible");
}

fn measure(char_width: f32) -> pocketjs_core::text::MeasureFn {
    Box::new(move |text, _, _, line_height| {
        let height = if line_height.is_nan() {
            12.0
        } else {
            line_height
        };
        (text.chars().count() as f32 * char_width, height)
    })
}

#[test]
fn native_provider_replacement_and_transformed_reparenting_refresh_context() {
    let mut pair = Pair::new();
    let (plain, transformed, label) = pair.edit(|ui| {
        ui.set_text_measure(Some(measure(7.0)));
        let plain = view(ui, spec::ROOT_ID, None, None);
        let transformed = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(transformed, spec::prop::SCALE, 0.75);
        let label = text(ui, plain, "ab");
        (plain, transformed, label)
    });
    pair.check("native provider");
    assert_eq!(pair.incremental.layout_of(label).unwrap().3, 12.0);
    pair.edit(|ui| ui.insert_before(transformed, label, 0));
    pair.check("moving beneath transform switches to atlas metrics");
    assert_eq!(pair.incremental.layout_of(label).unwrap().3, 9.0);
    pair.edit(|ui| ui.insert_before(plain, label, 0));
    pair.check("moving back restores native provider");
    for angle in [25.0, 0.0, -15.0, 0.0] {
        pair.edit(|ui| ui.set_prop(plain, spec::prop::ROTATE, angle));
        pair.check("existing ancestor transform changes provider eligibility");
        assert_eq!(
            pair.incremental.layout_of(label).unwrap().3,
            if angle == 0.0 { 12.0 } else { 9.0 }
        );
    }
    pair.edit(|ui| ui.set_text_measure(Some(measure(11.0))));
    pair.check("replaced native provider");
    pair.edit(|ui| ui.set_text_measure(None));
    pair.check("native provider removed");
    assert_eq!(pair.incremental.layout_of(label).unwrap().3, 9.0);
}

fn paint_styles() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::style_table::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::style_table::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&[0; 4]); // no animations; reserved
    for base in [0xff00_00ffu32, 0xffff_0000] {
        bytes.push(
            spec::style_table::VARIANT_BASE
                | spec::style_table::VARIANT_FOCUS
                | spec::style_table::VARIANT_ACTIVE,
        );
        for color in [base, 0xff00_ff00, 0xffff_ffff] {
            bytes.push(1);
            bytes.extend_from_slice(&[spec::prop::BG_COLOR, 0]);
            bytes.extend_from_slice(&color.to_le_bytes());
        }
    }
    bytes
}

#[test]
fn paint_only_focus_active_and_stylesheet_swap_do_not_remeasure_text() {
    let mut pair = Pair::new();
    let label = pair.edit(|ui| {
        assert!(ui.load_styles(&paint_styles()));
        let label = text(ui, spec::ROOT_ID, "ababa");
        ui.set_style(label, 0);
        label
    });
    pair.check("base style");
    let original = snapshot(&pair.incremental, spec::ROOT_ID);
    for step in 0..6 {
        pair.incremental.reset_counters();
        pair.edit(|ui| match step {
            0 => ui.set_focus(label),
            1 => ui.set_active(label, true),
            2 => ui.set_active(label, false),
            3 => ui.set_focus(0),
            4 => ui.set_style(label, 1),
            _ => ui.set_prop(label, spec::prop::TEXT_COLOR, 0xff11_2233u32 as f64),
        });
        pair.check("paint-only resolved style change");
        assert_eq!(snapshot(&pair.incremental, spec::ROOT_ID), original);
        let work = pair.incremental.counters().layout;
        assert_eq!(work.structure_rebuilds, 0);
        assert_eq!(
            work.style_updates, 0,
            "same effective layout style needs no Taffy update"
        );
        assert_eq!(
            work.shaping_calls, 0,
            "paint-only state must preserve text measurement"
        );
        assert_eq!(work.taffy_nodes_created, 0);
        assert_eq!(
            work.layout_passes, 0,
            "paint-only changes need no solver pass"
        );
    }
}

#[test]
fn retained_measurements_preserve_missing_glyph_diagnostics_on_topology_changes() {
    let mut pair = Pair::new();
    let container = pair.edit(|ui| {
        text(ui, spec::ROOT_ID, "a?a"); // '?' is absent from the atlas.
        view(ui, spec::ROOT_ID, Some(32.0), Some(32.0))
    });
    pair.check("missing glyph initial frame");
    assert!(pair.incremental.glyph_misses() > 0);
    assert_eq!(pair.incremental.glyph_misses(), pair.rebuilt.glyph_misses());
    for _ in 0..4 {
        let child = pair.edit(|ui| view(ui, container, Some(10.0), Some(10.0)));
        pair.check("unrelated topology insertion with missing glyph");
        assert_eq!(pair.incremental.glyph_misses(), pair.rebuilt.glyph_misses());
        pair.edit(|ui| ui.destroy_node(child));
        pair.check("unrelated topology deletion with missing glyph");
        assert_eq!(pair.incremental.glyph_misses(), pair.rebuilt.glyph_misses());
    }
}

#[test]
fn detached_text_refreshes_font_and_provider_environment_before_reattachment() {
    let mut pair = Pair::new();
    let (parent, label) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(
            parent,
            spec::prop::FLEX_DIR,
            spec::FlexDir::Row as u8 as f64,
        );
        let label = text(ui, parent, "ab");
        (parent, label)
    });
    pair.check("detached environment initial");
    assert_eq!(pair.incremental.layout_of(label).unwrap().2, 10.0);
    for phase in 0..3 {
        pair.edit(|ui| ui.remove_child(parent, label));
        pair.check("text dormant during environment replacement");
        pair.edit(|ui| match phase {
            0 => assert!(ui.load_font_atlas(&atlas(7))),
            1 => ui.set_text_measure(Some(measure(11.0))),
            _ => ui.set_text_measure(Some(measure(13.0))),
        });
        pair.check("replacement committed while text is detached");
        pair.edit(|ui| ui.insert_before(parent, label, 0));
        pair.check("reattachment refreshes old context");
        assert_eq!(
            pair.incremental.layout_of(label).unwrap().2,
            [14.0, 22.0, 26.0][phase]
        );
    }
}

#[test]
fn reversing_ancestor_relationship_before_one_flush_cannot_leave_a_solver_cycle() {
    let mut pair = Pair::new();
    let (mut parent, mut child) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, None, None);
        let child = view(ui, parent, None, None);
        text(ui, child, "abab");
        (parent, child)
    });
    pair.check("ancestor rotation initial");
    for _ in 0..8 {
        pair.edit(|ui| {
            ui.insert_before(spec::ROOT_ID, child, 0);
            ui.insert_before(child, parent, 0);
        });
        pair.check("former parent moves below its former child in one flush");
        core::mem::swap(&mut parent, &mut child);
    }
}

#[test]
fn deterministic_mixed_mutation_trace_matches_full_rebuild_each_frame() {
    let mut pair = Pair::new();
    let (parents, mut leaves) = pair.edit(|ui| {
        ui.set_text_measure(Some(measure(7.0)));
        let row = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(row, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
        let left = view(ui, row, Some(75.5), None);
        let right = view(ui, row, Some(90.25), None);
        let first_run = text(ui, left, "a");
        let second_run = text(ui, right, "b");
        let parents = [left, right, first_run, second_run];
        let leaves = (0..6)
            .map(|index| text(ui, parents[index % 4], "ab"))
            .collect::<Vec<_>>();
        (parents, leaves)
    });
    pair.check("mixed trace initial state");
    let mut seed = 0x6a09_e667u32;
    for step in 0..96 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let pick = (seed >> 16) as usize;
        let index = pick % leaves.len();
        let leaf = leaves[index];
        let destination = parents[(pick / 7) % parents.len()];
        match step % 12 {
            0 => pair.edit(|ui| ui.set_text(leaf, ["", "a", "abababab", "ab\nba"][pick % 4])),
            1 => pair.edit(|ui| ui.insert_before(destination, leaf, 0)),
            2 => pair.edit(|ui| {
                let parent = ui.node_parent(leaf);
                if parent != 0 {
                    ui.remove_child(parent, leaf);
                }
            }),
            3 => {
                leaves[index] = pair.edit(|ui| {
                    ui.destroy_node(leaf);
                    let new_leaf = text(ui, destination, "baba");
                    ui.set_text(leaf, "ignored stale generation");
                    new_leaf
                });
            }
            4 => pair.edit(|ui| {
                ui.set_prop(
                    parents[pick % 2],
                    spec::prop::WIDTH,
                    42.25 + (pick % 45) as f64,
                )
            }),
            5 => pair.edit(|ui| {
                ui.set_prop(
                    parents[pick % 2],
                    spec::prop::DISPLAY,
                    (if (step / 12) % 2 == 0 {
                        spec::Display::None
                    } else {
                        spec::Display::Flex
                    }) as u8 as f64,
                )
            }),
            6 => pair.edit(|ui| {
                ui.set_prop(
                    parents[pick % 2],
                    spec::prop::ROTATE,
                    if (step / 12) % 2 == 0 { 17.0 } else { 0.0 },
                )
            }),
            7 => pair.edit(|ui| ui.set_viewport(100.0 + (pick % 61) as f32, 120.0)),
            8 => pair.edit(|ui| ui.set_prop(leaf, spec::prop::TRACKING, (pick % 3) as f64)),
            9 => pair.edit(|ui| assert!(ui.load_font_atlas(&atlas(4 + (pick % 4) as u8)))),
            10 => pair.edit(|ui| {
                let anchor = ui
                    .node_children(destination)
                    .iter()
                    .copied()
                    .find(|id| *id != leaf)
                    .unwrap_or(0);
                ui.insert_before(destination, leaf, anchor);
            }),
            _ => pair.edit(|ui| {
                ui.set_text_measure(if (step / 12) % 2 == 0 {
                    None
                } else {
                    Some(measure(6.0 + (pick % 4) as f32))
                })
            }),
        }
        pair.check(&format!("mixed mutation step {step}, seed {seed:08x}"));
    }
}
