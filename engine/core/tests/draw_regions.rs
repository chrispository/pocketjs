use pocketjs_core::{
    damage::{DamageTarget, DamageTracker},
    raster, spec, Ui,
};

fn atlas(coverage: u8) -> Vec<u8> {
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
    bytes.extend_from_slice(&[coverage; 80]);
    bytes
}
fn view(ui: &mut Ui, parent: i32, w: f64, h: f64) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(id, spec::prop::WIDTH, w);
    ui.set_prop(id, spec::prop::HEIGHT, h);
    ui.set_prop(id, spec::prop::SHRINK, 0.0);
    ui.set_prop(id, spec::prop::BG_COLOR, 0xff554433u32 as f64);
    ui.insert_before(parent, id, 0);
    id
}
struct Fixture {
    ui: Ui,
    ancestor: i32,
    region: i32,
    text: i32,
    image: i32,
    texture: i32,
}
fn fixture(specialized: bool) -> Fixture {
    let mut ui = Ui::new();
    ui.set_viewport(160.0, 100.0);
    assert!(ui.load_font_atlas(&atlas(255)));
    let ancestor = view(&mut ui, spec::ROOT_ID, 130.0, 80.0);
    let region = view(&mut ui, ancestor, 110.0, 65.0);
    ui.set_prop(region, spec::prop::PADDING_L, 4.0);
    ui.set_prop(region, spec::prop::PADDING_T, 4.0);
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(text, "aaa");
    ui.insert_before(region, text, 0);
    let image = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(image, spec::prop::WIDTH, 20.0);
    ui.set_prop(image, spec::prop::HEIGHT, 20.0);
    ui.insert_before(region, image, 0);
    let texture = ui.upload_texture(&[255, 20, 10, 255], 1, 1, spec::psm::PSM_8888);
    ui.set_image(image, texture);
    if specialized {
        assert!(ui.set_layout_region(region, true));
    }
    Fixture {
        ui,
        ancestor,
        region,
        text,
        image,
        texture,
    }
}
fn equal(
    reference: &mut Fixture,
    specialized: &mut Fixture,
    tracker: &mut DamageTracker<8>,
    pixels: &mut [u8],
) {
    let expected = reference.ui.draw().words.clone();
    let actual = specialized.ui.draw().words.clone();
    assert_eq!(actual, expected);
    for id in [
        reference.ancestor,
        reference.region,
        reference.text,
        reference.image,
    ] {
        assert_eq!(reference.ui.layout_of(id), specialized.ui.layout_of(id));
    }
    let mut full = vec![0; pixels.len()];
    raster::render(&reference.ui, &expected, &mut full);
    let target = DamageTarget::new(160, 100, 1, 42);
    let plan = tracker.prepare(&specialized.ui, &actual, target).unwrap();
    raster::render_scaled_regions(&specialized.ui, &actual, pixels, 1, plan.regions());
    assert_eq!(pixels, full.as_slice());
    tracker.commit(&specialized.ui, &actual, target);
}

#[test]
fn cache_and_damage_follow_ancestor_clip_transform_opacity_fonts_textures_and_animation() {
    let mut reference = fixture(false);
    let mut specialized = fixture(true);
    let mut tracker = DamageTracker::<8>::new();
    let mut pixels = vec![0; 160 * 100 * 4];
    equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
    equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
    let changes: &[(u8, f64)] = &[
        (spec::prop::TRANSLATE_X, -70.3),
        (spec::prop::TRANSLATE_X, 0.3),
        (spec::prop::SCALE, 0.5),
        (spec::prop::TRANSLATE_X, 1.3),
        (spec::prop::ROTATE, 12.0),
        (spec::prop::ROTATE, 0.0),
        (spec::prop::SCALE, 1.0),
        (spec::prop::OVERFLOW, spec::Overflow::Hidden as u8 as f64),
        (spec::prop::WIDTH, 60.0),
        (spec::prop::WIDTH, 130.0),
        (spec::prop::OPACITY, 0.0),
        (spec::prop::OPACITY, 0.5),
        (spec::prop::OPACITY, 1.0),
    ];
    for &(prop, value) in changes {
        for f in [&mut reference, &mut specialized] {
            f.ui.set_prop(f.ancestor, prop, value);
        }
        equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
        equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
    }
    for text in ["bbb", "", "ab"] {
        for f in [&mut reference, &mut specialized] {
            f.ui.set_text(f.text, text);
        }
        equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
    }
    for f in [&mut reference, &mut specialized] {
        assert!(f.ui.load_font_atlas(&atlas(100)));
        f.ui.free_texture(f.texture);
        let texture =
            f.ui.upload_texture(&[20, 255, 10, 255], 1, 1, spec::psm::PSM_8888);
        f.ui.set_image(f.image, texture);
        f.ui.animate(f.region, spec::prop::OPACITY, 0.0, 80, 0, 0);
    }
    for _ in 0..8 {
        reference.ui.tick();
        specialized.ui.tick();
        equal(&mut reference, &mut specialized, &mut tracker, &mut pixels);
    }
}

#[cfg(feature = "counters")]
#[test]
fn cache_reuses_words_with_a_hard_budget_and_bypasses_perspective() {
    let mut f = fixture(true);
    let first = f.ui.draw().words.clone();
    let metadata_bytes = f.ui.counters().draw.segment_table_bytes;
    let segment_bytes = core::mem::size_of::<pocketjs_core::resources::DrawSegment>() as u64;
    assert!(metadata_bytes >= 2 * segment_bytes, "current table and cached table are counted");
    assert_eq!(metadata_bytes % segment_bytes, 0);
    f.ui.reset_counters();
    assert_eq!(f.ui.counters().draw.segment_table_bytes, metadata_bytes);
    assert_eq!(f.ui.draw().words, first);
    let counters = f.ui.counters().draw;
    assert_eq!(counters.region_cache_hits, 1);
    assert!(counters.generated_words < counters.words);
    assert!(counters.region_cache_bytes > 0);
    f.ui.set_draw_cache_budget(4);
    let current_table_bytes = f.ui.counters().draw.segment_table_bytes;
    assert!(current_table_bytes >= segment_bytes);
    assert!(current_table_bytes < metadata_bytes, "evicted cache metadata stops counting before the next draw");
    f.ui.reset_counters();
    assert_eq!(f.ui.draw().words, first);
    assert_eq!(f.ui.counters().draw.region_cache_hits, 0);
    assert!(f.ui.counters().draw.region_cache_bytes <= 4);
    f.ui.set_prop(f.ancestor, spec::prop::PERSPECTIVE, 400.0);
    f.ui.draw();
    assert!(f.ui.draw_segments().is_empty());
    f.ui.disable_layout_regions();
    assert_eq!(f.ui.counters().draw.segment_table_bytes, 0);
}

#[test]
fn nested_cached_segments_remain_nested_after_outer_hits() {
    let mut f = fixture(true);
    let nested = view(&mut f.ui, f.region, 20.0, 10.0);
    assert!(f.ui.set_layout_region(nested, true));
    let words = f.ui.draw().words.clone();
    let segments = f.ui.draw_segments().to_vec();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1].parent, Some(f.region as u64));
    assert_eq!(f.ui.draw().words, words);
    assert_eq!(f.ui.draw_segments(), segments);
}

#[cfg(feature = "counters")]
#[test]
fn static_plan_paints_the_first_frame_and_mutations_return_to_generic_words() {
    use pocketjs_core::{damage::DamageRect, draw::StaticDrawPlan};
    static PLAN: StaticDrawPlan = StaticDrawPlan {
        words: &[spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff554433],
        coordinates: &[1],
        patches: &[],
        origin: [10.0, 5.0],
        size: [20.0, 10.0],
        clip: [0.0, 0.0, 160.0, 100.0],
        opacity: 1.0,
        viewport: [160.0, 100.0],
        bounds: DamageRect::new(0, 0, 20, 10),
    };
    let make = |specialized: bool| {
        let mut ui = Ui::new();
        ui.set_viewport(160.0, 100.0);
        let id = view(&mut ui, spec::ROOT_ID, 20.0, 10.0);
        ui.set_prop(id, spec::prop::MARGIN_L, 10.0);
        ui.set_prop(id, spec::prop::MARGIN_T, 5.0);
        if specialized {
            assert!(ui.set_layout_region(id, true));
            assert!(ui.set_region_draw_plan(id, &PLAN));
        }
        (ui, id)
    };
    let (mut reference, id) = make(false);
    let (mut specialized, _) = make(true);
    assert_eq!(reference.draw().words, specialized.draw().words);
    assert_eq!(specialized.counters().draw.static_plan_hits, 1);
    assert_eq!(specialized.counters().draw.generated_words, 0);
    for value in [0.0, 0xff009988u32 as f64] {
        reference.set_prop(id, spec::prop::BG_COLOR, value);
        specialized.set_prop(id, spec::prop::BG_COLOR, value);
        assert_eq!(reference.draw().words, specialized.draw().words);
    }
    assert_eq!(specialized.counters().draw.static_plan_hits, 1);
}

#[cfg(feature = "counters")]
#[test]
fn finite_color_patch_reuses_static_words_and_damages_without_decoding() {
    use pocketjs_core::{
        damage::DamageRect,
        draw::{StaticDrawPatch, StaticDrawPlan},
    };
    static PLAN: StaticDrawPlan = StaticDrawPlan {
        words: &[spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff554433],
        coordinates: &[1],
        patches: &[StaticDrawPatch {
            word: 3,
            prop: spec::prop::BG_COLOR,
            candidates: &[0xff554433, 0x80556677],
        }],
        origin: [0.0, 0.0],
        size: [20.0, 10.0],
        clip: [0.0, 0.0, 160.0, 100.0],
        opacity: 1.0,
        viewport: [160.0, 100.0],
        bounds: DamageRect::new(0, 0, 20, 10),
    };
    let mut ui = Ui::new();
    ui.set_viewport(160.0, 100.0);
    let id = view(&mut ui, spec::ROOT_ID, 20.0, 10.0);
    assert!(ui.set_layout_region(id, true));
    assert!(ui.set_region_draw_plan(id, &PLAN));
    let first = ui.draw().words.clone();
    let mut tracker = DamageTracker::<8>::new();
    let target = DamageTarget::new(160, 100, 1, 42);
    tracker.commit(&ui, &first, target);
    ui.set_prop(id, spec::prop::BG_COLOR, 0x80556677u32 as f64);
    let second = ui.draw().words.clone();
    assert_eq!(second[3], 0x80556677);
    assert_eq!(ui.counters().draw.static_plan_hits, 2);
    let damage = tracker.prepare(&ui, &second, target).unwrap();
    assert_eq!(damage.bounds(), DamageRect::new(0, 0, 20, 10));
    assert_eq!(tracker.counters().decoded_ops, 0);
    let mut pixels = vec![0; 160 * 100 * 4];
    raster::render(&ui, &first, &mut pixels);
    raster::render_scaled_regions(&ui, &second, &mut pixels, 1, damage.regions());
    let mut full = vec![0; pixels.len()];
    raster::render(&ui, &second, &mut full);
    assert_eq!(pixels, full);
    ui.set_prop(id, spec::prop::BG_COLOR, 0.0);
    assert!(ui.draw().words.is_empty());
    assert_eq!(ui.counters().draw.static_plan_hits, 2);
    ui.set_prop(id, spec::prop::BG_COLOR, 0xff554433u32 as f64);
    ui.set_prop(id, spec::prop::RADIUS, 3.0);
    ui.draw();
    assert_eq!(ui.counters().draw.static_plan_hits, 2);
}

#[test]
fn region_reuse_preserves_missing_glyph_counts_and_streamed_paint_touches() {
    let mut reference = fixture(false);
    let mut specialized = fixture(true);
    for f in [&mut reference, &mut specialized] {
        f.ui.set_text(f.text, "zz");
    }
    for _ in 0..3 {
        assert_eq!(reference.ui.draw().words, specialized.ui.draw().words);
        assert_eq!(reference.ui.glyph_misses(), specialized.ui.glyph_misses());
    }
    for f in [&mut reference, &mut specialized] {
        f.ui.set_text(f.text, "ab");
    }
    let mut config = Vec::from(*b"PFS1");
    config.extend_from_slice(&1u32.to_le_bytes());
    config.extend_from_slice(&[0, 5, 8, 6, 9, 5, 1, 0, 2, 0, 0, 0]);
    for f in [&mut reference, &mut specialized] {
        assert!(f.ui.font_stream_configure(&config));
    }
    #[cfg(feature = "counters")]
    specialized.ui.reset_counters();
    for _ in 0..3 {
        assert_eq!(reference.ui.draw().words, specialized.ui.draw().words);
    }
    #[cfg(feature = "counters")]
    assert_eq!(specialized.ui.counters().draw.region_cache_hits, 0);
}
