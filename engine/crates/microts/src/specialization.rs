//! Native-only immutable seeds emitted by the wasm baking pass.

pub struct BakedLayoutNode {
    /// Parent's depth-first table index; -1 denotes the region root.
    pub parent: i32,
    pub rect: pocketjs_core::tree::LayoutRect,
}

pub struct BakedRegionLayout {
    pub target: &'static str,
    pub guard: pocketjs_core::RegionLayoutGuard,
    pub nodes: &'static [BakedLayoutNode],
}

pub struct BakedTextSize {
    pub slot: u8,
    pub text: &'static str,
    pub tracking: f32,
    pub line_height: f32,
    pub size: (f32, f32),
}

/// No device target inherits a host target's floating-point golden.
pub fn baking_target_matches(target: &str) -> bool {
    target == "aarch64-apple-darwin-std"
        && cfg!(feature = "std")
        && cfg!(all(target_arch = "aarch64", target_os = "macos", target_env = ""))
}
