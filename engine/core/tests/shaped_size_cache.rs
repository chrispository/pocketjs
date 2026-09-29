//! A prefilled shaped-size cache versus live text shaping.

mod common;

use common::{atlas, fixed, text};
use pocketjs_core::spec::prop::*;
use pocketjs_core::{spec, Ui};

const BUDGET: usize = 2048;
const LABEL: &str = "aaa\na";

/// Stores the live-shaped size of `run` under the current atlas revision.
fn prefill(ui: &mut Ui, run: &str, tracking: f32, line_height: f32) -> bool {
    let size = ui.shaped_text_size(run, 0, tracking, line_height);
    ui.cache_shaped_size(0, ui.font_atlas_revision(0), run, tracking, line_height, size)
}

/// Two identical scenes: one label with tracking 0.5 and 10 px lines in a
/// 150x70 box. Only `cached` has a shaped-size cache.
struct Pair {
    live: Ui,
    cached: Ui,
    label: i32,
}

impl Pair {
    fn new(run: &str) -> Self {
        let scene = |budget: usize| {
            let mut ui = Ui::new();
            assert!(ui.load_font_atlas(&atlas(5, 255)));
            ui.set_shaped_size_cache_budget(budget);
            let parent = fixed(&mut ui, spec::ROOT_ID, 150.0, 70.0);
            let label = text(&mut ui, parent, run);
            common::set(&mut ui, label, &[(TRACKING, 0.5), (LINE_HEIGHT, 10.0)]);
            (ui, label)
        };
        let ((live, label), (cached, _)) = (scene(0), scene(BUDGET));
        Self { live, cached, label }
    }

    fn edit(&mut self, f: impl Fn(&mut Ui, i32)) {
        f(&mut self.live, self.label);
        f(&mut self.cached, self.label);
        self.check();
    }

    fn check(&mut self) {
        assert_eq!(self.live.draw().words, self.cached.draw().words);
        assert_eq!(self.live.layout_of(self.label), self.cached.layout_of(self.label));
    }

    /// (shaping calls, cache hits) on the cached side.
    #[cfg(feature = "counters")]
    fn work(&self) -> (u64, u64) {
        let layout = self.cached.counters().layout;
        (layout.shaping_calls, layout.shaping_cache_hits)
    }
}

#[test]
fn exact_key_hits_and_any_key_change_reshapes() {
    let mut pair = Pair::new(LABEL);
    assert!(prefill(&mut pair.cached, LABEL, 0.5, 10.0));
    pair.check();
    #[cfg(feature = "counters")]
    {
        assert_eq!(pair.work(), (0, 1));
        assert!(pair.cached.counters().layout.shaping_cache_bytes <= BUDGET as u64);
    }
    pair.edit(|ui, label| ui.set_prop(label, TRACKING, 1.0));
    pair.edit(|ui, label| ui.set_prop(label, LINE_HEIGHT, 12.0));
    pair.edit(|ui, label| ui.set_text(label, "aa"));
    #[cfg(feature = "counters")]
    assert_eq!(pair.work(), (3, 1));
}

#[test]
fn cache_stays_within_budget_and_font_reload_drops_old_entries() {
    let mut pair = Pair::new(LABEL);
    for len in 1..100 {
        assert!(prefill(&mut pair.cached, &"a".repeat(len), 0.0, f32::NAN));
        assert!(pair.cached.shaped_size_cache_bytes() <= BUDGET);
    }
    assert!(!prefill(&mut pair.cached, &"a".repeat(4096), 0.0, f32::NAN), "larger than the budget");
    assert!(prefill(&mut pair.cached, LABEL, 0.5, 10.0));
    let revision = pair.cached.font_atlas_revision(0);
    pair.edit(|ui, _| assert!(ui.load_font_atlas(&atlas(7, 255))));
    assert!(!pair.cached.cache_shaped_size(0, revision, LABEL, 0.5, 10.0, (16.5, 20.0)), "stale revision");
    #[cfg(feature = "counters")]
    assert_eq!(pair.work(), (1, 0));
    pair.cached.set_shaped_size_cache_budget(0);
    assert_eq!(pair.cached.shaped_size_cache_bytes(), 0);
    assert!(!prefill(&mut pair.cached, "a", 0.0, f32::NAN));
}

#[test]
fn native_and_streamed_text_ignore_prefilled_sizes() {
    let mut pair = Pair::new(LABEL);
    assert!(prefill(&mut pair.cached, LABEL, 0.5, 10.0));
    pair.edit(|ui, _| ui.set_text_measure(Some(Box::new(|_, _, _, _| (33.0, 20.0)))));
    assert!(!prefill(&mut pair.cached, "a", 0.0, f32::NAN));
    pair.edit(|ui, label| ui.set_prop(label, TRACKING, 0.0));
    pair.edit(|ui, _| {
        ui.set_text_measure(None);
        assert!(ui.font_stream_configure(&common::stream_config()));
    });
    assert!(!prefill(&mut pair.cached, "a", 0.0, f32::NAN));
    #[cfg(feature = "counters")]
    assert_eq!(pair.work().1, 0);
}

#[test]
fn layout_regions_use_the_same_cache() {
    let mut pair = Pair::new(LABEL);
    let parent = pair.cached.node_parent(pair.label);
    assert!(pair.cached.set_layout_region(parent, true));
    assert!(prefill(&mut pair.cached, LABEL, 0.5, 10.0));
    pair.check();
    #[cfg(feature = "counters")]
    assert_eq!(pair.work(), (0, 1));
}

#[test]
fn cache_hits_keep_glyph_miss_counts() {
    let mut pair = Pair::new("az\nz"); // 'z' is not in the atlas
    assert!(prefill(&mut pair.cached, "az\nz", 0.5, 10.0)); // live shaping counts misses too
    let before = (pair.live.glyph_misses(), pair.cached.glyph_misses());
    pair.check();
    let live = pair.live.glyph_misses() - before.0;
    assert!(live > 0);
    assert_eq!(live, pair.cached.glyph_misses() - before.1);
    #[cfg(feature = "counters")]
    assert_eq!(pair.work().1, 1);
}
