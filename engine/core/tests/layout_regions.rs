use pocketjs_core::{spec, Ui};

fn atlas() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    for (cp, gid) in [(b'a', 0u16), (b'b', 1)] {
        bytes.extend_from_slice(&(cp as u32).to_le_bytes());
        bytes.extend_from_slice(&gid.to_le_bytes());
        bytes.extend_from_slice(&[5, 0]);
    }
    bytes.extend_from_slice(&[255; 80]);
    bytes
}

fn view(ui: &mut Ui, parent: i32, width: f64, height: f64) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(id, spec::prop::WIDTH, width);
    ui.set_prop(id, spec::prop::HEIGHT, height);
    ui.set_prop(id, spec::prop::SHRINK, 0.0);
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

struct Fixture {
    ui: Ui,
    outer: i32,
    a: i32,
    b: i32,
    nested: i32,
    label: i32,
    ids: Vec<i32>,
}
fn fixture(regions: bool, nested_region: bool) -> Fixture {
    let mut ui = Ui::new();
    ui.set_viewport(250.0, 140.0);
    assert!(ui.load_font_atlas(&atlas()));
    let outer = view(&mut ui, spec::ROOT_ID, 210.5, 100.25);
    ui.set_prop(outer, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
    ui.set_prop(outer, spec::prop::PADDING_L, 0.35);
    ui.set_prop(outer, spec::prop::PADDING_T, 0.25);
    ui.set_prop(outer, spec::prop::GAP, 3.25);
    let a = view(&mut ui, outer, 70.3, 65.4);
    ui.set_prop(a, spec::prop::PADDING_L, 2.2);
    ui.set_prop(a, spec::prop::PADDING_T, 1.4);
    let b = view(&mut ui, outer, 80.6, 65.4);
    let nested = view(&mut ui, a, 30.3, 30.5);
    ui.set_prop(nested, spec::prop::PADDING_L, 0.2);
    let label = text(&mut ui, nested, "aaa");
    let outside = text(&mut ui, b, "bbb");
    if regions {
        assert!(ui.set_layout_region(a, true));
        assert!(ui.set_layout_region(b, true));
        if nested_region {
            assert!(ui.set_layout_region(nested, true));
        }
    }
    Fixture {
        ui,
        outer,
        a,
        b,
        nested,
        label,
        ids: vec![spec::ROOT_ID, outer, a, b, nested, label, outside],
    }
}
fn equivalent(a: &mut Fixture, b: &mut Fixture) {
    let left = a.ui.draw().words.clone();
    let right = b.ui.draw().words.clone();
    for (&left_id, &right_id) in a.ids.iter().zip(&b.ids) {
        assert_eq!(
            a.ui.layout_of(left_id),
            b.ui.layout_of(right_id),
            "node {left_id} rectangle"
        );
    }
    assert_eq!(left, right, "DrawList words");
    for (x, y) in [(1.0, 1.0), (12.0, 12.0), (80.0, 20.0), (249.0, 139.0)] {
        assert_eq!(a.ui.hit_test(x, y), b.ui.hit_test(x, y));
        assert_eq!(a.ui.hit_test_bounds(x, y), b.ui.hit_test_bounds(x, y));
    }
}

#[test]
fn independent_regions_preserve_fractional_edge_rounding_and_nested_layout() {
    for nested in [false, true] {
        let mut plain = fixture(false, nested);
        let mut split = fixture(true, nested);
        equivalent(&mut plain, &mut split);
        for offset in [-0.75, -0.5, -0.25, 0.0, 0.25, 0.49, 0.5, 0.75] {
            for fixture in [&mut plain, &mut split] {
                fixture
                    .ui
                    .set_prop(fixture.outer, spec::prop::MARGIN_L, offset);
                fixture
                    .ui
                    .set_prop(fixture.outer, spec::prop::MARGIN_T, -offset);
                fixture
                    .ui
                    .set_prop(fixture.a, spec::prop::WIDTH, 70.3 + offset);
            }
            equivalent(&mut plain, &mut split);
        }
    }
}

#[test]
fn structure_changes_are_local_and_text_empty_transitions_match() {
    let mut plain = fixture(false, true);
    let mut split = fixture(true, true);
    equivalent(&mut plain, &mut split);
    #[cfg(feature = "counters")]
    split.ui.reset_counters();
    for fixture in [&mut plain, &mut split] {
        let new = text(&mut fixture.ui, fixture.nested, "aa");
        fixture.ids.push(new);
    }
    equivalent(&mut plain, &mut split);
    #[cfg(feature = "counters")]
    {
        assert_eq!(split.ui.counters().layout.structure_rebuilds, 1);
        assert_eq!(split.ui.counters().layout.shaping_calls, 2); // Both inside nested; outside untouched.
    }
    for run in ["", "aaaa", "b"] {
        for fixture in [&mut plain, &mut split] {
            fixture.ui.set_text(fixture.label, run);
        }
        equivalent(&mut plain, &mut split);
    }
    for fixture in [&mut plain, &mut split] {
        let removed = fixture.ids.pop().unwrap();
        fixture.ui.destroy_node(removed);
    }
    equivalent(&mut plain, &mut split);
}

#[test]
fn boundary_properties_visibility_and_cross_region_moves_match() {
    let mut plain = fixture(false, true);
    let mut split = fixture(true, true);
    equivalent(&mut plain, &mut split);
    for fixture in [&mut plain, &mut split] {
        fixture.ui.set_prop(fixture.a, spec::prop::MARGIN_L, 6.5);
    }
    equivalent(&mut plain, &mut split);
    for id in [0, 1] {
        for fixture in [&mut plain, &mut split] {
            let root = if id == 0 { fixture.a } else { fixture.outer };
            fixture
                .ui
                .set_prop(root, spec::prop::DISPLAY, spec::Display::None as u8 as f64);
        }
        equivalent(&mut plain, &mut split);
        for fixture in [&mut plain, &mut split] {
            let root = if id == 0 { fixture.a } else { fixture.outer };
            fixture
                .ui
                .set_prop(root, spec::prop::DISPLAY, spec::Display::Flex as u8 as f64);
        }
        equivalent(&mut plain, &mut split);
    }
    for fixture in [&mut plain, &mut split] {
        fixture.ui.insert_before(fixture.b, fixture.label, 0);
    }
    equivalent(&mut plain, &mut split);
    for fixture in [&mut plain, &mut split] {
        fixture.ui.insert_before(fixture.a, fixture.nested, 0);
    }
    equivalent(&mut plain, &mut split);
    // A host mutation breaks the proof; the retained tree must still behave.
    for fixture in [&mut plain, &mut split] {
        fixture.ui.set_prop(fixture.a, spec::prop::SHRINK, 1.0);
    }
    equivalent(&mut plain, &mut split);
    assert!(!split.ui.is_layout_region(split.a));
}

#[test]
fn disabling_a_region_and_auxiliary_fallback_match() {
    let mut plain = fixture(false, true);
    let mut split = fixture(true, true);
    equivalent(&mut plain, &mut split);
    assert!(split.ui.set_layout_region(split.nested, false));
    equivalent(&mut plain, &mut split);
    for fixture in [&mut plain, &mut split] {
        let auxiliary = fixture.ui.create_auxiliary_surface(120.0, 80.0);
        fixture.ui.insert_before(auxiliary, fixture.a, 0);
        assert!(!fixture.ui.set_layout_region(fixture.a, true));
    }
    equivalent(&mut plain, &mut split);
    assert_eq!(
        plain.ui.draw_auxiliary().unwrap().words,
        split.ui.draw_auxiliary().unwrap().words
    );
    for (&left, &right) in plain.ids.iter().zip(&split.ids) {
        assert_eq!(plain.ui.layout_of(left), split.ui.layout_of(right));
    }
}

#[test]
#[should_panic(expected = "layout region requires")]
fn the_default_shrink_is_not_a_region_proof() {
    let mut ui = Ui::new();
    let node = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(node, spec::prop::WIDTH, 50.0);
    ui.set_prop(node, spec::prop::HEIGHT, 50.0);
    ui.insert_before(spec::ROOT_ID, node, 0);
    ui.set_layout_region(node, true);
}

#[test]
fn animation_viewport_font_reload_and_provider_fallback_match() {
    let mut plain = fixture(false, true);
    let mut split = fixture(true, true);
    equivalent(&mut plain, &mut split);
    for fixture in [&mut plain, &mut split] {
        fixture.ui.animate(
            fixture.a,
            spec::prop::WIDTH,
            86.75,
            90,
            spec::Easing::Linear as u8,
            0,
        );
        fixture.ui.animate(
            fixture.nested,
            spec::prop::PADDING_L,
            4.5,
            90,
            spec::Easing::Linear as u8,
            0,
        );
    }
    for _ in 0..8 {
        plain.ui.tick();
        split.ui.tick();
        equivalent(&mut plain, &mut split);
    }
    for fixture in [&mut plain, &mut split] {
        fixture.ui.set_viewport(100.0, 90.0);
    }
    equivalent(&mut plain, &mut split);
    let mut replacement = atlas();
    replacement[22] = 8; // 'a' advance changes; every affected run must reshape.
    for fixture in [&mut plain, &mut split] {
        assert!(fixture.ui.load_font_atlas(&replacement));
    }
    equivalent(&mut plain, &mut split);
    for fixture in [&mut plain, &mut split] {
        fixture.ui.set_text_measure(Some(Box::new(|text, _, _, _| {
            (text.len() as f32 * 7.25, 10.5)
        })));
    }
    equivalent(&mut plain, &mut split);
    assert!(!split.ui.is_layout_region(split.a));
}
