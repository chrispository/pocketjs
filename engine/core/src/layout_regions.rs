//! Opt-in independent taffy trees for proven fixed-size subtrees.
//!
//! The ordinary layout engine is used unchanged while the table is absent.
//! A boundary is a leaf in its parent's solver and a root in its own solver.
//! Handles live in per-solver maps, never in the shared Node::taffy field.

use alloc::{collections::BTreeMap, vec::Vec};
use taffy::{AvailableSpace, Dimension, LengthPercentageAuto, Position, Size};

use crate::{
    layout::{self, LayoutEngine, MeasureCtx},
    spec,
    style::{self, StyleTable},
    text::Fonts,
    tree::{LayoutRect, Tree},
};

/// Parent-solver conditions under which a compiled layout table is valid.
/// Values are the unrounded f32 dimensions and cumulative layout origin,
/// before draw transforms. The first rollout accepts integer origins only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RegionLayoutGuard {
    pub unrounded_size: (f32, f32),
    pub unrounded_origin: (f32, f32),
}

impl RegionLayoutGuard {
    fn valid(self) -> bool {
        let (w, h) = self.unrounded_size;
        let (x, y) = self.unrounded_origin;
        w.is_finite()
            && h.is_finite()
            && w >= 0.0
            && h >= 0.0
            && x.is_finite()
            && y.is_finite()
            && x == layout::floorf(x)
            && y == layout::floorf(y)
    }
    fn matches(self, placement: Placement) -> bool {
        self.unrounded_size.0.to_bits() == placement.size.0.to_bits()
            && self.unrounded_size.1.to_bits() == placement.size.1.to_bits()
            && self.unrounded_origin.0.to_bits() == placement.origin.0.to_bits()
            && self.unrounded_origin.1.to_bits() == placement.origin.1.to_bits()
    }
}

struct BakedLayout {
    guard: RegionLayoutGuard,
    rects: Vec<(i32, LayoutRect)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    size: (f32, f32),
    /// Cumulative *unrounded* parent output, used by taffy's edge rounding.
    origin: (f32, f32),
    visible: bool,
}

struct Solver {
    root: i32,
    engine: LayoutEngine,
    handles: BTreeMap<i32, taffy::NodeId>,
    wrapper: Option<taffy::NodeId>,
    placement: Option<Placement>,
    hidden: bool,
    pending_bake: Option<BakedLayout>,
    bake_consumed: bool,
}

impl Solver {
    fn new(root: i32) -> Self {
        Self {
            root,
            engine: LayoutEngine::new(),
            handles: BTreeMap::new(),
            wrapper: None,
            placement: None,
            hidden: false,
            pending_bake: None,
            bake_consumed: false,
        }
    }
}

pub(crate) struct LayoutRegions {
    primary: Solver,
    regions: Vec<Solver>,
    #[cfg(feature = "counters")]
    retired: crate::counters::LayoutCounters,
}

/// The parent resolves flex-basis along its main axis, not the region's axis.
pub(crate) fn isolated(tree: &Tree, styles: &StyleTable, id: i32) -> bool {
    let Some(node) = tree.get(id) else {
        return false;
    };
    if node.node_type == spec::NodeType::Text as u8 || id == spec::ROOT_ID {
        return false;
    }
    let r = style::resolve(node, styles, true);
    let fixed = |value: f32| value.is_finite() && value >= 0.0;
    let lower = |bound: f32, size: f32| bound.is_nan() || fixed(bound) && bound <= size;
    let upper = |bound: f32, size: f32| bound.is_nan() || fixed(bound) && bound >= size;
    let parent_column = tree.get(node.parent).is_some_and(|parent| {
        style::resolve(parent, styles, true).flex_dir == spec::FlexDir::Col as u8
    });
    fixed(r.width)
        && fixed(r.height)
        && r.grow == 0.0
        && r.shrink == 0.0
        && (r.basis.is_nan() || r.basis == if parent_column { r.height } else { r.width })
        && lower(r.min_w, r.width)
        && lower(r.min_h, r.height)
        && upper(r.max_w, r.width)
        && upper(r.max_h, r.height)
}

impl LayoutRegions {
    pub(crate) fn new() -> Self {
        Self {
            primary: Solver::new(spec::ROOT_ID),
            regions: Vec::new(),
            #[cfg(feature = "counters")]
            retired: Default::default(),
        }
    }
    pub(crate) fn contains(&self, id: i32) -> bool {
        self.regions.iter().any(|region| region.root == id)
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.regions.is_empty()
    }
    pub(crate) fn guard(&self, root: i32) -> Option<RegionLayoutGuard> {
        let placement = self
            .regions
            .iter()
            .find(|region| region.root == root)?
            .placement?;
        Some(RegionLayoutGuard {
            unrounded_size: placement.size,
            unrounded_origin: placement.origin,
        })
    }

    pub(crate) fn set_baked(
        &mut self,
        tree: &Tree,
        styles: &StyleTable,
        root: i32,
        guard: RegionLayoutGuard,
        rects: &[(i32, LayoutRect)],
    ) -> bool {
        if !guard.valid() || !visible(tree, styles, root) {
            return false;
        }
        let Some(index) = self.regions.iter().position(|region| region.root == root) else {
            return false;
        };
        let region = &self.regions[index];
        if region.engine.built || region.bake_consumed || region.pending_bake.is_some() {
            return false;
        }
        let mut slots = Vec::new();
        tree.collect_subtree(root, &mut slots);
        if slots.len() != rects.len() || rects.is_empty() {
            return false;
        }
        let mut remaining: alloc::collections::BTreeSet<_> = slots
            .into_iter()
            .map(|slot| tree.slots[slot as usize].id(slot))
            .collect();
        for &(id, rect) in rects {
            if !remaining.remove(&id)
                || id != root && self.contains(id)
                || !rect.x.is_finite()
                || !rect.y.is_finite()
                || !rect.w.is_finite()
                || !rect.h.is_finite()
                || rect.w < 0.0
                || rect.h < 0.0
            {
                return false;
            }
        }
        self.regions[index].pending_bake = Some(BakedLayout {
            guard,
            rects: rects.to_vec(),
        });
        self.regions[index].engine.dirty = true;
        true
    }

    pub(crate) fn roots(&self) -> impl Iterator<Item = i32> + '_ {
        self.regions.iter().map(|region| region.root)
    }
    pub(crate) fn insert(&mut self, id: i32) {
        if !self.contains(id) {
            self.regions.push(Solver::new(id));
            self.mark_all();
        }
    }
    pub(crate) fn remove(&mut self, id: i32) {
        if let Some(index) = self.regions.iter().position(|region| region.root == id) {
            let removed = self.regions.remove(index);
            #[cfg(feature = "counters")]
            self.retired.add_work(removed.engine.counters);
            #[cfg(not(feature = "counters"))]
            drop(removed);
            self.mark_all();
        }
    }
    pub(crate) fn remove_destroyed(&mut self, tree: &Tree) {
        let removed: Vec<_> = self
            .regions
            .iter()
            .filter(|region| tree.resolve(region.root).is_none())
            .map(|region| region.root)
            .collect();
        for id in removed {
            let index = self
                .regions
                .iter()
                .position(|region| region.root == id)
                .unwrap();
            let removed = self.regions.remove(index);
            #[cfg(feature = "counters")]
            self.retired.add_work(removed.engine.counters);
            #[cfg(not(feature = "counters"))]
            drop(removed);
        }
    }
    pub(crate) fn mark_all(&mut self) {
        self.primary.engine.dirty = true;
        for region in &mut self.regions {
            region.pending_bake = None;
            region.engine.dirty = true;
        }
    }
    fn owner(&self, tree: &Tree, mut id: i32) -> Option<usize> {
        while id != 0 {
            if let Some(index) = self.regions.iter().position(|region| region.root == id) {
                return Some(index);
            }
            id = tree.get(id).map_or(0, |node| node.parent);
        }
        None
    }
    pub(crate) fn mark_structure(&mut self, tree: &Tree, parent: i32) {
        // Detached construction has no layout yet; insertion dirties its owner.
        if !tree.is_in_subtree(spec::ROOT_ID, parent) {
            return;
        }
        match self.owner(tree, parent) {
            Some(index) => {
                self.regions[index].pending_bake = None;
                self.regions[index].engine.dirty = true;
            }
            None => self.primary.engine.dirty = true,
        }
    }
    pub(crate) fn mark_style(&mut self, tree: &Tree, slot: u32) {
        let node = &tree.slots[slot as usize];
        let id = node.id(slot);
        if !tree.is_in_subtree(spec::ROOT_ID, id) {
            return;
        }
        match self.owner(tree, id) {
            Some(index) => {
                self.regions[index].pending_bake = None;
                self.regions[index].engine.mark_style(slot);
                if self.regions[index].root == id {
                    // The boundary's own style belongs to both solvers: its
                    // external flex placement and its internal child layout.
                    match self.owner(tree, node.parent) {
                        Some(parent) => self.regions[parent].engine.mark_style(slot),
                        None => self.primary.engine.mark_style(slot),
                    }
                }
            }
            None => self.primary.engine.mark_style(slot),
        }
    }
    pub(crate) fn needs(&self) -> bool {
        self.primary.engine.needs() || self.regions.iter().any(|region| region.engine.needs())
    }
    pub(crate) fn valid(&self, tree: &Tree, styles: &StyleTable, fonts: &Fonts) -> bool {
        !fonts.native_active()
            && self.regions.iter().all(|region| {
                tree.is_in_subtree(spec::ROOT_ID, region.root)
                    && isolated(tree, styles, region.root)
            })
    }
    pub(crate) fn relayout(
        &mut self,
        tree: &mut Tree,
        styles: &StyleTable,
        fonts: &Fonts,
        viewport: (f32, f32),
    ) {
        let boundaries: Vec<_> = self.regions.iter().map(|region| region.root).collect();
        self.primary.engine.viewport = viewport;
        let placements = solve(&mut self.primary, tree, styles, fonts, &boundaries, None);
        self.update_placements(placements);
        // Parents publish a child's raw dimensions before the child runs.
        let mut order: Vec<_> = self
            .regions
            .iter()
            .map(|region| {
                let mut depth = 0;
                let mut id = region.root;
                while let Some(node) = tree.get(id) {
                    depth += 1;
                    id = node.parent;
                }
                (depth, region.root)
            })
            .collect();
        order.sort_unstable();
        for (_, id) in order {
            let index = self
                .regions
                .iter()
                .position(|region| region.root == id)
                .unwrap();
            let Some(placement) = self.regions[index].placement else {
                continue;
            };
            if !placement.visible || !visible(tree, styles, id) {
                clear_descendants(tree, id);
                tree.get_mut(id).unwrap().layout = LayoutRect::default();
                self.regions[index].hidden = true;
                continue;
            }
            if self.regions[index].hidden {
                self.regions[index].hidden = false;
                self.regions[index]
                    .engine
                    .mark_style((id as u32) & spec::ID_SLOT_MASK);
            }
            let placements = solve(
                &mut self.regions[index],
                tree,
                styles,
                fonts,
                &boundaries,
                Some(placement),
            );
            self.update_placements(placements);
        }
    }
    fn update_placements(&mut self, placements: Vec<(i32, Placement)>) {
        for (id, placement) in placements {
            if let Some(region) = self.regions.iter_mut().find(|region| region.root == id) {
                if region.placement != Some(placement) {
                    region.placement = Some(placement);
                    if let Some(slot) = region.handles.get(&id).copied() {
                        let _ = region.engine.taffy.mark_dirty(slot);
                    }
                    // Restyle the root and wrapper without reshaping descendants.
                    region.engine.mark_style((id as u32) & spec::ID_SLOT_MASK);
                }
            }
        }
    }
    #[cfg(feature = "counters")]
    pub(crate) fn counters(&self) -> crate::counters::LayoutCounters {
        let mut counts = self.retired;
        counts.add(self.primary.engine.counters);
        for region in &self.regions {
            counts.add(region.engine.counters);
        }
        counts
    }
    #[cfg(feature = "counters")]
    pub(crate) fn reset_counters(&mut self) {
        self.retired = Default::default();
        for solver in core::iter::once(&mut self.primary).chain(self.regions.iter_mut()) {
            solver.engine.counters = crate::counters::LayoutCounters {
                taffy_nodes: solver.engine.counters.taffy_nodes,
                ..Default::default()
            };
        }
    }
}

fn clear_descendants(tree: &mut Tree, root: i32) {
    let mut slots = Vec::new();
    tree.collect_subtree(root, &mut slots);
    for slot in slots {
        if tree.slots[slot as usize].id(slot) != root {
            tree.slots[slot as usize].layout = LayoutRect::default();
        }
    }
}

fn root_style(r: &style::Resolved, placement: Placement) -> taffy::Style {
    let mut result = layout::to_taffy(r);
    // Parent layout already applied all external size constraints. An absolute
    // child of the wrapper passes these two axes as known dimensions to taffy.
    result.size = Size {
        width: Dimension::length(placement.size.0),
        height: Dimension::length(placement.size.1),
    };
    result.min_size = Size {
        width: Dimension::auto(),
        height: Dimension::auto(),
    };
    result.max_size = Size {
        width: Dimension::auto(),
        height: Dimension::auto(),
    };
    result.position = Position::Absolute;
    result.margin = taffy::Rect::zero();
    result.inset = taffy::Rect {
        left: LengthPercentageAuto::length(placement.origin.0),
        top: LengthPercentageAuto::length(placement.origin.1),
        right: LengthPercentageAuto::auto(),
        bottom: LengthPercentageAuto::auto(),
    };
    result.flex_basis = Dimension::auto();
    result.flex_grow = 0.0;
    result.flex_shrink = 0.0;
    result
}

fn wrapper_style(placement: Placement) -> taffy::Style {
    taffy::Style {
        size: Size {
            width: Dimension::length(placement.size.0),
            height: Dimension::length(placement.size.1),
        },
        ..Default::default()
    }
}

fn inherited_transform(tree: &Tree, styles: &StyleTable, root: i32) -> bool {
    let mut id = tree.get(root).map_or(0, |node| node.parent);
    while let Some(node) = tree.get(id) {
        if style::resolve(node, styles, true).declares_transform() {
            return true;
        }
        id = node.parent;
    }
    false
}

fn visible(tree: &Tree, styles: &StyleTable, mut id: i32) -> bool {
    while let Some(node) = tree.get(id) {
        if style::resolve(node, styles, true).display == spec::Display::None as u8 {
            return false;
        }
        id = node.parent;
    }
    true
}

fn shape(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    slot: u32,
    in_transform: bool,
) -> Option<MeasureCtx> {
    let mut run = alloc::string::String::new();
    tree.collect_run(slot, &mut run);
    if run.is_empty() {
        tree.slots[slot as usize].text_native = false;
        return None;
    }
    let r = style::resolve(&tree.slots[slot as usize], styles, true);
    let native = fonts.native_active() && r.tracking == 0.0 && !in_transform;
    tree.slots[slot as usize].text_native = native;
    Some(MeasureCtx::shaped(
        fonts,
        run,
        r.font_slot as u8,
        r.tracking,
        r.line_height,
        native,
    ))
}

fn build(
    solver: &mut Solver,
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    boundaries: &[i32],
    id: i32,
    in_transform: bool,
    placement: Option<Placement>,
) -> Option<taffy::NodeId> {
    let slot = tree.resolve(id)?;
    let r = style::resolve(&tree.slots[slot as usize], styles, true);
    let in_transform = in_transform || r.declares_transform();
    let style = if id == solver.root {
        placement.map_or_else(|| layout::to_taffy(&r), |p| root_style(&r, p))
    } else {
        layout::to_taffy(&r)
    };
    let boundary = id != solver.root && boundaries.contains(&id);
    let handle = if boundary {
        solver.engine.taffy.new_leaf(style).ok()?
    } else if tree.slots[slot as usize].node_type == spec::NodeType::Text as u8 {
        clear_descendants(tree, id);
        let Some(context) = shape(tree, styles, fonts, slot, in_transform) else {
            tree.slots[slot as usize].layout = LayoutRect::default();
            return None;
        };
        #[cfg(feature = "counters")]
        context.count(&mut solver.engine.counters);
        solver
            .engine
            .taffy
            .new_leaf_with_context(style, context)
            .ok()?
    } else {
        let children = tree.slots[slot as usize].children.clone();
        let mut handles = Vec::with_capacity(children.len());
        for child in children {
            if let Some(handle) = build(
                solver,
                tree,
                styles,
                fonts,
                boundaries,
                child,
                in_transform,
                None,
            ) {
                handles.push(handle);
            }
        }
        solver
            .engine
            .taffy
            .new_with_children(style, &handles)
            .ok()?
    };
    solver.handles.insert(id, handle);
    #[cfg(feature = "counters")]
    {
        solver.engine.counters.taffy_nodes_created =
            solver.engine.counters.taffy_nodes_created.saturating_add(1);
        solver.engine.counters.taffy_nodes += 1;
    }
    Some(handle)
}

fn solve(
    solver: &mut Solver,
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    boundaries: &[i32],
    placement: Option<Placement>,
) -> Vec<(i32, Placement)> {
    if !solver.engine.needs() {
        return Vec::new();
    }
    if let Some(bake) = solver.pending_bake.take() {
        solver.bake_consumed = true;
        let matches = placement.is_some_and(|placement| bake.guard.matches(placement))
            && bake
                .rects
                .iter()
                .find(|(id, _)| *id == solver.root)
                .is_some_and(|(_, rect)| {
                    let live = tree.get(solver.root).unwrap().layout;
                    rect.w.to_bits() == live.w.to_bits() && rect.h.to_bits() == live.h.to_bits()
                });
        if matches {
            for (id, rect) in bake.rects {
                let node = tree.get_mut(id).unwrap();
                if id != solver.root {
                    node.layout = rect;
                }
                node.text_native = false;
            }
            solver.engine.dirty = false;
            solver.engine.style_dirty.clear();
            // Keep built=false: any later invalidation constructs a live tree.
            return Vec::new();
        }
    }
    if solver.engine.dirty || !solver.engine.built {
        solver.engine.taffy.clear();
        solver.handles.clear();
        solver.wrapper = None;
        #[cfg(feature = "counters")]
        {
            solver.engine.counters.structure_rebuilds =
                solver.engine.counters.structure_rebuilds.saturating_add(1);
            solver.engine.counters.taffy_nodes = 0;
        }
        let transformed = inherited_transform(tree, styles, solver.root);
        let Some(root) = build(
            solver,
            tree,
            styles,
            fonts,
            boundaries,
            solver.root,
            transformed,
            placement,
        ) else {
            return Vec::new();
        };
        solver.engine.root = Some(root);
        if let Some(placement) = placement {
            solver.wrapper = solver
                .engine
                .taffy
                .new_with_children(wrapper_style(placement), &[root])
                .ok();
            #[cfg(feature = "counters")]
            {
                solver.engine.counters.taffy_nodes_created =
                    solver.engine.counters.taffy_nodes_created.saturating_add(1);
                solver.engine.counters.taffy_nodes += 1;
            }
        }
        solver.engine.built = true;
    } else {
        solver.engine.style_dirty.sort_unstable();
        solver.engine.style_dirty.dedup();
        let dirty = core::mem::take(&mut solver.engine.style_dirty);
        for slot in dirty {
            let Some(node) = tree.slots.get(slot as usize).filter(|node| node.alive) else {
                continue;
            };
            let id = node.id(slot);
            let Some(&handle) = solver.handles.get(&id) else {
                continue;
            };
            let r = style::resolve(node, styles, true);
            if node.node_type == spec::NodeType::Text as u8 {
                let in_transform = inherited_transform(tree, styles, id) || r.declares_transform();
                if let Some(context) = shape(tree, styles, fonts, slot, in_transform) {
                    #[cfg(feature = "counters")]
                    context.count(&mut solver.engine.counters);
                    let _ = solver.engine.taffy.set_node_context(handle, Some(context));
                }
            }
            let style = if id == solver.root {
                placement.map_or_else(|| layout::to_taffy(&r), |p| root_style(&r, p))
            } else {
                layout::to_taffy(&r)
            };
            let _ = solver.engine.taffy.set_style(handle, style);
            #[cfg(feature = "counters")]
            {
                solver.engine.counters.style_updates =
                    solver.engine.counters.style_updates.saturating_add(1);
            }
        }
        if let (Some(wrapper), Some(placement)) = (solver.wrapper, placement) {
            let _ = solver
                .engine
                .taffy
                .set_style(wrapper, wrapper_style(placement));
        }
    }
    solver.engine.style_dirty.clear();
    solver.engine.dirty = false;
    let viewport = placement.map_or(solver.engine.viewport, |p| p.size);
    let root = solver.wrapper.or(solver.engine.root).unwrap();
    #[cfg(feature = "counters")]
    { solver.engine.counters.layout_passes = solver.engine.counters.layout_passes.saturating_add(1); }
    let _ = solver.engine.taffy.compute_layout_with_measure(
        root,
        Size {
            width: AvailableSpace::Definite(viewport.0),
            height: AvailableSpace::Definite(viewport.1),
        },
        |known, _, _, context, _| {
            #[cfg(feature = "counters")]
            { solver.engine.counters.measure_callbacks = solver.engine.counters.measure_callbacks.saturating_add(1); }
            let size = context.map_or((0.0, 0.0), |context| context.size);
            Size {
                width: known.width.unwrap_or(size.0),
                height: known.height.unwrap_or(size.1),
            }
        },
    );
    let mut placements = Vec::new();
    readback(
        solver,
        tree,
        styles,
        boundaries,
        solver.root,
        (0.0, 0.0),
        placement.is_some(),
        &mut placements,
    );
    placements
}

fn readback(
    solver: &Solver,
    tree: &mut Tree,
    styles: &StyleTable,
    boundaries: &[i32],
    id: i32,
    parent_origin: (f32, f32),
    preserve_root: bool,
    placements: &mut Vec<(i32, Placement)>,
) {
    let Some(&handle) = solver.handles.get(&id) else {
        return;
    };
    let unrounded = solver.engine.taffy.unrounded_layout(handle);
    let origin = (
        parent_origin.0 + unrounded.location.x,
        parent_origin.1 + unrounded.location.y,
    );
    if !(preserve_root && id == solver.root) {
        let result = solver.engine.taffy.layout(handle).unwrap();
        tree.get_mut(id).unwrap().layout = LayoutRect {
            x: layout::roundf(result.location.x),
            y: layout::roundf(result.location.y),
            w: layout::roundf(result.size.width),
            h: layout::roundf(result.size.height),
        };
    }
    if id != solver.root && boundaries.contains(&id) {
        placements.push((
            id,
            Placement {
                size: (unrounded.size.width, unrounded.size.height),
                origin,
                visible: visible(tree, styles, id),
            },
        ));
        return;
    }
    let children = tree.get(id).unwrap().children.clone();
    for child in children {
        readback(
            solver,
            tree,
            styles,
            boundaries,
            child,
            origin,
            preserve_root,
            placements,
        );
    }
}
