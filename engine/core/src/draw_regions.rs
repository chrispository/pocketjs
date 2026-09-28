//! Opt-in bounded region storage. No per-node fields are added to the arena.
use super::{Affine, Clip};
use crate::{
    damage::DamageRect,
    resources::{DrawSegment, FontView, RenderResources},
    spec,
    text::Fonts,
    tree::Tree,
    TexView,
};
use alloc::{collections::BTreeMap, vec::Vec};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Key {
    pub world: [u32; 6],
    pub clip: [u32; 4],
    pub opacity: u32,
    pub geometry: [u32; 2],
    pub screen: [u32; 2],
    pub transformed: bool,
    pub fonts: [u64; spec::MAX_FONT_SLOTS],
    pub frame: u64,
}
impl Key {
    pub fn new(
        world: Affine,
        clip: Clip,
        opacity: f32,
        size: (f32, f32),
        screen: (f32, f32),
        transformed: bool,
        fonts: &[u64; spec::MAX_FONT_SLOTS],
    ) -> Self {
        Self {
            world: [
                world.a.to_bits(),
                world.b.to_bits(),
                world.c.to_bits(),
                world.d.to_bits(),
                world.tx.to_bits(),
                world.ty.to_bits(),
            ],
            clip: [
                clip.x0.to_bits(),
                clip.y0.to_bits(),
                clip.x1.to_bits(),
                clip.y1.to_bits(),
            ],
            opacity: opacity.to_bits(),
            geometry: [size.0.to_bits(), size.1.to_bits()],
            screen: [screen.0.to_bits(), screen.1.to_bits()],
            transformed,
            fonts: *fonts,
            frame: 0,
        }
    }
}
pub(super) struct Cached {
    pub key: Key,
    pub revision: u64,
    pub words: Vec<u32>,
    pub segments: Vec<DrawSegment>,
}
pub(super) struct Entry {
    pub revision: u64,
    pub cached: Option<Cached>,
    pub touched: u64,
    pub sprites: bool,
    pub static_plan: Option<&'static super::StaticDrawPlan>,
}
pub(super) struct Regions {
    pub entries: BTreeMap<i32, Entry>,
    pub segments: Vec<DrawSegment>,
    pub stack: Vec<u64>,
    pub budget: usize,
    pub clock: u64,
    pub reused_words: usize,
}
impl Regions {
    pub fn new(budget: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            segments: Vec::new(),
            stack: Vec::new(),
            budget,
            clock: 0,
            reused_words: 0,
        }
    }
    pub fn set_region(&mut self, id: i32, enabled: bool) {
        if enabled {
            self.entries.entry(id).or_insert(Entry {
                revision: 1,
                cached: None,
                touched: 0,
                sprites: false,
                static_plan: None,
            });
        } else {
            self.entries.remove(&id);
        }
    }
    pub fn invalidate_node(&mut self, tree: &Tree, id: i32) {
        self.invalidate(tree, id, false, None);
    }
    pub fn invalidate_patch(&mut self, tree: &Tree, id: i32, prop: Option<u8>) {
        self.invalidate(tree, id, true, prop);
    }
    fn invalidate(&mut self, tree: &Tree, id: i32, allow_patch: bool, prop: Option<u8>) {
        for (&root, entry) in &mut self.entries {
            if related(tree, root, id) || related(tree, id, root) {
                entry.revision = entry.revision.wrapping_add(1);
                // The changed revision rejects reuse; keep allocations for the
                // next paint so frequent text/color updates do not churn them.
                let preserve = allow_patch
                    && root == id
                    && entry.static_plan.is_some_and(|plan| {
                        !plan.patches.is_empty()
                            && prop.is_none_or(|prop| {
                                plan.patches.iter().any(|patch| patch.prop == prop)
                            })
                    });
                if !preserve {
                    entry.static_plan = None;
                }
            }
        }
    }
    pub fn invalidate_all(&mut self) {
        for entry in self.entries.values_mut() {
            entry.revision = entry.revision.wrapping_add(1);
            entry.static_plan = None;
        }
    }
    pub fn begin(&mut self, tree: &Tree) {
        self.entries.retain(|id, _| tree.resolve(*id).is_some());
        self.segments.clear();
        self.stack.clear();
        self.reused_words = 0;
        self.clock = self.clock.wrapping_add(1);
    }
    pub fn bytes(&self) -> usize {
        self.entries
            .values()
            .filter_map(|entry| entry.cached.as_ref())
            .map(|cached| cached.words.capacity() * 4)
            .sum()
    }
    pub fn trim(&mut self) {
        while self.bytes() > self.budget {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, e)| e.cached.is_some())
                .min_by_key(|(_, e)| e.touched)
                .map(|(&id, _)| id);
            if let Some(oldest) = oldest {
                self.entries.get_mut(&oldest).unwrap().cached = None;
            } else {
                break;
            }
        }
    }
}
pub(super) fn static_matches(plan: &super::StaticDrawPlan, key: &Key) -> bool {
    !key.transformed
        && key.world
            == [
                1f32.to_bits(),
                0,
                0,
                1f32.to_bits(),
                plan.origin[0].to_bits(),
                plan.origin[1].to_bits(),
            ]
        && key.geometry == plan.size.map(f32::to_bits)
        && key.clip == plan.clip.map(f32::to_bits)
        && key.opacity == plan.opacity.to_bits()
        && key.screen == plan.viewport.map(f32::to_bits)
}
pub(super) fn valid_static_plan(plan: &super::StaticDrawPlan) -> bool {
    if !plan.patches.is_empty()
        && (plan.patches.len() != 1
            || plan.words.len() != 4
            || plan.words.first() != Some(&spec::draw_op::RECT)
            || plan.opacity != 1.0
            || plan.patches[0].word != 3
            || plan.patches[0].prop != spec::prop::BG_COLOR
            || plan.patches[0].candidates.is_empty()
            || plan.patches[0]
                .candidates
                .iter()
                .any(|color| color >> 24 == 0))
    {
        return false;
    }
    if plan
        .origin
        .iter()
        .any(|value| !value.is_finite() || *value != *value as i32 as f32)
        || plan
            .size
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        || plan.clip.iter().any(|value| !value.is_finite())
        || plan
            .viewport
            .iter()
            .any(|value| !value.is_finite() || *value < 1.0)
        || !plan.opacity.is_finite()
        || !(0.0..=1.0).contains(&plan.opacity)
        || plan.bounds.is_empty()
    {
        return false;
    }
    let mut index = 0;
    let mut coordinates = plan.coordinates.iter();
    let mut depth = 0usize;
    while index < plan.words.len() {
        let (length, points): (usize, &[usize]) = match plan.words[index] {
            spec::draw_op::RECT => (4, &[1]),
            spec::draw_op::GRAD_RECT => (6, &[1]),
            spec::draw_op::SCISSOR => {
                depth += 1;
                (3, &[1])
            }
            spec::draw_op::SCISSOR_POP => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
                (1, &[])
            }
            spec::draw_op::GLYPH_RUN => {
                let Some(header) = plan.words.get(index + 1) else {
                    return false;
                };
                let length = 3 + 2 * (header >> 16) as usize;
                if index + length > plan.words.len() {
                    return false;
                }
                for offset in (3..length).step_by(2) {
                    if coordinates.next().copied() != Some((index + offset) as u32) {
                        return false;
                    }
                }
                (length, &[])
            }
            _ => return false,
        };
        if index + length > plan.words.len() {
            return false;
        }
        for offset in points {
            if coordinates.next().copied() != Some((index + offset) as u32) {
                return false;
            }
        }
        index += length;
    }
    coordinates.next().is_none() && depth == 0
}
fn related(tree: &Tree, ancestor: i32, mut id: i32) -> bool {
    while let Some(slot) = tree.resolve(id) {
        if ancestor == id {
            return true;
        }
        id = tree.slots[slot as usize].parent;
    }
    false
}
pub(super) fn has_sprites(tree: &Tree, slot: u32) -> bool {
    let node = &tree.slots[slot as usize];
    node.sprite_frames > 0
        || node.children.iter().any(|id| {
            tree.resolve(*id)
                .is_some_and(|slot| has_sprites(tree, slot))
        })
}
pub(super) fn rect(clip: Clip) -> DamageRect {
    DamageRect::new(
        super::floorf(clip.x0) as i32,
        super::floorf(clip.y0) as i32,
        -super::floorf(-clip.x1) as i32,
        -super::floorf(-clip.y1) as i32,
    )
}
pub(super) struct BoundsResources<'a> {
    pub fonts: &'a Fonts,
    pub screen: (f32, f32),
}
impl RenderResources for BoundsResources<'_> {
    fn viewport(&self) -> (f32, f32) {
        self.screen
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        self.fonts.atlas(slot).map(|atlas| FontView {
            bitmap: &atlas.bitmap,
            cell_w: atlas.cell_w,
            cell_h: atlas.cell_h,
            raster_density: atlas.raster_density,
            glyph_count: atlas.glyph_count,
        })
    }
}
