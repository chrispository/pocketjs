//! Baked region layouts. A precomputed rect table replaces the first region
//! solve only while its guard (unrounded origin and root size) holds.

mod common;

use common::{fixed, set, view};
use pocketjs_core::spec::prop::*;
use pocketjs_core::{spec, tree::LayoutRect, RegionLayoutGuard, Ui};

type Rects = Vec<(i32, LayoutRect)>;

/// A region root with a child and a grandchild at fractional sizes.
fn scene(margin: f64) -> (Ui, Vec<i32>) {
    let mut ui = Ui::new();
    ui.set_draw_cache_budget(0);
    let root = fixed(&mut ui, spec::ROOT_ID, 70.3, 50.6);
    set(&mut ui, root, &[(PADDING_L, 2.3), (PADDING_T, 1.3), (MARGIN_L, margin)]);
    let child = fixed(&mut ui, root, 20.5, 15.5);
    let grandchild = view(&mut ui, child, Some(3.3), Some(4.4));
    assert!(ui.set_layout_region(root, true));
    (ui, vec![root, child, grandchild])
}

/// The guard and rects a live solve of `scene(0.0)` produces.
fn bake() -> (RegionLayoutGuard, Rects) {
    let (mut ui, ids) = scene(0.0);
    ui.draw();
    let rect = |id: i32| {
        let (x, y, w, h) = ui.layout_of(id).unwrap();
        (id, LayoutRect { x, y, w, h })
    };
    (ui.layout_region_guard(ids[0]).unwrap(), ids.iter().map(|&id| rect(id)).collect())
}

fn assert_same(live: &mut Ui, baked: &mut Ui, ids: &[i32]) {
    assert_eq!(live.draw().words, baked.draw().words);
    for &id in ids {
        assert_eq!(live.layout_of(id), baked.layout_of(id));
    }
}

#[cfg(feature = "counters")]
fn rebuilds(ui: &Ui) -> u64 {
    ui.counters().layout.structure_rebuilds
}

#[test]
fn baked_rects_replace_the_first_region_solve_then_edits_solve_live() {
    let (guard, rects) = bake();
    let (mut live, ids) = scene(0.0);
    let (mut baked, _) = scene(0.0);
    assert!(baked.set_region_layout(ids[0], guard, &rects));
    assert!(!baked.set_region_layout(ids[0], guard, &rects), "a pending bake cannot be replaced");
    assert_same(&mut live, &mut baked, &ids);
    #[cfg(feature = "counters")]
    {
        assert_eq!((rebuilds(&live), rebuilds(&baked)), (2, 1), "the baked region skipped its solver build");
        let created = |ui: &Ui| ui.counters().layout.taffy_nodes_created;
        assert!(created(&baked) < created(&live));
    }
    assert!(!baked.set_region_layout(ids[0], guard, &rects), "a solved region takes no bake");
    for (id, prop, value) in [(ids[1], WIDTH, 25.25), (ids[0], MARGIN_L, 0.5)] {
        live.set_prop(id, prop, value);
        baked.set_prop(id, prop, value);
        assert_same(&mut live, &mut baked, &ids);
    }
}

#[test]
fn guard_mismatch_falls_back_to_a_live_solve() {
    for (margin, width) in [(0.5, 70.3), (1.0, 70.3), (0.0, 80.5)] {
        let (guard, mut rects) = bake();
        rects[1].1.x = 999.0; // visible if a failed guard still installs the table
        let (mut live, ids) = scene(margin);
        let (mut baked, _) = scene(margin);
        live.set_prop(ids[0], WIDTH, width);
        baked.set_prop(ids[0], WIDTH, width);
        assert!(baked.set_region_layout(ids[0], guard, &rects));
        assert_same(&mut live, &mut baked, &ids);
        #[cfg(feature = "counters")]
        assert_eq!(rebuilds(&baked), 2);
    }
}

#[test]
fn incomplete_or_invalid_tables_are_rejected() {
    let (guard, rects) = bake();
    let (mut ui, ids) = scene(0.0);
    let with = |edit: fn(&mut Rects)| {
        let mut rects = rects.clone();
        edit(&mut rects);
        rects
    };
    assert!(!ui.set_region_layout(ids[0], guard, &rects[..2]), "missing node");
    assert!(!ui.set_region_layout(ids[0], guard, &with(|r| r[1].0 = r[0].0)), "duplicate node");
    assert!(!ui.set_region_layout(ids[0], guard, &with(|r| r[1].0 = i32::MAX)), "unknown node");
    assert!(!ui.set_region_layout(ids[0], guard, &with(|r| r[1].1.w = f32::NAN)), "non-finite rect");
    let fractional = RegionLayoutGuard { unrounded_origin: (0.25, 0.0), ..guard };
    assert!(!ui.set_region_layout(ids[0], fractional, &rects), "non-integer origin");
    assert!(ui.set_layout_region(ids[1], true));
    assert!(!ui.set_region_layout(ids[0], guard, &rects), "nested region");
}

#[test]
fn edits_before_the_first_solve_discard_a_pending_bake() {
    let (guard, mut rects) = bake();
    rects[1].1.x = 999.0;
    let (mut live, ids) = scene(0.0);
    let (mut baked, _) = scene(0.0);
    assert!(baked.set_region_layout(ids[0], guard, &rects));
    live.set_prop(ids[1], HEIGHT, 22.25);
    baked.set_prop(ids[1], HEIGHT, 22.25);
    assert_same(&mut live, &mut baked, &ids);
    #[cfg(feature = "counters")]
    assert_eq!(rebuilds(&baked), 2);
}
