//! Borrowed raster resources. Renderers need these views, not the retained
//! tree or the Rust layout of `Ui`. C adapters can implement this contract.
use crate::{TexView, Ui};
use crate::damage::DamageRect;

/// One contiguous, scissor-balanced region in the current DrawList.
///
/// Providers keep identities stable across frames, change `revision` when any
/// region input changes, and include nested changes in the outer revision.
/// Entries occur in paint order, with parents before children. Bounds include
/// every painted pixel; `clip` is the inherited clip at the start of the slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawSegment {
    pub id: u64,
    pub parent: Option<u64>,
    pub word_start: usize,
    pub word_end: usize,
    pub bounds: DamageRect,
    pub clip: DamageRect,
    pub revision: u64,
    /// Proven root color-patch pixels; two patch frames compare this rectangle
    /// without decoding their static instructions.
    pub patch_bounds: Option<DamageRect>,
    /// The six f32 bit patterns of the world affine transform.
    pub placement: [u32; 6],
    pub order: u32,
}

#[derive(Clone, Copy)]
pub struct FontView<'a> {
    pub bitmap: &'a [u8],
    pub cell_w: u32,
    pub cell_h: u32,
    pub raster_density: u8,
    pub glyph_count: u16,
}

impl FontView<'_> {
    pub fn coverage_width(&self) -> u32 {
        self.cell_w * self.raster_density as u32
    }
    pub fn coverage_height(&self) -> u32 {
        self.cell_h * self.raster_density as u32
    }
    pub fn bytes_per_row(&self) -> usize {
        self.coverage_width() as usize
    }
    pub fn glyph_rows(&self, gid: u16) -> &[u8] {
        let size = self.coverage_height() as usize * self.bytes_per_row();
        let start = gid as usize * size;
        &self.bitmap[start..start + size]
    }
}

pub trait RenderResources {
    fn viewport(&self) -> (f32, f32);
    fn raster_revision(&self) -> u64;
    fn texture(&self, handle: i32) -> Option<TexView<'_>>;
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>>;
    /// Optional native specialization metadata for the current DrawList.
    /// The default preserves the operation-by-operation damage contract.
    fn draw_segments(&self) -> &[DrawSegment] {
        &[]
    }
}

impl RenderResources for Ui {
    fn viewport(&self) -> (f32, f32) {
        Ui::viewport(self)
    }
    fn raster_revision(&self) -> u64 {
        Ui::raster_revision(self)
    }
    fn draw_segments(&self) -> &[DrawSegment] {
        Ui::draw_segments(self)
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        Ui::texture(self, handle)
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        Ui::font_atlas(self, slot).map(|atlas| FontView {
            bitmap: &atlas.bitmap,
            cell_w: atlas.cell_w,
            cell_h: atlas.cell_h,
            raster_density: atlas.raster_density,
            glyph_count: atlas.glyph_count,
        })
    }
}
