//! Work counters. The draw words are asserted with and without the
//! `counters` feature, so instrumentation cannot change the output.

mod common;

use common::{text, view, FILL};
use pocketjs_core::damage::{DamageTarget, DamageTracker};
use pocketjs_core::spec::draw_op::RECT;
use pocketjs_core::spec::prop::*;
use pocketjs_core::{spec, Ui};

fn rect(width: u32) -> Vec<u32> {
    vec![RECT, 0, width | (10 << 16), FILL]
}

#[test]
fn layout_and_draw_counters_match_the_work_done() {
    let mut ui = Ui::new();
    ui.set_viewport(80.0, 60.0);
    let card = view(&mut ui, spec::ROOT_ID, Some(20.0), Some(10.0));
    let label = text(&mut ui, card, "sensor"); // no atlas: measured, not drawn
    assert_eq!(ui.draw().words, rect(20));
    #[cfg(feature = "counters")]
    {
        let (layout, draw) = (ui.counters().layout, ui.counters().draw);
        assert_eq!((layout.structure_rebuilds, layout.style_updates, layout.shaping_calls), (1, 0, 1));
        assert_eq!((layout.taffy_nodes_created, layout.taffy_nodes), (3, 3));
        assert_eq!((draw.builds, draw.ops, draw.words), (1, 1, 4));
    }
    assert_eq!(ui.draw().words, rect(20));
    ui.set_prop(card, WIDTH, 22.0);
    ui.set_prop(card, WIDTH, 23.0); // one Taffy style update for both writes
    ui.draw();
    #[cfg(feature = "counters")]
    {
        let layout = ui.counters().layout;
        assert_eq!((layout.structure_rebuilds, layout.style_updates, layout.shaping_calls), (1, 1, 1));
        assert_eq!(ui.counters().draw.builds, 3);
    }
    ui.set_prop(label, TRACKING, 1.0); // changes measurement, not the flex style
    ui.draw();
    #[cfg(feature = "counters")]
    assert_eq!((ui.counters().layout.style_updates, ui.counters().layout.shaping_calls), (1, 2));
    ui.set_text(label, ""); // empty text leaves the solver
    assert_eq!(ui.draw().words, rect(23));
    #[cfg(feature = "counters")]
    {
        let layout = ui.counters().layout;
        assert_eq!((layout.structure_rebuilds, layout.structure_syncs, layout.shaping_calls), (1, 2, 2));
        assert_eq!((layout.taffy_nodes_created, layout.taffy_nodes), (3, 2));
        ui.reset_counters();
        let layout = ui.counters().layout;
        assert_eq!(
            (layout.taffy_nodes, layout.structure_rebuilds, ui.counters().draw.builds),
            (2, 0, 0),
            "taffy_nodes is a gauge"
        );
    }
    assert_eq!(ui.draw().words, rect(23));
    #[cfg(feature = "counters")]
    assert_eq!((ui.counters().layout.structure_rebuilds, ui.counters().draw.words), (0, 4));
}

#[test]
fn damage_counters_track_decoding_and_reset_keeps_the_committed_frame() {
    let mut ui = Ui::new();
    ui.set_viewport(80.0, 60.0);
    let target = DamageTarget::new(80, 60, 1, 1);
    let mut tracker = DamageTracker::<8>::new();
    let first = rect(20);
    let mut second = rect(20);
    second[3] = 0xff65_4321;
    assert!(tracker.prepare(&ui, &first, target).unwrap().is_full_redraw());
    tracker.commit(&ui, &first, target);
    assert!(tracker.prepare(&ui, &first, target).unwrap().is_empty());
    let changed = tracker.prepare(&ui, &second, target).unwrap();
    assert!(!changed.is_full_redraw());
    assert_eq!(changed.area(), 200);
    #[cfg(feature = "counters")]
    {
        let counts = tracker.counters();
        // The first frame decodes once; the change decodes the old and new op.
        assert_eq!((counts.decoded_ops, counts.prepares, counts.full_redraws), (3, 3, 1));
        assert_eq!(counts.area, 80 * 60 + 200);
        tracker.reset_counters();
        assert_eq!(tracker.counters(), Default::default());
    }
    // `second` was never committed, so the same damage is reported again.
    assert_eq!(tracker.prepare(&ui, &second, target).unwrap(), changed);
    #[cfg(feature = "counters")]
    assert_eq!((tracker.counters().decoded_ops, tracker.counters().full_redraws), (2, 0));
}

#[cfg(feature = "counters")]
#[test]
fn auxiliary_output_work_is_included_in_ui_totals() {
    let mut ui = Ui::new();
    let auxiliary = ui.create_auxiliary_surface(20.0, 10.0);
    view(&mut ui, auxiliary, None, Some(4.0));
    assert!(ui.draw().words.is_empty());
    let words = ui.draw_auxiliary().unwrap().words.len() as u64;
    let (layout, draw) = (ui.counters().layout, ui.counters().draw);
    assert_eq!((layout.structure_rebuilds, layout.taffy_nodes), (2, 3));
    assert_eq!((draw.builds, draw.ops, draw.words, draw.segment_table_bytes), (2, 1, words, 0));
    ui.reset_counters();
    assert_eq!((ui.counters().layout.taffy_nodes, ui.counters().draw.words), (3, 0));
}

#[cfg(not(feature = "counters"))]
#[test]
fn draw_list_has_no_counter_storage_without_the_feature() {
    use core::mem::size_of;
    assert_eq!(size_of::<pocketjs_core::DrawList>(), size_of::<Vec<u32>>() + size_of::<Option<Box<()>>>());
}
