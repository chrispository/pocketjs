use pocketjs_core::{spec, tree::LayoutRect, RegionLayoutGuard, Ui};

fn fixture(origin: f64) -> (Ui, Vec<i32>) {
    let mut ui = Ui::new();
    ui.set_draw_cache_budget(0);
    let root = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(root, spec::prop::WIDTH, 70.3);
    ui.set_prop(root, spec::prop::HEIGHT, 50.6);
    ui.set_prop(root, spec::prop::SHRINK, 0.0);
    ui.set_prop(root, spec::prop::PADDING_L, 2.3);
    ui.set_prop(root, spec::prop::PADDING_T, 1.3);
    ui.set_prop(root, spec::prop::MARGIN_L, origin);
    ui.set_prop(root, spec::prop::BG_COLOR, 0xffaa_7755u32 as f64);
    ui.insert_before(spec::ROOT_ID, root, 0);
    let child = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(child, spec::prop::WIDTH, 20.5);
    ui.set_prop(child, spec::prop::HEIGHT, 15.5);
    ui.set_prop(child, spec::prop::SHRINK, 0.0);
    ui.set_prop(child, spec::prop::BG_COLOR, 0xff55_7799u32 as f64);
    ui.insert_before(root, child, 0);
    let grandchild = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(grandchild, spec::prop::WIDTH, 3.3);
    ui.set_prop(grandchild, spec::prop::HEIGHT, 4.4);
    ui.set_prop(grandchild, spec::prop::BG_COLOR, 0xffff_eeeeu32 as f64);
    ui.insert_before(child, grandchild, 0);
    assert!(ui.set_layout_region(root, true));
    (ui, vec![root, child, grandchild])
}
fn baked() -> (RegionLayoutGuard, Vec<(i32, LayoutRect)>) {
    let (mut source, nodes) = fixture(0.0);
    source.draw();
    (
        source.layout_region_guard(nodes[0]).unwrap(),
        nodes
            .iter()
            .map(|&id| {
                let (x, y, w, h) = source.layout_of(id).unwrap();
                (id, LayoutRect { x, y, w, h })
            })
            .collect(),
    )
}
fn compare(a: &mut Ui, b: &mut Ui, nodes: &[i32]) {
    assert_eq!(a.draw().words, b.draw().words);
    for &id in nodes {
        assert_eq!(a.layout_of(id), b.layout_of(id));
    }
}

#[test]
fn baked_first_layout_skips_the_region_solver_then_mutations_solve_live() {
    let (guard, rects) = baked();
    let (mut live, nodes) = fixture(0.0);
    let (mut compiled, _) = fixture(0.0);
    assert!(compiled.set_region_layout(nodes[0], guard, &rects));
    assert!(!compiled.set_region_layout(nodes[0], guard, &rects));
    compare(&mut live, &mut compiled, &nodes);
    #[cfg(feature = "counters")]
    {
        assert_eq!(live.counters().layout.structure_rebuilds, 2);
        assert_eq!(compiled.counters().layout.structure_rebuilds, 1);
        assert!(
            compiled.counters().layout.taffy_nodes_created
                < live.counters().layout.taffy_nodes_created
        );
    }
    assert!(!compiled.set_region_layout(nodes[0], guard, &rects));
    for ui in [&mut live, &mut compiled] {
        ui.set_prop(nodes[1], spec::prop::WIDTH, 25.25);
    }
    compare(&mut live, &mut compiled, &nodes);
    for ui in [&mut live, &mut compiled] {
        ui.set_prop(nodes[0], spec::prop::MARGIN_L, 0.5);
    }
    compare(&mut live, &mut compiled, &nodes);
}

#[test]
fn wrong_parent_origin_or_size_falls_back_without_installing_rects() {
    for (origin, width) in [(0.5, 70.3), (1.0, 70.3), (0.0, 80.5)] {
        let (guard, mut rects) = baked();
        rects[1].1.x = 999.0; // A failed guard must never publish this table.
        let (mut live, nodes) = fixture(origin);
        let (mut compiled, _) = fixture(origin);
        for ui in [&mut live, &mut compiled] {
            ui.set_prop(nodes[0], spec::prop::WIDTH, width);
        }
        assert!(compiled.set_region_layout(nodes[0], guard, &rects));
        compare(&mut live, &mut compiled, &nodes);
        #[cfg(feature = "counters")]
        assert_eq!(compiled.counters().layout.structure_rebuilds, 2);
    }
}

#[test]
fn tables_require_complete_live_nodes_integer_guard_and_no_nested_region() {
    let (guard, rects) = baked();
    let (mut ui, nodes) = fixture(0.0);
    assert!(!ui.set_region_layout(nodes[0], guard, &rects[..2]));
    let mut invalid = rects.clone();
    invalid[1].0 = invalid[0].0;
    assert!(!ui.set_region_layout(nodes[0], guard, &invalid));
    invalid = rects.clone();
    invalid[1].0 = i32::MAX;
    assert!(!ui.set_region_layout(nodes[0], guard, &invalid));
    invalid = rects.clone();
    invalid[1].1.w = f32::NAN;
    assert!(!ui.set_region_layout(nodes[0], guard, &invalid));
    assert!(!ui.set_region_layout(
        nodes[0],
        RegionLayoutGuard {
            unrounded_origin: (0.25, 0.0),
            ..guard
        },
        &rects
    ));
    assert!(ui.set_layout_region(nodes[1], true));
    assert!(!ui.set_region_layout(nodes[0], guard, &rects));
}

#[test]
fn local_changes_before_first_solve_discard_pending_bake() {
    let (guard, mut rects) = baked();
    rects[1].1.x = 999.0;
    let (mut live, nodes) = fixture(0.0);
    let (mut compiled, _) = fixture(0.0);
    assert!(compiled.set_region_layout(nodes[0], guard, &rects));
    for ui in [&mut live, &mut compiled] {
        ui.set_prop(nodes[1], spec::prop::HEIGHT, 22.25);
    }
    compare(&mut live, &mut compiled, &nodes);
    #[cfg(feature = "counters")]
    assert_eq!(compiled.counters().layout.structure_rebuilds, 2);
}
