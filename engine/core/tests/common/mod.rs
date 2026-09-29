//! Node and asset builders shared by the core integration tests.
#![allow(dead_code)]

use pocketjs_core::{spec, Ui};

/// Background of every `view`; static draw plans in the tests repeat it.
pub const FILL: u32 = 0xff22_3344;

/// A version-3 atlas for slot 0 that maps 'a' and 'b' to 5x8 cells with a
/// 9 px line height. Every other codepoint is a glyph miss.
pub fn atlas(advance: u8, coverage: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    // cell 5x8, baseline 6, line height 9, slot 0, flags 0, density 1
    bytes.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    for (gid, cp) in [b'a', b'b'].into_iter().enumerate() {
        bytes.extend_from_slice(&(cp as u32).to_le_bytes());
        bytes.extend_from_slice(&(gid as u16).to_le_bytes());
        bytes.extend_from_slice(&[advance, 0]);
    }
    bytes.extend_from_slice(&[coverage; 2 * 5 * 8]);
    bytes
}

/// A PFS1 config that switches slot 0 to streamed glyphs with two cache entries.
pub fn stream_config() -> Vec<u8> {
    let mut bytes = Vec::from(*b"PFS1");
    bytes.extend_from_slice(&1u32.to_le_bytes()); // generation
    bytes.extend_from_slice(&[0, 5, 8, 6, 9, 5, 1, 0, 2, 0, 0, 0]);
    bytes
}

pub fn set(ui: &mut Ui, id: i32, props: &[(u8, f64)]) {
    for &(prop, value) in props {
        ui.set_prop(id, prop, value);
    }
}

/// A column View filled with `FILL`, inserted as the first child of `parent`.
pub fn view(ui: &mut Ui, parent: i32, width: Option<f64>, height: Option<f64>) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    set(ui, id, &[(spec::prop::FLEX_DIR, spec::FlexDir::Col as u8 as f64), (spec::prop::BG_COLOR, FILL as f64)]);
    if let Some(width) = width {
        ui.set_prop(id, spec::prop::WIDTH, width);
    }
    if let Some(height) = height {
        ui.set_prop(id, spec::prop::HEIGHT, height);
    }
    ui.insert_before(parent, id, 0);
    id
}

/// A fixed-size View with `shrink: 0`, the shape a layout region requires.
pub fn fixed(ui: &mut Ui, parent: i32, width: f64, height: f64) -> i32 {
    let id = view(ui, parent, Some(width), Some(height));
    ui.set_prop(id, spec::prop::SHRINK, 0.0);
    id
}

pub fn text(ui: &mut Ui, parent: i32, run: &str) -> i32 {
    let id = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(id, run);
    ui.insert_before(parent, id, 0);
    id
}

pub fn row(ui: &mut Ui, id: i32) {
    ui.set_prop(id, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
}
