//! `Ui` call counters and harness logical identities.
use microts::pocketjs_core::spec::{self, prop::*};
#[cfg(feature = "harness")]
use microts::Cmd;
use microts::{NodeId, StyleId, Ui};

fn node(ui: &mut Ui, kind: spec::NodeType, parent: NodeId) -> NodeId {
    let id = ui.create_node(kind as u8);
    ui.insert_before(parent, id, NodeId::NONE);
    id
}

#[cfg(feature = "harness")]
fn jump_target(command: &Cmd) -> NodeId {
    let Cmd::Jump { node: Some(target), .. } = command else { unreachable!() };
    *target
}

#[test]
fn counters_record_ui_calls_without_changing_output() {
    let mut ui = Ui::new();
    let card = node(&mut ui, spec::NodeType::View, NodeId::ROOT);
    let label = node(&mut ui, spec::NodeType::Text, card);
    ui.set_style(card, StyleId::NONE);
    ui.set_prop(card, WIDTH, 20.0);
    ui.set_prop(card, HEIGHT, 10.0);
    ui.set_prop(card, BG_COLOR, 0xff12_3456u32 as f64);
    ui.set_text(label, "label");
    ui.record_update_at();
    ui.record_memo_evaluation();
    ui.record_memo_evaluation();
    ui.record_memo_write();
    assert_eq!(ui.core_mut().draw().words, [spec::draw_op::RECT, 0, 20 | (10 << 16), 0xff12_3456]);
    #[cfg(feature = "counters")]
    {
        let c = ui.counters();
        assert_eq!((c.nodes_created, c.set_style, c.set_prop, c.set_text), (2, 1, 3, 1));
        assert_eq!((c.update_at, c.memo_evaluations, c.memo_writes), (1, 2, 1));
        assert_eq!(ui.core().counters().layout.structure_rebuilds, 1);
    }
    ui.destroy_node(NodeId::ROOT); // the root is never destroyed
    assert!(ui.core().node_exists(card.0));
    ui.destroy_node(card);
    ui.destroy_node(card); // a stale ID destroys nothing
    assert!(!ui.core().node_exists(card.0) && !ui.core().node_exists(label.0));
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
fn destroyed_nodes_keep_their_logical_identity_for_queued_commands() {
    let mut ui = Ui::new();
    let card = node(&mut ui, spec::NodeType::View, NodeId::ROOT);
    let label = node(&mut ui, spec::NodeType::Text, card);
    ui.register_logical_node(card, "list/key:1/node:0".into());
    ui.register_logical_node(label, "list/key:1/node:1".into());
    assert_eq!(ui.logical_node(NodeId::ROOT), Some("$root"));
    assert_eq!(ui.logical_node(NodeId::NONE), Some("$none"));
    let queued = Cmd::Jump { node: Some(label), prop: WIDTH, value: 24.0 };
    ui.destroy_node(card);
    assert_eq!(ui.logical_node(card), Some("list/key:1/node:0"));
    assert_eq!(ui.logical_node(jump_target(&queued)), Some("list/key:1/node:1"));
    let replacement = ui.create_node(spec::NodeType::View as u8);
    assert_eq!(ui.logical_node(replacement), None, "a reused slot starts unregistered");
    ui.register_logical_node(card, "stale".into());
    assert_eq!(ui.logical_node(card), Some("list/key:1/node:0"), "stale IDs cannot be renamed");
}

#[cfg(feature = "harness")]
#[test]
fn a_remounted_node_shares_the_logical_identity_but_not_liveness() {
    fn mount(ui: &mut Ui) -> NodeId {
        ui.with_logical_child("list/key:1", |ui| {
            let id = node(ui, spec::NodeType::View, NodeId::ROOT);
            ui.register_logical_template(id, "Row/node:0");
            id
        })
    }
    let mut ui = Ui::new();
    let retired = mount(&mut ui);
    let logical = ui.logical_node(retired).unwrap().to_owned();
    let queued = Cmd::Jump { node: Some(retired), prop: WIDTH, value: 24.0 };
    ui.destroy_node(retired);
    let live = mount(&mut ui);
    assert_ne!(retired, live);
    assert_eq!(ui.logical_node(retired), Some(logical.as_str()));
    assert_eq!(ui.logical_node(live), Some(logical.as_str()));
    let target = jump_target(&queued);
    assert_eq!(ui.logical_node(target), ui.logical_node(live));
    assert!(!ui.core().node_exists(target.0) && ui.core().node_exists(live.0));
    assert_eq!(ui.logical_scope(), "");
}
