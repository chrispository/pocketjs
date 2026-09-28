use alloc::{
    collections::{BTreeMap, BTreeSet},
    string::String,
    vec::Vec,
};
use pocketjs_core::{
    Ui as CoreUi,
    spec::{Display, btn},
};

#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub i32);

impl NodeId {
    pub const NONE: Self = Self(0);
    pub const ROOT: Self = Self(pocketjs_core::spec::ROOT_ID);
    pub const fn is_none(self) -> bool {
        self.0 == 0
    }
}

#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StyleId(pub i32);

impl StyleId {
    pub const NONE: Self = Self(pocketjs_core::spec::STYLE_ID_NONE);
}

impl Default for StyleId {
    fn default() -> Self {
        Self::NONE
    }
}

/// A hardware-neutral input sample. `target` is a resolved press node.
/// `motion` is the fused estimate the host's motion driver published since the
/// previous frame; `None` means no new estimate.
#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub buttons: u32,
    pub pressed: u32,
    pub released: u32,
    pub target: NodeId,
    pub axis_deltas: [i32; 2],
    pub motion: Option<crate::motion::MotionState>,
}

impl Input {
    pub fn buttons(buttons: u32) -> Self {
        Self {
            buttons,
            ..Self::default()
        }
    }
    pub fn press(target: NodeId) -> Self {
        Self {
            target,
            buttons: btn::CIRCLE,
            pressed: btn::CIRCLE,
            ..Self::default()
        }
    }
    pub fn is_press(&self, node: NodeId) -> bool {
        node != NodeId::NONE && self.target == node
    }
    pub fn axis_delta(&self, axis: u8) -> i32 {
        self.axis_deltas.get(axis as usize).copied().unwrap_or(0)
    }
    pub fn with_axis(mut self, axis: u8, delta: i32) -> Self {
        let value = self
            .axis_deltas
            .get_mut(axis as usize)
            .expect("unknown relative axis");
        *value = value.saturating_add(delta);
        self
    }
    pub fn with_motion(mut self, state: crate::motion::MotionState) -> Self {
        self.motion = Some(state);
        self
    }
    /// Whether this frame carries `value` (a `spec::motion` id) at `min_quality` or better.
    pub fn has_motion(&self, value: u8, min_quality: u8) -> bool {
        self.motion.is_some_and(|state| {
            let quality = state.quality(value);
            quality != crate::spec::motion::quality::UNAVAILABLE && quality >= min_quality
        })
    }
    /// `value` as a handler receives it; not present when `has_motion` is false.
    pub fn motion_sample(&self, value: u8, min_quality: u8) -> crate::motion::MotionSample {
        self.motion
            .map(|state| state.sample(value, min_quality))
            .unwrap_or_default()
    }
    pub fn has_activity(&self) -> bool {
        self.buttons != 0
            || self.pressed != 0
            || self.released != 0
            || self.target != NodeId::NONE
            || self.axis_deltas.iter().any(|delta| *delta != 0)
            || self.motion.is_some()
    }
}

/// Calls made by a generated view. Totals accumulate until reset.
#[cfg(feature = "counters")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UiCounters {
    pub set_style: u64,
    pub set_prop: u64,
    pub set_text: u64,
    pub nodes_created: u64,
    /// Includes descendants removed by a subtree destruction.
    pub nodes_destroyed: u64,
    pub update_at: u64,
    pub memo_evaluations: u64,
    pub memo_writes: u64,
}

/// Typed direct calls into `pocketjs_core::Ui`; no op stream or mirror tree.
pub struct Ui {
    core: CoreUi,
    focusable: BTreeSet<NodeId>,
    images: BTreeMap<String, i32>,
    debug_names: BTreeMap<NodeId, String>,
    previous_buttons: u32,
    active: NodeId,
    model_frame: u64,
    model_ticks: u64,
    model_deliveries: Vec<crate::model::Delivery>,
    model_services: Vec<String>,
    model_animations: BTreeMap<i32, crate::RequestId>,
    model_logs: Vec<String>,
    /// Allocated only by generated native specialization setup. Candidates wait
    /// for the first update to write all initial dimensions before registration.
    specialization_pending: Option<Vec<NodeId>>,
    specialization_layout_pending: Option<Vec<(NodeId, &'static crate::specialization::BakedRegionLayout)>>,
    specialization_draw_pending: Option<Vec<(NodeId, &'static pocketjs_core::draw::StaticDrawPlan)>>,
    #[cfg(feature = "counters")]
    counters: UiCounters,
    /// Harness-only history includes retired generations so queued commands
    /// can be normalized after their target subtree has been destroyed.
    #[cfg(feature = "harness")]
    logical_nodes: BTreeMap<NodeId, String>,
    #[cfg(feature = "harness")]
    logical_scope: String,
}

impl Default for Ui {
    fn default() -> Self {
        Self::new()
    }
}

impl Ui {
    pub fn new() -> Self {
        Self::from_core(CoreUi::new())
    }
    pub fn from_core(core: CoreUi) -> Self {
        Self {
            core,
            focusable: BTreeSet::new(),
            images: BTreeMap::new(),
            debug_names: BTreeMap::new(),
            previous_buttons: 0,
            active: NodeId::NONE,
            model_frame: 0,
            model_ticks: 0,
            model_deliveries: Vec::new(),
            model_services: Vec::new(),
            model_animations: BTreeMap::new(),
            model_logs: Vec::new(),
            specialization_pending: None,
            specialization_layout_pending: None,
            specialization_draw_pending: None,
            #[cfg(feature = "counters")]
            counters: UiCounters::default(),
            #[cfg(feature = "harness")]
            logical_nodes: BTreeMap::new(),
            #[cfg(feature = "harness")]
            logical_scope: String::new(),
        }
    }
    pub fn core(&self) -> &CoreUi {
        &self.core
    }
    pub fn core_mut(&mut self) -> &mut CoreUi {
        &mut self.core
    }
    pub fn into_core(self) -> CoreUi {
        self.core
    }
    #[cfg(feature = "counters")]
    pub fn counters(&self) -> UiCounters {
        self.counters
    }

    /// Reset generated-view and core work totals, preserving live-state gauges.
    #[cfg(feature = "counters")]
    pub fn reset_counters(&mut self) {
        self.counters = UiCounters::default();
        self.core.reset_counters();
    }

    /// Generated code records each entered update_at method.
    #[inline(always)]
    pub fn record_update_at(&mut self) {
        #[cfg(feature = "counters")]
        { self.counters.update_at = self.counters.update_at.saturating_add(1); }
    }

    #[inline(always)]
    pub fn record_memo_evaluation(&mut self) {
        #[cfg(feature = "counters")]
        { self.counters.memo_evaluations = self.counters.memo_evaluations.saturating_add(1); }
    }

    #[inline(always)]
    pub fn record_memo_write(&mut self) {
        #[cfg(feature = "counters")]
        { self.counters.memo_writes = self.counters.memo_writes.saturating_add(1); }
    }

    #[cfg(feature = "harness")]
    pub fn logical_scope(&self) -> &str {
        &self.logical_scope
    }

    /// Re-enter a group's mount context when a later update mounts a branch.
    #[cfg(feature = "harness")]
    pub fn with_logical_scope<T>(&mut self, scope: &str, run: impl FnOnce(&mut Self) -> T) -> T {
        let previous = core::mem::replace(&mut self.logical_scope, scope.into());
        let result = run(self);
        self.logical_scope = previous;
        result
    }

    /// Length-prefix segments so row keys containing path delimiters stay distinct.
    #[cfg(feature = "harness")]
    pub fn with_logical_child<T>(&mut self, segment: &str, run: impl FnOnce(&mut Self) -> T) -> T {
        let scope = alloc::format!("{}{length}:{segment}", self.logical_scope, length = segment.len());
        self.with_logical_scope(&scope, run)
    }

    #[cfg(feature = "harness")]
    pub fn register_logical_template(&mut self, node: NodeId, template: &str) {
        let identity = alloc::format!("{}{length}:{template}", self.logical_scope, length = template.len());
        self.register_logical_node(node, identity);
    }

    /// Identity is supplied by generated component paths, row keys, and node indices.
    #[cfg(feature = "harness")]
    pub fn register_logical_node(&mut self, node: NodeId, identity: String) {
        if self.core.node_exists(node.0) {
            self.logical_nodes.insert(node, identity);
        }
    }

    #[cfg(feature = "harness")]
    pub fn logical_node(&self, node: NodeId) -> Option<&str> {
        if node == NodeId::NONE { return Some("$none"); }
        if node == NodeId::ROOT { return Some("$root"); }
        self.logical_nodes.get(&node).map(String::as_str)
    }

    pub fn set_layout_region(&mut self, node: NodeId, enabled: bool) -> bool {
        self.core.set_layout_region(node.0, enabled)
    }

    /// The host calls generated `prepare_specialization` before loading assets.
    pub fn prepare_specialization(&mut self) {
        self.core.enable_font_identity();
        if self.specialization_pending.is_none() {
            self.specialization_pending = Some(Vec::new());
            self.specialization_layout_pending = Some(Vec::new());
            self.specialization_draw_pending = Some(Vec::new());
        }
    }

    /// A compiler-proven candidate, including nodes first mounted in later frames.
    pub fn queue_layout_region(&mut self, node: NodeId) {
        if let Some(pending) = &mut self.specialization_pending {
            pending.push(node);
        }
    }

    pub fn queue_baked_region_layout(&mut self, node: NodeId, plan: &'static crate::specialization::BakedRegionLayout) {
        if crate::specialization::baking_target_matches(plan.target) {
            if let Some(pending) = &mut self.specialization_layout_pending {
                pending.push((node, plan));
            }
        }
    }

    /// Prefill only after the generated environment contract has passed.
    pub fn install_baked_text_sizes(&mut self, target: &str, sizes: &[crate::specialization::BakedTextSize], budget: usize) {
        if !crate::specialization::baking_target_matches(target) || sizes.is_empty() { return; }
        self.core.set_shaped_size_cache_budget(budget);
        for size in sizes {
            let revision = self.core.font_atlas_revision(size.slot);
            self.core.cache_shaped_size(size.slot, revision, size.text, size.tracking, size.line_height, size.size);
        }
    }

    /// Build-time core words remain pending until initial property writes and
    /// layout-region registration have completed.
    pub fn queue_static_draw_plan(&mut self, node: NodeId, plan: &'static pocketjs_core::draw::StaticDrawPlan) {
        if let Some(pending) = &mut self.specialization_draw_pending {
            pending.push((node, plan));
        }
    }

    /// Called after initial values and lifecycle effects, before layout is solved.
    pub fn activate_specialization_regions(&mut self) {
        if let Some(pending) = &mut self.specialization_pending {
            for node in pending.drain(..) {
                if self.core.node_exists(node.0) {
                    self.core.set_layout_region(node.0, true);
                }
            }
        }
        if let Some(pending) = &mut self.specialization_layout_pending {
            for (root, plan) in pending.drain(..) {
                if !self.core.node_exists(root.0) { continue; }
                let mut ids = Vec::new();
                let mut stack = alloc::vec![(root.0, -1i32)];
                let mut complete = true;
                while let Some((node, parent)) = stack.pop() {
                    let index = ids.len();
                    let Some(expected) = plan.nodes.get(index) else { complete = false; break; };
                    if expected.parent != parent { complete = false; break; }
                    ids.push((node, expected.rect));
                    for child in self.core.node_children(node).iter().rev() {
                        stack.push((*child, index as i32));
                    }
                }
                if complete && ids.len() == plan.nodes.len() {
                    self.core.set_region_layout(root.0, plan.guard, &ids);
                }
            }
        }
        if let Some(pending) = &mut self.specialization_draw_pending {
            for (node, plan) in pending.drain(..) {
                if self.core.node_exists(node.0) {
                    self.core.set_region_draw_plan(node.0, plan);
                }
            }
        }
    }

    /// Deoptimization is permanent for this mounted generated app.
    pub fn disable_specialization_regions(&mut self) {
        self.specialization_pending = None;
        self.specialization_layout_pending = None;
        self.specialization_draw_pending = None;
        self.core.disable_layout_regions();
        self.core.set_shaped_size_cache_budget(0);
    }

    pub fn create_node(&mut self, kind: u8) -> NodeId {
        let node = NodeId(self.core.create_node(kind));
        #[cfg(feature = "counters")]
        if self.core.node_exists(node.0) {
            self.counters.nodes_created = self.counters.nodes_created.saturating_add(1);
        }
        node
    }
    pub fn insert_before(&mut self, parent: NodeId, child: NodeId, anchor: NodeId) {
        self.core.insert_before(parent.0, child.0, anchor.0);
    }
    pub fn remove_child(&mut self, parent: NodeId, child: NodeId) {
        if self.core.node_parent(child.0) == parent.0 {
            self.repair_focus(child);
        }
        self.core.remove_child(parent.0, child.0);
    }
    pub fn destroy_node(&mut self, node: NodeId) {
        if node == NodeId::ROOT || node.0 == self.core.auxiliary_surface_root() {
            return;
        }
        #[cfg(feature = "counters")]
        if self.core.node_exists(node.0) {
            let mut current = node;
            while current != NodeId::NONE && self.is_within(current, node) {
                self.counters.nodes_destroyed = self.counters.nodes_destroyed.saturating_add(1);
                current = self.next_node(current);
            }
        }
        self.repair_focus(node);
        self.core.destroy_node(node.0);
        self.focusable.retain(|id| self.core.node_exists(id.0));
        self.debug_names.retain(|id, _| self.core.node_exists(id.0));
        if !self.core.node_exists(self.active.0) {
            self.active = NodeId::NONE;
        }
    }
    pub fn set_style(&mut self, node: NodeId, style: StyleId) {
        #[cfg(feature = "counters")]
        { self.counters.set_style = self.counters.set_style.saturating_add(1); }
        self.core.set_style(node.0, style.0);
    }
    pub fn set_prop(&mut self, node: NodeId, prop: u8, value: f64) {
        #[cfg(feature = "counters")]
        { self.counters.set_prop = self.counters.set_prop.saturating_add(1); }
        self.core.set_prop(node.0, prop, value);
    }
    pub fn set_text(&mut self, node: NodeId, text: &str) {
        #[cfg(feature = "counters")]
        { self.counters.set_text = self.counters.set_text.saturating_add(1); }
        self.core.set_text(node.0, text);
    }
    pub fn set_focus(&mut self, node: NodeId) {
        if self.active != node {
            self.core.set_active(self.active.0, false);
            self.active = NodeId::NONE;
        }
        self.core.set_focus(node.0);
    }
    pub fn focused(&self) -> NodeId {
        NodeId(self.core.focused())
    }
    pub fn set_focusable(&mut self, node: NodeId, enabled: bool) {
        if enabled && self.core.node_exists(node.0) {
            self.focusable.insert(node);
        } else {
            self.focusable.remove(&node);
        }
        if !enabled && self.focused() == node {
            self.set_focus(NodeId::NONE);
        }
    }
    pub fn set_debug_name(&mut self, node: NodeId, name: &str) {
        self.debug_names.insert(node, name.into());
    }
    pub fn debug_name(&self, node: NodeId) -> Option<&str> {
        self.debug_names.get(&node).map(String::as_str)
    }
    pub fn register_image(&mut self, name: &str, texture: i32) {
        self.images.insert(name.into(), texture);
    }
    pub fn set_image_asset(&mut self, node: NodeId, name: &str) {
        self.core
            .set_image(node.0, self.images.get(name).copied().unwrap_or(-1));
    }
    pub fn set_image(&mut self, node: NodeId, texture: i32) {
        self.core.set_image(node.0, texture);
    }
    pub fn load_styles(&mut self, bytes: &[u8]) -> bool {
        self.core.load_styles(bytes)
    }
    pub fn tick(&mut self) {
        self.core.tick();
        self.model_ticks = self.model_ticks.checked_add(1).expect("model clock exhausted");
    }

    /// Queue a typed service completion for the next model frame boundary.
    pub fn queue_model_delivery(&mut self, delivery: crate::model::Delivery) {
        self.model_deliveries.push(delivery);
    }
    /// Declare service modules implemented by the embedding host's command handler.
    pub fn set_model_services(&mut self, services: impl IntoIterator<Item = String>) {
        self.model_services = services.into_iter().collect();
        self.model_services.sort();
        self.model_services.dedup();
    }
    pub fn model_initial_ready(&self) -> crate::Ready {
        crate::Ready { frame: self.model_frame, now_ms: self.model_ticks as f64 / self.core.tick_rate() as f64 * 1000.0, services: self.model_services.clone(), ..crate::Ready::default() }
    }
    pub fn model_ready(&mut self) -> crate::Ready {
        use crate::model::{AnimationResult, Completion, Delivery};
        use pocketjs_core::anim::CompletionReason;
        let animations = &mut self.model_animations;
        let deliveries = &mut self.model_deliveries;
        self.core.drain_animation_completions(|completion| {
            if let Some(request) = animations.remove(&completion.id) {
                let result = match completion.reason {
                    CompletionReason::Ended => AnimationResult::Ended,
                    CompletionReason::Replaced => AnimationResult::Replaced,
                    CompletionReason::Dropped => AnimationResult::Dropped,
                };
                deliveries.push(Delivery { request, result: Completion::Animation(result) });
            }
        });
        self.model_frame = self.model_frame.checked_add(1).expect("model frame identity exhausted");
        crate::Ready { frame: self.model_frame, now_ms: self.model_ticks as f64 / self.core.tick_rate() as f64 * 1000.0, deliveries: core::mem::take(&mut self.model_deliveries), services: self.model_services.clone() }
    }
    pub fn model_command(&mut self, command: crate::Cmd) {
        use crate::model::{AnimationResult, Cmd, Completion, Delivery, Value};
        match command {
            Cmd::Animate { node, prop, to, dur, easing, delay, request } => {
                let id = node.map(|node| self.core.animate(node.0, prop, to as f64, dur, easing, delay)).unwrap_or(-1);
                if let Some(request) = request {
                    if id > 0 { self.model_animations.insert(id, request); }
                    else { self.model_deliveries.push(Delivery { request, result: Completion::Animation(AnimationResult::Dropped) }); }
                }
            }
            Cmd::Jump { node, prop, value } => if let Some(node) = node { self.core.set_prop(node.0, prop, value as f64); },
            Cmd::Request { request, .. } => self.model_deliveries.push(Delivery {
                request, result: Completion::Value(Value::Object(alloc::vec![(String::from("kind"), Value::String(String::from("unavailable")))])),
            }),
            Cmd::Cancel { request } => {
                let animation = self.model_animations.iter().find_map(|(id, pending)| (*pending == request).then_some(*id));
                // Cancelling a wait drops its listener, not the motion already submitted.
                if let Some(id) = animation { self.model_animations.remove(&id); }
                self.model_deliveries.retain(|delivery| delivery.request != request);
            }
            Cmd::Log(message) => { if cfg!(debug_assertions) { self.model_logs.push(message); } }
        }
    }
    /// Development log messages delivered by model commands, consumed by the embedding host.
    pub fn drain_model_logs(&mut self) -> impl Iterator<Item = String> + '_ { self.model_logs.drain(..) }


    fn next_node(&self, node: NodeId) -> NodeId {
        if let Some(&child) = self.core.node_children(node.0).first() {
            return NodeId(child);
        }
        let mut current = node;
        loop {
            let parent = self.core.node_parent(current.0);
            if parent == 0 {
                return NodeId::NONE;
            }
            let children = self.core.node_children(parent);
            if let Some(index) = children.iter().position(|&child| child == current.0) {
                if let Some(&next) = children.get(index + 1) {
                    return NodeId(next);
                }
            }
            current = NodeId(parent);
        }
    }

    fn is_within(&self, node: NodeId, ancestor: NodeId) -> bool {
        let mut current = node;
        while current != NodeId::NONE {
            if current == ancestor {
                return true;
            }
            current = NodeId(self.core.node_parent(current.0));
        }
        false
    }

    fn first_focusable(&self, root: NodeId) -> NodeId {
        let mut current = root;
        while current != NodeId::NONE && self.is_within(current, root) {
            if self.focusable.contains(&current) && self.visible(current) {
                return current;
            }
            current = self.next_node(current);
        }
        NodeId::NONE
    }

    fn repair_focus(&mut self, removed: NodeId) {
        if !self.is_within(self.focused(), removed) {
            return;
        }
        let parent = self.core.node_parent(removed.0);
        let siblings = self.core.node_children(parent);
        let mut target = NodeId::NONE;
        if let Some(index) = siblings.iter().position(|&node| node == removed.0) {
            for &sibling in siblings[index + 1..]
                .iter()
                .chain(siblings[..index].iter().rev())
            {
                target = self.first_focusable(NodeId(sibling));
                if target != NodeId::NONE {
                    break;
                }
            }
        }
        if target == NodeId::NONE {
            let mut ancestor = NodeId(parent);
            while ancestor != NodeId::NONE {
                if self.focusable.contains(&ancestor) && self.visible(ancestor) {
                    target = ancestor;
                    break;
                }
                ancestor = NodeId(self.core.node_parent(ancestor.0));
            }
        }
        self.set_focus(target);
    }

    fn visible(&self, node: NodeId) -> bool {
        let mut current = node;
        while current != NodeId::NONE {
            if self
                .core
                .resolved_style(current.0)
                .is_none_or(|style| style.display == Display::None as u8)
            {
                return false;
            }
            if current == NodeId::ROOT {
                return true;
            }
            current = NodeId(self.core.node_parent(current.0));
        }
        false
    }

    fn move_focus(&mut self, forward: bool) {
        let focused = self.focused();
        let mut current = NodeId::ROOT;
        let mut first = NodeId::NONE;
        let mut previous = NodeId::NONE;
        let mut next = NodeId::NONE;
        let mut before_focus = NodeId::NONE;
        let mut found = false;
        while current != NodeId::NONE {
            if self.focusable.contains(&current) && self.visible(current) {
                if first == NodeId::NONE {
                    first = current;
                }
                if found && next == NodeId::NONE {
                    next = current;
                }
                if current == focused {
                    before_focus = previous;
                    found = true;
                }
                previous = current;
            }
            current = self.next_node(current);
        }
        let target = if !found {
            if forward { first } else { previous }
        } else if forward {
            if next == NodeId::NONE { focused } else { next }
        } else if before_focus == NodeId::NONE {
            focused
        } else {
            before_focus
        };
        self.set_focus(target);
    }

    /// Resolve edges and focus against core's current document order.
    /// Calling this with an unchanged input does not evaluate view bindings.
    pub fn resolve_input(&mut self, input: &Input) -> Input {
        let pressed = input.pressed | (input.buttons & !self.previous_buttons);
        let released = input.released | (self.previous_buttons & !input.buttons);
        self.previous_buttons = input.buttons;
        if released & btn::CIRCLE != 0 {
            self.core.set_active(self.active.0, false);
            self.active = NodeId::NONE;
        }
        for (button, forward) in [
            (btn::DOWN, true),
            (btn::RIGHT, true),
            (btn::UP, false),
            (btn::LEFT, false),
        ] {
            if pressed & button != 0 {
                self.move_focus(forward);
            }
        }
        let mut target = input.target;
        if target == NodeId::NONE && pressed & btn::CIRCLE != 0 {
            target = self.focused();
        }
        if target != NodeId::NONE && (!self.focusable.contains(&target) || !self.visible(target)) {
            target = NodeId::NONE;
        }
        if target != NodeId::NONE {
            self.core.set_active(self.active.0, false);
            self.active = target;
            self.core.set_active(target.0, true);
        }
        Input {
            target,
            pressed,
            released,
            buttons: input.buttons,
            axis_deltas: input.axis_deltas,
            motion: input.motion,
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    use crate::motion::{MotionState, MotionVector};
    use crate::spec::motion::{self, quality};

    #[test]
    fn motion_state_survives_resolution_and_gates_on_quality() {
        let state = MotionState {
            timestamp: 1_000,
            gravity_direction: MotionVector { value: [0.0, -1.0, 0.0], quality: quality::MEDIUM },
            ..MotionState::default()
        };
        let input = Input::default().with_motion(state);
        assert!(input.has_activity() && !Input::default().has_activity());
        assert!(input.has_motion(motion::GRAVITY_DIRECTION, quality::MEDIUM));
        assert!(!input.has_motion(motion::GRAVITY_DIRECTION, quality::HIGH));
        assert!(!input.has_motion(motion::ROTATION_RATE, quality::UNRELIABLE));
        let resolved = Ui::new().resolve_input(&input);
        let sample = resolved.motion_sample(motion::GRAVITY_DIRECTION, quality::LOW);
        assert_eq!((sample.component(1), sample.quality(), sample.timestamp()), (-1.0, quality::MEDIUM, 1_000));
        assert!(!Input::default().motion_sample(motion::GRAVITY_DIRECTION, quality::LOW).is_present());
    }
}

#[cfg(test)]
mod model_tests {
    use super::*;
    use crate::{Cmd, RequestId, TaskId};
    use crate::model::{AnimationResult, Completion};
    fn request(wait: u32) -> RequestId { RequestId { task: TaskId { region: 1, function: 1, call: 1 }, wait, member: 0 } }
    fn animate(ui: &mut Ui, node: Option<NodeId>, wait: u32) {
        ui.model_command(Cmd::Animate { node, prop: pocketjs_core::spec::prop::WIDTH, to: 50.0, dur: 1, easing: 0, delay: 0, request: Some(request(wait)) });
    }
    #[test]
    fn animation_deliveries_retain_request_identity_and_completion_reason() {
        let mut ui = Ui::new();
        let node = ui.create_node(pocketjs_core::spec::NodeType::View as u8);
        ui.set_prop(node, pocketjs_core::spec::prop::WIDTH, 10.0);
        animate(&mut ui, Some(node), 1);
        ui.tick();
        assert_eq!(ui.model_ready().delivery(request(1)), Some(&Completion::Animation(AnimationResult::Ended)));
        animate(&mut ui, Some(node), 2);
        animate(&mut ui, Some(node), 3);
        assert_eq!(ui.model_ready().delivery(request(2)), Some(&Completion::Animation(AnimationResult::Replaced)));
        ui.destroy_node(node);
        assert_eq!(ui.model_ready().delivery(request(3)), Some(&Completion::Animation(AnimationResult::Dropped)));
        animate(&mut ui, None, 4);
        assert_eq!(ui.model_ready().delivery(request(4)), Some(&Completion::Animation(AnimationResult::Dropped)));
        assert!(ui.model_ready().deliveries.is_empty());
    }
    #[test]
    fn cancellation_detaches_the_wait_while_animation_keeps_running() {
        let mut ui = Ui::new();
        let node = ui.create_node(pocketjs_core::spec::NodeType::View as u8);
        ui.set_prop(node, pocketjs_core::spec::prop::WIDTH, 10.0);
        ui.model_command(Cmd::Animate { node: Some(node), prop: pocketjs_core::spec::prop::WIDTH, to: 50.0, dur: 1000, easing: 0, delay: 0, request: Some(request(1)) });
        for _ in 0..6 { ui.tick(); }
        let before_cancel = ui.core().resolved_style(node.0).unwrap().width;
        assert!(before_cancel > 10.0 && before_cancel < 50.0);
        assert!(ui.model_ready().deliveries.is_empty());
        ui.model_command(Cmd::Cancel { request: request(1) });
        for _ in 0..6 { ui.tick(); }
        assert!(ui.core().resolved_style(node.0).unwrap().width > before_cancel);
        for _ in 0..60 {
            ui.tick();
            assert!(ui.model_ready().deliveries.is_empty());
        }
        assert_eq!(ui.core().resolved_style(node.0).unwrap().width, 50.0);
    }
    #[test]
    fn model_time_uses_the_host_simulation_rate() {
        let mut ui = Ui::new();
        ui.core_mut().set_tick_rate(50);
        let first = ui.model_ready();
        ui.tick();
        let second = ui.model_ready();
        assert_eq!(second.frame, first.frame + 1);
        assert_eq!(second.now_ms - first.now_ms, 20.0);
    }
    #[test]
    fn model_time_has_no_accumulated_fractional_tick_drift() {
        let mut ui = Ui::new();
        for _ in 0..60 { ui.tick(); }
        assert_eq!(ui.model_ready().now_ms, 1000.0);
    }
    #[test]
    fn property_writes_replace_only_the_matching_live_track() {
        let mut ui = Ui::new();
        let node = ui.create_node(pocketjs_core::spec::NodeType::View as u8);
        ui.set_prop(node, pocketjs_core::spec::prop::WIDTH, 10.0);
        animate(&mut ui, Some(node), 1);
        ui.model_command(Cmd::Jump { node: Some(node), prop: pocketjs_core::spec::prop::WIDTH, value: 20.0 });
        animate(&mut ui, Some(node), 2);
        let ready = ui.model_ready();
        assert_eq!(ready.delivery(request(1)), Some(&Completion::Animation(AnimationResult::Replaced)));
        assert_eq!(ready.delivery(request(2)), None);
        ui.tick();
        let ready = ui.model_ready();
        assert_eq!(ready.delivery(request(1)), None);
        assert_eq!(ready.delivery(request(2)), Some(&Completion::Animation(AnimationResult::Ended)));
    }
    #[test]
    fn readiness_owns_one_boundarys_deliveries_and_declared_capabilities() {
        use crate::model::{Delivery, Value};
        let mut ui = Ui::new();
        ui.set_model_services([String::from("net"), String::from("net")]);
        ui.queue_model_delivery(Delivery { request: request(1), result: Completion::Value(Value::I32(3)) });
        let first = ui.model_ready();
        ui.queue_model_delivery(Delivery { request: request(2), result: Completion::Value(Value::I32(4)) });
        assert_eq!(first.services, alloc::vec![String::from("net")]);
        assert_eq!(first.deliveries.len(), 1);
        assert!(first.delivery(request(2)).is_none());
        assert_eq!(ui.model_ready().delivery(request(2)), Some(&Completion::Value(Value::I32(4))));
        assert!(ui.model_ready().deliveries.is_empty());
    }
}
