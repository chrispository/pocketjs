use microts::pocketjs_core::spec;
use microts::{NodeId, StyleId, Ui};

#[test]
fn instrumentation_keeps_view_behavior_and_counts_calls() {
    let mut ui = Ui::new();
    let card = ui.create_node(spec::NodeType::View as u8);
    let child = ui.create_node(spec::NodeType::Text as u8);
    ui.insert_before(NodeId::ROOT, card, NodeId::NONE);
    ui.insert_before(card, child, NodeId::NONE);
    ui.set_style(card, StyleId::NONE);
    ui.set_prop(card, spec::prop::WIDTH, 20.0);
    ui.set_prop(card, spec::prop::HEIGHT, 10.0);
    ui.set_prop(card, spec::prop::BG_COLOR, 0xff12_3456u32 as f64);
    ui.set_text(child, "sensor");
    ui.record_update_at();
    ui.record_memo_evaluation();
    ui.record_memo_evaluation();
    ui.record_memo_write();
    assert_eq!(
        ui.core_mut().draw().words,
        [spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff12_3456]
    );
    #[cfg(feature = "counters")]
    {
        let counts = ui.counters();
        assert_eq!(counts.nodes_created, 2);
        assert_eq!(counts.set_style, 1);
        assert_eq!(counts.set_prop, 3);
        assert_eq!(counts.set_text, 1);
        assert_eq!(counts.update_at, 1);
        assert_eq!(counts.memo_evaluations, 2);
        assert_eq!(counts.memo_writes, 1);
        assert_eq!(ui.core().counters().layout.structure_rebuilds, 1);
    }
    ui.destroy_node(NodeId::ROOT);
    assert!(ui.core().node_exists(card.0));
    ui.destroy_node(card);
    ui.destroy_node(card); // A stale id destroys no nodes.
    assert!(!ui.core().node_exists(card.0));
    assert!(!ui.core().node_exists(child.0));
    #[cfg(feature = "counters")]
    {
        assert_eq!(ui.counters().nodes_destroyed, 2);
        ui.reset_counters();
        assert_eq!(ui.counters(), Default::default());
        assert_eq!(ui.core().counters().layout.structure_rebuilds, 0);
    }
}

#[cfg(feature = "harness")]
#[test]
fn logical_identities_retain_destroyed_targets_for_queued_commands() {
    let mut ui = Ui::new();
    let card = ui.create_node(spec::NodeType::View as u8);
    let child = ui.create_node(spec::NodeType::Text as u8);
    ui.insert_before(NodeId::ROOT, card, NodeId::NONE);
    ui.insert_before(card, child, NodeId::NONE);
    ui.register_logical_node(card, "app/sensors/key:12/node:0".into());
    ui.register_logical_node(child, "app/sensors/key:12/node:1".into());
    assert_eq!(ui.logical_node(NodeId::ROOT), Some("$root"));
    assert_eq!(ui.logical_node(NodeId::NONE), Some("$none"));
    assert_eq!(ui.logical_node(child), Some("app/sensors/key:12/node:1"));
    let queued_command = microts::Cmd::Jump {
        node: Some(child),
        prop: spec::prop::WIDTH,
        value: 24.0,
    };
    ui.destroy_node(card);
    assert_eq!(ui.logical_node(card), Some("app/sensors/key:12/node:0"));
    let microts::Cmd::Jump {
        node: Some(queued_target),
        ..
    } = queued_command
    else {
        unreachable!()
    };
    assert_eq!(
        ui.logical_node(queued_target),
        Some("app/sensors/key:12/node:1")
    );
    let replacement = ui.create_node(spec::NodeType::View as u8);
    assert_eq!(ui.logical_node(replacement), None);
    ui.register_logical_node(card, "stale".into());
    assert_eq!(ui.logical_node(card), Some("app/sensors/key:12/node:0"));
}

#[cfg(feature = "harness")]
#[test]
fn logical_remount_keeps_retired_and_live_targets_distinguishable() {
    fn mount(ui: &mut Ui) -> NodeId {
        ui.with_logical_child("app/sensors/key:12", |ui| {
            let node = ui.create_node(spec::NodeType::View as u8);
            ui.insert_before(NodeId::ROOT, node, NodeId::NONE);
            ui.register_logical_template(node, "Sensor/node:0");
            node
        })
    }

    let mut ui = Ui::new();
    let retired = mount(&mut ui);
    let logical = ui.logical_node(retired).unwrap().to_owned();
    let queued = microts::Cmd::Jump {
        node: Some(retired),
        prop: spec::prop::WIDTH,
        value: 24.0,
    };
    ui.destroy_node(retired);
    let live = mount(&mut ui);

    assert_ne!(retired, live);
    assert_eq!(ui.logical_node(retired), Some(logical.as_str()));
    assert_eq!(ui.logical_node(live), Some(logical.as_str()));
    assert!(!ui.core().node_exists(retired.0));
    assert!(ui.core().node_exists(live.0));
    let microts::Cmd::Jump { node: Some(target), .. } = queued else { unreachable!() };
    assert_eq!(ui.logical_node(target), ui.logical_node(live));
    assert_ne!(ui.core().node_exists(target.0), ui.core().node_exists(live.0));
    assert_eq!(ui.logical_scope(), "");
}
