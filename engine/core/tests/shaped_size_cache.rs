use pocketjs_core::{spec, Ui};

fn atlas(advance: u8) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    b.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    b.extend_from_slice(&(b'a' as u32).to_le_bytes());
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(&[advance, 0]);
    b.extend_from_slice(&[255; 40]);
    b
}
fn fixture(cache: bool) -> (Ui, i32) {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&atlas(5)));
    if cache {
        ui.set_shaped_size_cache_budget(2048);
    }
    let parent = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(parent, spec::prop::WIDTH, 150.0);
    ui.set_prop(parent, spec::prop::HEIGHT, 70.0);
    ui.set_prop(parent, spec::prop::SHRINK, 0.0);
    ui.insert_before(spec::ROOT_ID, parent, 0);
    let label = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(label, "aaa\na");
    ui.set_prop(label, spec::prop::TRACKING, 0.5);
    ui.set_prop(label, spec::prop::LINE_HEIGHT, 10.0);
    ui.insert_before(parent, label, 0);
    (ui, label)
}
fn prefill(ui: &mut Ui, text: &str, tracking: f32, line_height: f32) -> bool {
    let size = ui.shaped_text_size(text, 0, tracking, line_height);
    ui.cache_shaped_size(
        0,
        ui.font_atlas_revision(0),
        text,
        tracking,
        line_height,
        size,
    )
}
fn equivalent(plain: &mut Ui, cached: &mut Ui, node: i32) {
    assert_eq!(plain.draw().words, cached.draw().words);
    assert_eq!(plain.layout_of(node), cached.layout_of(node));
}

#[test]
fn cache_matches_draws_and_key_changes_fall_back() {
    let (mut plain, node) = fixture(false);
    let (mut cached, _) = fixture(true);
    assert!(prefill(&mut cached, "aaa\na", 0.5, 10.0));
    equivalent(&mut plain, &mut cached, node);
    #[cfg(feature = "counters")]
    {
        assert_eq!(cached.counters().layout.shaping_calls, 0);
        assert_eq!(cached.counters().layout.shaping_cache_hits, 1);
        assert!(cached.counters().layout.shaping_cache_bytes <= 2048);
    }
    for ui in [&mut plain, &mut cached] {
        ui.set_prop(node, spec::prop::TRACKING, 1.0);
    }
    equivalent(&mut plain, &mut cached, node);
    for ui in [&mut plain, &mut cached] {
        ui.set_prop(node, spec::prop::LINE_HEIGHT, 12.0);
    }
    equivalent(&mut plain, &mut cached, node);
    for ui in [&mut plain, &mut cached] {
        ui.set_text(node, "aa");
    }
    equivalent(&mut plain, &mut cached, node);
    #[cfg(feature = "counters")]
    assert_eq!(cached.counters().layout.shaping_calls, 3);
}

#[test]
fn cache_is_bounded_and_reloading_invalidates_old_revisions() {
    let (mut plain, node) = fixture(false);
    let (mut cached, _) = fixture(true);
    for len in 1..100 {
        assert!(prefill(&mut cached, &"a".repeat(len), 0.0, f32::NAN));
        assert!(cached.shaped_size_cache_bytes() <= 2048);
    }
    assert!(!prefill(&mut cached, &"a".repeat(4096), 0.0, f32::NAN));
    assert!(prefill(&mut cached, "aaa\na", 0.5, 10.0));
    let revision = cached.font_atlas_revision(0);
    for ui in [&mut plain, &mut cached] {
        assert!(ui.load_font_atlas(&atlas(7)));
    }
    assert!(!cached.cache_shaped_size(0, revision, "aaa\na", 0.5, 10.0, (16.5, 20.0)));
    equivalent(&mut plain, &mut cached, node);
    #[cfg(feature = "counters")]
    {
        assert_eq!(cached.counters().layout.shaping_calls, 1);
        assert_eq!(cached.counters().layout.shaping_cache_hits, 0);
    }
    cached.set_shaped_size_cache_budget(0);
    assert_eq!(cached.shaped_size_cache_bytes(), 0);
    assert!(!prefill(&mut cached, "a", 0.0, f32::NAN));
}

#[test]
fn native_and_streamed_providers_never_use_prefilled_sizes() {
    let (mut plain, node) = fixture(false);
    let (mut cached, _) = fixture(true);
    assert!(prefill(&mut cached, "aaa\na", 0.5, 10.0));
    for ui in [&mut plain, &mut cached] {
        ui.set_text_measure(Some(Box::new(|_, _, _, _| (33.0, 20.0))));
    }
    assert!(!prefill(&mut cached, "a", 0.0, f32::NAN));
    equivalent(&mut plain, &mut cached, node);
    for ui in [&mut plain, &mut cached] {
        ui.set_prop(node, spec::prop::TRACKING, 0.0);
    }
    equivalent(&mut plain, &mut cached, node);
    for ui in [&mut plain, &mut cached] {
        ui.set_text_measure(None);
    }
    let mut config = Vec::from(*b"PFS1");
    config.extend_from_slice(&1u32.to_le_bytes());
    config.extend_from_slice(&[0, 5, 8, 6, 9, 5, 1, 0, 2, 0, 0, 0]);
    for ui in [&mut plain, &mut cached] {
        assert!(ui.font_stream_configure(&config));
    }
    assert!(!prefill(&mut cached, "a", 0.0, f32::NAN));
    equivalent(&mut plain, &mut cached, node);
    #[cfg(feature = "counters")]
    assert_eq!(cached.counters().layout.shaping_cache_hits, 0);
}

#[test]
fn regions_use_the_same_prefilled_cache() {
    let (mut plain, node) = fixture(false);
    let (mut cached, _) = fixture(true);
    let parent = cached.node_parent(node);
    assert!(cached.set_layout_region(parent, true));
    assert!(prefill(&mut cached, "aaa\na", 0.5, 10.0));
    equivalent(&mut plain, &mut cached, node);
    #[cfg(feature = "counters")]
    {
        assert_eq!(cached.counters().layout.shaping_calls, 0);
        assert_eq!(cached.counters().layout.shaping_cache_hits, 1);
    }
}

#[test]
fn cache_hits_preserve_missing_glyph_accounting() {
    let (mut plain, node) = fixture(false);
    let (mut cached, _) = fixture(true);
    for ui in [&mut plain, &mut cached] {
        ui.set_text(node, "az\nz");
    }
    assert!(prefill(&mut cached, "az\nz", 0.5, 10.0));
    let plain_before = plain.glyph_misses();
    let cached_before = cached.glyph_misses();
    equivalent(&mut plain, &mut cached, node);
    assert_eq!(
        plain.glyph_misses() - plain_before,
        cached.glyph_misses() - cached_before
    );
    #[cfg(feature = "counters")]
    assert_eq!(cached.counters().layout.shaping_cache_hits, 1);
}
