//! Opt-in work counters. Totals accumulate until reset; node and cache sizes
//! describe the current state. Reading or resetting counters never changes
//! layout, drawing, or a damage tracker's committed baseline.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutCounters {
    /// Fresh Taffy trees, including the initial solve and validation resets.
    pub structure_rebuilds: u64,
    /// Reconciliations of retained layout topology after structural changes.
    pub structure_syncs: u64,
    /// Calls to Taffy's root layout computation after changed inputs.
    pub layout_passes: u64,
    /// Leaf measurement callbacks requested by Taffy during those calls.
    pub measure_callbacks: u64,
    /// Nodes passed to taffy's incremental set_style path.
    pub style_updates: u64,
    pub shaping_calls: u64,
    pub shaping_cache_hits: u64,
    pub shaping_cache_bytes: u64,
    pub taffy_nodes_created: u64,
    /// Live nodes in the built taffy trees; retained across reset.
    pub taffy_nodes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrawCounters {
    /// Includes a repeated build when a stale text provider requires repaint.
    pub builds: u64,
    pub ops: u64,
    pub words: u64,
    /// Words emitted by paint, excluding words copied from region caches.
    pub generated_words: u64,
    pub static_plan_hits: u64,
    pub region_cache_hits: u64,
    pub region_cache_bytes: u64,
    /// Live allocated bytes of the current DrawSegment Vec and every retained
    /// per-region cache's segment Vec (capacity * size_of::<DrawSegment>()).
    /// Includes spare capacity; excludes Vec headers, region maps/stacks,
    /// allocator bookkeeping, words, and external DamageTracker snapshots.
    /// Sampled when Ui::counters() is read, so eviction is visible immediately.
    pub segment_table_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CoreCounters {
    pub layout: LayoutCounters,
    pub draw: DrawCounters,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DamageCounters {
    pub decoded_ops: u64,
    /// Successful prepare calls, including calls whose plan is not committed.
    pub prepares: u64,
    /// Logical pixel area of successful plans, before host policy promotion.
    pub area: u64,
    pub full_redraws: u64,
}

impl DamageCounters {
    pub(crate) const ZERO: Self = Self {
        decoded_ops: 0,
        prepares: 0,
        area: 0,
        full_redraws: 0,
    };
}

impl LayoutCounters {
    pub(crate) fn add_work(&mut self, other: Self) {
        self.structure_rebuilds = self
            .structure_rebuilds
            .saturating_add(other.structure_rebuilds);
        self.structure_syncs = self.structure_syncs.saturating_add(other.structure_syncs);
        self.layout_passes = self.layout_passes.saturating_add(other.layout_passes);
        self.measure_callbacks = self.measure_callbacks.saturating_add(other.measure_callbacks);
        self.style_updates = self.style_updates.saturating_add(other.style_updates);
        self.shaping_calls = self.shaping_calls.saturating_add(other.shaping_calls);
        self.shaping_cache_hits = self.shaping_cache_hits.saturating_add(other.shaping_cache_hits);
        self.taffy_nodes_created = self
            .taffy_nodes_created
            .saturating_add(other.taffy_nodes_created);
    }
    pub(crate) fn add(&mut self, other: Self) {
        self.add_work(other);
        self.taffy_nodes = self.taffy_nodes.saturating_add(other.taffy_nodes);
    }
}
