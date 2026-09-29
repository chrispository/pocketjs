//! Region draw caches and static draw plans versus generic drawing. Damage
//! computed from the specialized words must repaint to the full-frame pixels.

mod common;

use common::{atlas, fixed};
use pocketjs_core::damage::{DamageTarget, DamageTracker};
use pocketjs_core::spec::prop::*;
use pocketjs_core::{raster, spec, Ui};

const PIXELS: usize = 160 * 100 * 4;

fn target() -> DamageTarget {
    DamageTarget::new(160, 100, 1, 42)
}

/// ancestor -> region -> [text "aaa", 20x20 image].
struct Scene {
    ui: Ui,
    ancestor: i32,
    region: i32,
    text: i32,
    image: i32,
    texture: i32,
}

fn scene(region: bool) -> Scene {
    let mut ui = Ui::new();
    ui.set_viewport(160.0, 100.0);
    assert!(ui.load_font_atlas(&atlas(5, 255)));
    let ancestor = fixed(&mut ui, spec::ROOT_ID, 130.0, 80.0);
    let region_id = fixed(&mut ui, ancestor, 110.0, 65.0);
    common::set(&mut ui, region_id, &[(PADDING_L, 4.0), (PADDING_T, 4.0)]);
    let text = common::text(&mut ui, region_id, "aaa");
    let image = ui.create_node(spec::NodeType::Image as u8);
    common::set(&mut ui, image, &[(WIDTH, 20.0), (HEIGHT, 20.0)]);
    ui.insert_before(region_id, image, 0);
    let texture = ui.upload_texture(&[255, 20, 10, 255], 1, 1, spec::psm::PSM_8888);
    ui.set_image(image, texture);
    if region {
        assert!(ui.set_layout_region(region_id, true));
    }
    Scene { ui, ancestor, region: region_id, text, image, texture }
}

/// The generic scene is the reference; the region scene draws through its
/// cache and repaints only the damaged area of a retained framebuffer.
struct Pair {
    generic: Scene,
    cached: Scene,
    tracker: DamageTracker<8>,
    framebuffer: Vec<u8>,
}

impl Pair {
    fn new() -> Self {
        let mut pair = Self {
            generic: scene(false),
            cached: scene(true),
            tracker: DamageTracker::new(),
            framebuffer: vec![0; PIXELS],
        };
        pair.check();
        pair
    }

    fn edit(&mut self, mut f: impl FnMut(&mut Scene)) {
        f(&mut self.generic);
        f(&mut self.cached);
        // The second draw exercises a cache hit for the same frame.
        self.check();
        self.check();
    }

    fn check(&mut self) {
        let expected = self.generic.ui.draw().words.clone();
        let actual = self.cached.ui.draw().words.clone();
        assert_eq!(actual, expected);
        let (g, c) = (&self.generic, &self.cached);
        for (generic, cached) in [(g.ancestor, c.ancestor), (g.region, c.region), (g.text, c.text), (g.image, c.image)]
        {
            assert_eq!(g.ui.layout_of(generic), c.ui.layout_of(cached));
        }
        let mut full = vec![0; PIXELS];
        raster::render(&self.generic.ui, &expected, &mut full);
        let plan = self.tracker.prepare(&self.cached.ui, &actual, target()).unwrap();
        raster::render_scaled_regions(&self.cached.ui, &actual, &mut self.framebuffer, 1, plan.regions());
        assert_eq!(self.framebuffer, full);
        self.tracker.commit(&self.cached.ui, &actual, target());
    }
}

#[test]
fn cache_and_damage_follow_ancestor_paint_text_fonts_textures_and_animation() {
    let mut pair = Pair::new();
    let ancestor_changes: &[(u8, f64)] = &[
        (TRANSLATE_X, -70.3),
        (TRANSLATE_X, 0.3),
        (SCALE, 0.5),
        (TRANSLATE_X, 1.3),
        (ROTATE, 12.0),
        (ROTATE, 0.0),
        (SCALE, 1.0),
        (OVERFLOW, spec::Overflow::Hidden as u8 as f64),
        (WIDTH, 60.0),
        (WIDTH, 130.0),
        (OPACITY, 0.0),
        (OPACITY, 0.5),
        (OPACITY, 1.0),
    ];
    for &(prop, value) in ancestor_changes {
        pair.edit(|s| s.ui.set_prop(s.ancestor, prop, value));
    }
    for run in ["bbb", "", "ab"] {
        pair.edit(|s| s.ui.set_text(s.text, run));
    }
    pair.edit(|s| {
        assert!(s.ui.load_font_atlas(&atlas(5, 100)));
        s.ui.free_texture(s.texture);
        let texture = s.ui.upload_texture(&[20, 255, 10, 255], 1, 1, spec::psm::PSM_8888);
        s.ui.set_image(s.image, texture);
        s.ui.animate(s.region, OPACITY, 0.0, 80, 0, 0);
    });
    for _ in 0..8 {
        pair.edit(|s| {
            s.ui.tick();
        });
    }
}

#[cfg(feature = "counters")]
#[test]
fn cache_reuses_words_within_its_budget_and_skips_perspective() {
    let mut s = scene(true);
    let first = s.ui.draw().words.clone();
    let segment = core::mem::size_of::<pocketjs_core::resources::DrawSegment>() as u64;
    let table_bytes = s.ui.counters().draw.segment_table_bytes;
    assert!(table_bytes >= 2 * segment, "current and cached segment tables are counted");
    assert_eq!(table_bytes % segment, 0);
    s.ui.reset_counters();
    assert_eq!(s.ui.counters().draw.segment_table_bytes, table_bytes, "a gauge, not a counter");
    assert_eq!(s.ui.draw().words, first);
    let draw = s.ui.counters().draw;
    assert_eq!(draw.region_cache_hits, 1);
    assert!(draw.generated_words < draw.words);
    assert!(draw.region_cache_bytes > 0);

    s.ui.set_draw_cache_budget(4);
    let evicted = s.ui.counters().draw.segment_table_bytes;
    assert!(segment <= evicted && evicted < table_bytes, "evicted cache metadata is released at once");
    s.ui.reset_counters();
    assert_eq!(s.ui.draw().words, first);
    assert_eq!(s.ui.counters().draw.region_cache_hits, 0);
    assert!(s.ui.counters().draw.region_cache_bytes <= 4);

    s.ui.set_prop(s.ancestor, PERSPECTIVE, 400.0);
    s.ui.draw();
    assert!(s.ui.draw_segments().is_empty());
    s.ui.disable_layout_regions();
    assert_eq!(s.ui.counters().draw.segment_table_bytes, 0);
}

#[test]
fn nested_segments_stay_nested_after_an_outer_cache_hit() {
    let mut s = scene(true);
    let nested = fixed(&mut s.ui, s.region, 20.0, 10.0);
    assert!(s.ui.set_layout_region(nested, true));
    let words = s.ui.draw().words.clone();
    let segments = s.ui.draw_segments().to_vec();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1].parent, Some(s.region as u64));
    assert_eq!(s.ui.draw().words, words);
    assert_eq!(s.ui.draw_segments(), segments);
}

/// Static plans are observable only through the draw counters.
#[cfg(feature = "counters")]
mod static_plans {
    use super::*;
    use common::FILL;
    use pocketjs_core::damage::DamageRect;
    use pocketjs_core::draw::{StaticDrawPatch, StaticDrawPlan};

    /// The words a 20x10 `fixed` view draws at the origin.
    const BOX: &[u32] = &[spec::draw_op::RECT, 0, 20 | (10 << 16), FILL];

    const fn plan(origin: [f32; 2], patches: &'static [StaticDrawPatch]) -> StaticDrawPlan {
        StaticDrawPlan {
            words: BOX,
            coordinates: &[1],
            patches,
            origin,
            size: [20.0, 10.0],
            clip: [0.0, 0.0, 160.0, 100.0],
            opacity: 1.0,
            viewport: [160.0, 100.0],
            bounds: DamageRect::new(0, 0, 20, 10),
        }
    }

    fn planned_box(margin: f64, plan: Option<&'static StaticDrawPlan>) -> (Ui, i32) {
        let mut ui = Ui::new();
        ui.set_viewport(160.0, 100.0);
        let id = fixed(&mut ui, spec::ROOT_ID, 20.0, 10.0);
        common::set(&mut ui, id, &[(MARGIN_L, margin), (MARGIN_T, margin / 2.0)]);
        if let Some(plan) = plan {
            assert!(ui.set_layout_region(id, true));
            assert!(ui.set_region_draw_plan(id, plan));
        }
        (ui, id)
    }

    #[test]
    fn static_plan_draws_the_first_frame_then_mutations_use_generic_words() {
        static PLAN: StaticDrawPlan = plan([10.0, 5.0], &[]);
        let (mut generic, id) = planned_box(10.0, None);
        let (mut planned, _) = planned_box(10.0, Some(&PLAN));
        assert_eq!(generic.draw().words, planned.draw().words);
        assert_eq!((planned.counters().draw.static_plan_hits, planned.counters().draw.generated_words), (1, 0));
        for color in [0.0, 0xff00_9988u32 as f64] {
            generic.set_prop(id, BG_COLOR, color);
            planned.set_prop(id, BG_COLOR, color);
            assert_eq!(generic.draw().words, planned.draw().words);
        }
        assert_eq!(planned.counters().draw.static_plan_hits, 1);
    }

    #[test]
    fn candidate_color_patches_reuse_the_plan_and_damage_without_decoding() {
        const HALF: u32 = 0x8055_6677;
        static PLAN: StaticDrawPlan =
            plan([0.0, 0.0], &[StaticDrawPatch { word: 3, prop: BG_COLOR, candidates: &[FILL, HALF] }]);
        let (mut ui, id) = planned_box(0.0, Some(&PLAN));
        let first = ui.draw().words.clone();
        let mut tracker = DamageTracker::<8>::new();
        tracker.commit(&ui, &first, target());

        ui.set_prop(id, BG_COLOR, HALF as f64);
        let second = ui.draw().words.clone();
        assert_eq!(second[3], HALF);
        assert_eq!(ui.counters().draw.static_plan_hits, 2);
        let damage = tracker.prepare(&ui, &second, target()).unwrap();
        assert_eq!(damage.bounds(), DamageRect::new(0, 0, 20, 10));
        assert_eq!(tracker.counters().decoded_ops, 0);
        let (mut partial, mut full) = (vec![0; PIXELS], vec![0; PIXELS]);
        raster::render(&ui, &first, &mut partial);
        raster::render_scaled_regions(&ui, &second, &mut partial, 1, damage.regions());
        raster::render(&ui, &second, &mut full);
        assert_eq!(partial, full);

        // A transparent fill and a non-candidate prop leave the plan.
        ui.set_prop(id, BG_COLOR, 0.0);
        assert!(ui.draw().words.is_empty());
        ui.set_prop(id, BG_COLOR, FILL as f64);
        ui.set_prop(id, RADIUS, 3.0);
        ui.draw();
        assert_eq!(ui.counters().draw.static_plan_hits, 2);
    }
}

#[test]
fn cached_regions_keep_glyph_misses_and_streamed_font_paint() {
    let (mut generic, mut cached) = (scene(false), scene(true));
    for s in [&mut generic, &mut cached] {
        s.ui.set_text(s.text, "zz");
    }
    for _ in 0..3 {
        assert_eq!(generic.ui.draw().words, cached.ui.draw().words);
        assert_eq!(generic.ui.glyph_misses(), cached.ui.glyph_misses());
    }
    for s in [&mut generic, &mut cached] {
        s.ui.set_text(s.text, "ab");
        assert!(s.ui.font_stream_configure(&common::stream_config()));
    }
    #[cfg(feature = "counters")]
    cached.ui.reset_counters();
    for _ in 0..3 {
        assert_eq!(generic.ui.draw().words, cached.ui.draw().words);
    }
    #[cfg(feature = "counters")]
    assert_eq!(cached.ui.counters().draw.region_cache_hits, 0, "streamed glyphs bypass the cache");
}
