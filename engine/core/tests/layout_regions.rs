//! Independent layout regions versus one shared solver. Each test applies the
//! same mutations to both trees and compares rects, draw words and hit tests.

mod common;

use common::{atlas, fixed, row, set, text};
use pocketjs_core::spec::prop::*;
use pocketjs_core::{spec, Ui};

/// outer (row) -> [a -> nested -> label "aaa", b -> "bbb"]; `a`, `b` and
/// optionally `nested` become regions. Fractional sizes exercise rounding.
struct Tree {
    ui: Ui,
    outer: i32,
    a: i32,
    b: i32,
    nested: i32,
    label: i32,
    ids: Vec<i32>,
}

fn tree(regions: bool, nested_region: bool) -> Tree {
    let mut ui = Ui::new();
    ui.set_viewport(250.0, 140.0);
    assert!(ui.load_font_atlas(&atlas(5, 255)));
    let outer = fixed(&mut ui, spec::ROOT_ID, 210.5, 100.25);
    row(&mut ui, outer);
    set(&mut ui, outer, &[(PADDING_L, 0.35), (PADDING_T, 0.25), (GAP, 3.25)]);
    let a = fixed(&mut ui, outer, 70.3, 65.4);
    set(&mut ui, a, &[(PADDING_L, 2.2), (PADDING_T, 1.4)]);
    let b = fixed(&mut ui, outer, 80.6, 65.4);
    let nested = fixed(&mut ui, a, 30.3, 30.5);
    ui.set_prop(nested, PADDING_L, 0.2);
    let label = text(&mut ui, nested, "aaa");
    let outside = text(&mut ui, b, "bbb");
    if regions {
        assert!(ui.set_layout_region(a, true));
        assert!(ui.set_layout_region(b, true));
        if nested_region {
            assert!(ui.set_layout_region(nested, true));
        }
    }
    let ids = vec![spec::ROOT_ID, outer, a, b, nested, label, outside];
    Tree { ui, outer, a, b, nested, label, ids }
}

/// Builds the plain and split trees and applies `edit` to both.
struct Pair {
    plain: Tree,
    split: Tree,
}

impl Pair {
    fn new(nested_region: bool) -> Self {
        let mut pair = Self { plain: tree(false, nested_region), split: tree(true, nested_region) };
        pair.check();
        pair
    }

    fn edit(&mut self, mut f: impl FnMut(&mut Tree)) {
        f(&mut self.plain);
        f(&mut self.split);
        self.check();
    }

    fn check(&mut self) {
        let words = self.plain.ui.draw().words.clone();
        assert_eq!(words, self.split.ui.draw().words, "draw words");
        for (&plain, &split) in self.plain.ids.iter().zip(&self.split.ids) {
            assert_eq!(self.plain.ui.layout_of(plain), self.split.ui.layout_of(split), "node {plain}");
        }
        for (x, y) in [(1.0, 1.0), (12.0, 12.0), (80.0, 20.0), (249.0, 139.0)] {
            assert_eq!(self.plain.ui.hit_test(x, y), self.split.ui.hit_test(x, y));
            assert_eq!(self.plain.ui.hit_test_bounds(x, y), self.split.ui.hit_test_bounds(x, y));
        }
    }
}

#[test]
fn fractional_offsets_round_region_edges_like_the_shared_solver() {
    for nested in [false, true] {
        let mut pair = Pair::new(nested);
        for offset in [-0.75, -0.5, -0.25, 0.0, 0.25, 0.49, 0.5, 0.75] {
            pair.edit(|t| {
                set(&mut t.ui, t.outer, &[(MARGIN_L, offset), (MARGIN_T, -offset)]);
                t.ui.set_prop(t.a, WIDTH, 70.3 + offset);
            });
        }
    }
}

#[test]
fn structure_changes_reshape_only_the_affected_region() {
    let mut pair = Pair::new(true);
    #[cfg(feature = "counters")]
    pair.split.ui.reset_counters();
    pair.edit(|t| {
        let added = text(&mut t.ui, t.nested, "aa");
        t.ids.push(added);
    });
    #[cfg(feature = "counters")]
    {
        let work = pair.split.ui.counters().layout;
        assert_eq!(work.structure_rebuilds, 1);
        assert_eq!(work.shaping_calls, 2, "both texts in `nested`; the outside text is untouched");
    }
    for run in ["", "aaaa", "b"] {
        pair.edit(|t| t.ui.set_text(t.label, run));
    }
    pair.edit(|t| {
        let added = t.ids.pop().unwrap();
        t.ui.destroy_node(added);
    });
}

#[test]
fn boundary_props_display_and_cross_region_moves_match() {
    let mut pair = Pair::new(true);
    pair.edit(|t| t.ui.set_prop(t.a, MARGIN_L, 6.5));
    for hide_outer in [false, true] {
        for display in [spec::Display::None, spec::Display::Flex] {
            pair.edit(|t| {
                let root = if hide_outer { t.outer } else { t.a };
                t.ui.set_prop(root, DISPLAY, display as u8 as f64);
            });
        }
    }
    pair.edit(|t| t.ui.insert_before(t.b, t.label, 0));
    pair.edit(|t| t.ui.insert_before(t.a, t.nested, 0));
    // A host write that breaks the region proof demotes the region.
    pair.edit(|t| t.ui.set_prop(t.a, SHRINK, 1.0));
    assert!(!pair.split.ui.is_layout_region(pair.split.a));
}

#[test]
fn disabled_regions_and_auxiliary_outputs_fall_back() {
    let mut pair = Pair::new(true);
    assert!(pair.split.ui.set_layout_region(pair.split.nested, false));
    pair.check();
    pair.edit(|t| {
        let auxiliary = t.ui.create_auxiliary_surface(120.0, 80.0);
        t.ui.insert_before(auxiliary, t.a, 0);
        assert!(!t.ui.set_layout_region(t.a, true), "auxiliary outputs have no regions");
    });
    let words = pair.plain.ui.draw_auxiliary().unwrap().words.clone();
    assert_eq!(words, pair.split.ui.draw_auxiliary().unwrap().words);
    pair.check();
}

#[test]
#[should_panic(expected = "layout region requires")]
fn default_shrink_is_not_a_region_proof() {
    let mut ui = Ui::new();
    let node = ui.create_node(spec::NodeType::View as u8);
    set(&mut ui, node, &[(WIDTH, 50.0), (HEIGHT, 50.0)]);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_layout_region(node, true);
}

#[test]
fn animation_viewport_font_reload_and_native_text_match() {
    let mut pair = Pair::new(true);
    let linear = spec::Easing::Linear as u8;
    let (plain, split) = (&mut pair.plain, &mut pair.split);
    for t in [plain, split] {
        t.ui.animate(t.a, WIDTH, 86.75, 90, linear, 0);
        t.ui.animate(t.nested, PADDING_L, 4.5, 90, linear, 0);
    }
    for _ in 0..8 {
        pair.edit(|t| {
            t.ui.tick();
        });
    }
    pair.edit(|t| t.ui.set_viewport(100.0, 90.0));
    pair.edit(|t| assert!(t.ui.load_font_atlas(&atlas(8, 255))));
    pair.edit(|t| t.ui.set_text_measure(Some(Box::new(|text, _, _, _| (text.len() as f32 * 7.25, 10.5)))));
    assert!(!pair.split.ui.is_layout_region(pair.split.a), "native text disables regions");
}
