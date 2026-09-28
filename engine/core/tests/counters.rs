//! The same frame sequence is exercised with and without instrumentation.
use pocketjs_core::damage::{DamageTarget, DamageTracker};
use pocketjs_core::{spec, Ui};

#[test]
fn layout_and_draw_work_match_the_emitted_frame() {
    let mut ui = Ui::new();
    ui.set_viewport(80.0, 60.0);
    let card = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(card, spec::prop::WIDTH, 20.0);
    ui.set_prop(card, spec::prop::HEIGHT, 10.0);
    ui.set_prop(card, spec::prop::BG_COLOR, 0xff12_3456u32 as f64);
    ui.insert_before(spec::ROOT_ID, card, 0);
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(text, "sensor");
    ui.insert_before(card, text, 0);
    let initial = vec![spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff12_3456];
    assert_eq!(ui.draw().words, initial);
    #[cfg(feature = "counters")]
    {
        let counts = ui.counters();
        assert_eq!(counts.layout.structure_rebuilds, 1);
        assert_eq!(counts.layout.style_updates, 0);
        assert_eq!(counts.layout.shaping_calls, 1);
        assert_eq!(counts.layout.taffy_nodes_created, 3);
        assert_eq!(counts.layout.taffy_nodes, 3);
        assert_eq!(counts.draw.builds, 1);
        assert_eq!(counts.draw.ops, 1);
        assert_eq!(counts.draw.words, initial.len() as u64);
    }
    assert_eq!(ui.draw().words, initial);
    ui.set_prop(card, spec::prop::WIDTH, 22.0);
    // Duplicate dirty marks must count a single taffy set_style operation.
    ui.set_prop(card, spec::prop::WIDTH, 23.0);
    ui.draw();
    #[cfg(feature = "counters")]
    {
        assert_eq!(ui.counters().layout.structure_rebuilds, 1);
        assert_eq!(ui.counters().layout.style_updates, 1);
        assert_eq!(ui.counters().layout.shaping_calls, 1);
        assert_eq!(ui.counters().draw.builds, 3);
    }
    ui.set_prop(text, spec::prop::TRACKING, 1.0);
    ui.draw();
    #[cfg(feature = "counters")]
    {
        assert_eq!(ui.counters().layout.style_updates, 2);
        assert_eq!(ui.counters().layout.shaping_calls, 2);
    }
    ui.set_text(text, "");
    let final_words = vec![spec::draw_op::RECT, 0, 23 | (10 << 16), 0xff12_3456];
    assert_eq!(ui.draw().words, final_words);
    #[cfg(feature = "counters")]
    {
        assert_eq!(ui.counters().layout.structure_rebuilds, 2);
        assert_eq!(ui.counters().layout.shaping_calls, 2);
        assert_eq!(ui.counters().layout.taffy_nodes_created, 5);
        assert_eq!(ui.counters().layout.taffy_nodes, 2);
        ui.reset_counters();
        assert_eq!(ui.counters().layout.taffy_nodes, 2);
        assert_eq!(ui.counters().layout.structure_rebuilds, 0);
        assert_eq!(ui.counters().draw.builds, 0);
    }
    assert_eq!(ui.draw().words, final_words);
    #[cfg(feature = "counters")]
    {
        assert_eq!(ui.counters().layout.structure_rebuilds, 0);
        assert_eq!(ui.counters().draw.words, final_words.len() as u64);
    }
}

#[test]
fn damage_counts_actual_decoding_and_preserves_committed_baseline_on_reset() {
    let mut ui = Ui::new();
    ui.set_viewport(80.0, 60.0);
    let target = DamageTarget::new(80, 60, 1, 1);
    let mut tracker = DamageTracker::<8>::new();
    let first = [spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff12_3456];
    let second = [spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff65_4321];
    let initial = tracker.prepare(&ui, &first, target).unwrap();
    assert!(initial.is_full_redraw());
    tracker.commit(&ui, &first, target);
    assert!(tracker.prepare(&ui, &first, target).unwrap().is_empty());
    let changed = tracker.prepare(&ui, &second, target).unwrap();
    assert!(!changed.is_full_redraw());
    assert_eq!(changed.area(), 200);
    #[cfg(feature = "counters")]
    {
        let counts = tracker.counters();
        assert_eq!(counts.decoded_ops, 3); // First frame once; old and new changed ops.
        assert_eq!(counts.prepares, 3);
        assert_eq!(counts.full_redraws, 1);
        assert_eq!(counts.area, 80 * 60 + 200);
        tracker.reset_counters();
        assert_eq!(tracker.counters(), Default::default());
    }
    // The changed frame was not committed: resetting metrics cannot commit it.
    assert_eq!(tracker.prepare(&ui, &second, target).unwrap(), changed);
    #[cfg(feature = "counters")]
    {
        assert_eq!(tracker.counters().decoded_ops, 2);
        assert_eq!(tracker.counters().full_redraws, 0);
    }
}

#[cfg(feature = "counters")]
#[test]
fn auxiliary_outputs_contribute_to_ui_totals() {
    let mut ui = Ui::new();
    let auxiliary = ui.create_auxiliary_surface(20.0, 10.0);
    let card = ui.create_node(spec::NodeType::View as u8);
    ui.insert_before(auxiliary, card, 0);
    ui.set_prop(card, spec::prop::HEIGHT, 4.0);
    ui.set_prop(card, spec::prop::BG_COLOR, 0xff12_3456u32 as f64);
    assert!(ui.draw().words.is_empty());
    let words = ui.draw_auxiliary().unwrap().words.len() as u64;
    let counts = ui.counters();
    assert_eq!(counts.layout.structure_rebuilds, 2);
    assert_eq!(counts.layout.taffy_nodes, 3);
    assert_eq!(counts.draw.builds, 2);
    assert_eq!(counts.draw.ops, 1);
    assert_eq!(counts.draw.words, words);
    assert_eq!(counts.draw.segment_table_bytes, 0);
    ui.reset_counters();
    assert_eq!(ui.counters().layout.taffy_nodes, 3);
    assert_eq!(ui.counters().draw.words, 0);
}

#[cfg(not(feature = "counters"))]
#[test]
fn ordinary_draw_list_has_no_counter_storage() {
    assert_eq!(
        core::mem::size_of::<pocketjs_core::DrawList>(),
        core::mem::size_of::<Vec<u32>>() + core::mem::size_of::<Option<Box<()>>>()
    );
}
