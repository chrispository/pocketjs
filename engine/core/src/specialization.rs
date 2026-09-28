//! Opt-in content identities and environment guards for native specialization.
//! The guest path does not allocate this registry or hash resource bytes.

use alloc::vec::Vec;
use core::fmt;

use crate::{spec, Ui};

/// SHA-256 of the loaded bytes, independent of the runtime revision counter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContentHash(pub [u8; 32]);

impl fmt::Display for ContentHash {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(output, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// SHA-256, with bounded stack storage and no allocation.
pub fn content_hash(bytes: &[u8]) -> ContentHash {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    fn compress(state: &mut [u32; 8], bytes: &[u8]) {
        let mut words = [0u32; 64];
        for (word, chunk) in words.iter_mut().take(16).zip(bytes.chunks_exact(4)) {
            *word = u32::from_be_bytes(chunk.try_into().unwrap());
        }
        for i in 16..64 {
            let x = words[i - 15];
            let y = words[i - 2];
            let a = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
            let b = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(sigma1)
                .wrapping_add(choice)
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let t2 = sigma0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (word, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *word = word.wrapping_add(value);
        }
    }
    let mut state = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut chunks = bytes.chunks_exact(64);
    for chunk in &mut chunks {
        compress(&mut state, chunk);
    }
    let remainder = chunks.remainder();
    let mut tail = [0u8; 128];
    tail[..remainder.len()].copy_from_slice(remainder);
    tail[remainder.len()] = 0x80;
    let end = if remainder.len() < 56 { 64 } else { 128 };
    tail[end - 8..end].copy_from_slice(&(bytes.len() as u64).wrapping_mul(8).to_be_bytes());
    for chunk in tail[..end].chunks_exact(64) {
        compress(&mut state, chunk);
    }
    let mut hash = [0u8; 32];
    for (output, word) in hash.chunks_exact_mut(4).zip(state) {
        output.copy_from_slice(&word.to_be_bytes());
    }
    ContentHash(hash)
}

/// Allocated only after `Ui::enable_font_identity`. Missing entries stay unknown;
/// enabling identity after a load cannot recover the original byte sequence.
#[derive(Default)]
pub struct AssetIdentities {
    fonts: [Option<ContentHash>; spec::MAX_FONT_SLOTS],
    styles: Option<ContentHash>,
}

impl AssetIdentities {
    pub fn record_font(&mut self, slot: u8, bytes: &[u8]) {
        if let Some(entry) = self.fonts.get_mut(slot as usize) {
            *entry = Some(content_hash(bytes));
        }
    }
    pub fn record_styles(&mut self, bytes: &[u8]) {
        self.styles = Some(content_hash(bytes));
    }
    pub fn font(&self, slot: u8) -> Option<ContentHash> {
        self.fonts.get(slot as usize).copied().flatten()
    }
    pub fn styles(&self) -> Option<ContentHash> {
        self.styles
    }
    pub fn invalidate_font(&mut self, slot: u8) {
        if let Some(entry) = self.fonts.get_mut(slot as usize) {
            *entry = None;
        }
    }
    /// A successful atomic asset transaction replaces only its loaded slots.
    pub fn merge_loaded(&mut self, staged: &Self) {
        if staged.styles.is_some() {
            self.styles = staged.styles;
        }
        for (target, source) in self.fonts.iter_mut().zip(staged.fonts) {
            if source.is_some() {
                *target = source;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontIdentity {
    pub slot: u8,
    /// None means the compiler lacks this required atlas's bytes: no proof.
    pub hash: Option<ContentHash>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextProvider {
    Baked,
}

/// Environment facts consumed by generated geometry/drawing specializations.
/// Font revisions do not participate: they invalidate caches, not identities.
#[derive(Clone, Copy, Debug)]
pub struct SpecializationContract<'a> {
    pub viewport: (f32, f32),
    pub tick_hz: u32,
    pub text_provider: TextProvider,
    pub styles: ContentHash,
    pub fonts: &'a [FontIdentity],
}

#[derive(Clone, Debug, PartialEq)]
pub enum SpecializationDiagnostic {
    Viewport {
        expected: (f32, f32),
        actual: (f32, f32),
    },
    TickRate {
        expected: u32,
        actual: u32,
    },
    NativeTextProvider,
    MissingStylesIdentity,
    StylesIdentity {
        expected: ContentHash,
        actual: ContentHash,
    },
    MissingExpectedFontIdentity {
        slot: u8,
    },
    MissingFontIdentity {
        slot: u8,
    },
    FontIdentity {
        slot: u8,
        expected: ContentHash,
        actual: ContentHash,
    },
    StreamedFont {
        slot: u8,
    },
}

impl SpecializationDiagnostic {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Viewport { .. } => "VS201",
            Self::TickRate { .. } => "VS202",
            Self::NativeTextProvider => "VS203",
            Self::MissingStylesIdentity | Self::StylesIdentity { .. } => "VS204",
            Self::MissingExpectedFontIdentity { .. } => "VS205",
            Self::MissingFontIdentity { .. } => "VS206",
            Self::FontIdentity { .. } => "VS207",
            Self::StreamedFont { .. } => "VS208",
        }
    }
}

impl fmt::Display for SpecializationDiagnostic {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{}: ", self.code())?;
        match self {
            Self::Viewport { expected, actual } => {
                write!(output, "viewport {actual:?} differs from {expected:?}")
            }
            Self::TickRate { expected, actual } => {
                write!(output, "tick rate {actual} differs from {expected}")
            }
            Self::NativeTextProvider => write!(
                output,
                "native text measurement requires the generic AOT path"
            ),
            Self::MissingStylesIdentity => {
                write!(output, "styles were loaded without content identity")
            }
            Self::StylesIdentity { expected, actual } => {
                write!(output, "style identity {actual} differs from {expected}")
            }
            Self::MissingExpectedFontIdentity { slot } => write!(
                output,
                "compiler has no content identity for required font slot {slot}"
            ),
            Self::MissingFontIdentity { slot } => write!(
                output,
                "font slot {slot} was not loaded with content identity"
            ),
            Self::FontIdentity {
                slot,
                expected,
                actual,
            } => write!(
                output,
                "font slot {slot} identity {actual} differs from {expected}"
            ),
            Self::StreamedFont { slot } => write!(
                output,
                "font slot {slot} is streamed and cannot satisfy a baked-font contract"
            ),
        }
    }
}

/// A separate diagnostic channel. No application command or Log is emitted.
#[derive(Clone, Debug, PartialEq)]
pub struct SpecializationValidation {
    pub enabled: bool,
    pub diagnostics: Vec<SpecializationDiagnostic>,
}

impl SpecializationContract<'_> {
    fn inspect(&self, ui: &Ui, mut mismatch: impl FnMut(SpecializationDiagnostic)) {
        if self.viewport != ui.viewport() {
            mismatch(SpecializationDiagnostic::Viewport {
                expected: self.viewport,
                actual: ui.viewport(),
            });
        }
        if self.tick_hz != ui.tick_rate() {
            mismatch(SpecializationDiagnostic::TickRate {
                expected: self.tick_hz,
                actual: ui.tick_rate(),
            });
        }
        if self.text_provider == TextProvider::Baked && ui.native_text_active() {
            mismatch(SpecializationDiagnostic::NativeTextProvider);
        }
        match ui.styles_identity() {
            None => mismatch(SpecializationDiagnostic::MissingStylesIdentity),
            Some(actual) if actual != self.styles => {
                mismatch(SpecializationDiagnostic::StylesIdentity {
                    expected: self.styles,
                    actual,
                })
            }
            _ => {}
        }
        for font in self.fonts {
            if ui.font_atlas_is_streamed(font.slot) {
                mismatch(SpecializationDiagnostic::StreamedFont { slot: font.slot });
                continue;
            }
            let Some(expected) = font.hash else {
                mismatch(SpecializationDiagnostic::MissingExpectedFontIdentity { slot: font.slot });
                continue;
            };
            match ui.font_atlas_identity(font.slot) {
                None => mismatch(SpecializationDiagnostic::MissingFontIdentity { slot: font.slot }),
                Some(actual) if actual != expected => {
                    mismatch(SpecializationDiagnostic::FontIdentity {
                        slot: font.slot,
                        expected,
                        actual,
                    })
                }
                _ => {}
            }
        }
    }
    /// Allocation-free guard for a frame boundary after host resource changes.
    pub fn matches(&self, ui: &Ui) -> bool {
        let mut matches = true;
        self.inspect(ui, |_| matches = false);
        matches
    }
    /// Collect all failures without rejecting mount or modifying the core.
    pub fn validate(&self, ui: &Ui) -> SpecializationValidation {
        let mut diagnostics = Vec::new();
        self.inspect(ui, |diagnostic| diagnostics.push(diagnostic));
        SpecializationValidation {
            enabled: diagnostics.is_empty(),
            diagnostics,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{format, vec};

    #[test]
    fn sha256_standard_vectors() {
        assert_eq!(
            format!("{}", content_hash(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            format!("{}", content_hash(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            format!(
                "{}",
                content_hash(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
            ),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            format!("{}", content_hash(&vec![b'a'; 1_000_000])),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    pub(crate) fn atlas(slot: u8, advance: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&[1, 1, 1, 1, slot, 0, 1, 0]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&[advance, 0, 255]);
        bytes
    }

    fn styles() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&spec::style_table::MAGIC.to_le_bytes());
        bytes.extend_from_slice(&spec::style_table::VERSION.to_le_bytes());
        bytes.extend_from_slice(&[0; 6]);
        bytes
    }

    #[test]
    fn opt_in_is_required_before_loading_and_failed_loads_preserve_identity() {
        let font = atlas(0, 1);
        let mut ui = Ui::new();
        assert!(ui.load_font_atlas(&font));
        assert_eq!(ui.font_atlas_identity(0), None);
        ui.enable_font_identity();
        assert_eq!(ui.font_atlas_identity(0), None);
        assert!(ui.load_font_atlas(&font));
        let hash = ui.font_atlas_identity(0);
        assert_eq!(hash, Some(content_hash(&font)));
        ui.enable_font_identity();
        assert_eq!(ui.font_atlas_identity(0), hash);
        assert!(!ui.load_font_atlas(b"bad"));
        assert_eq!(ui.font_atlas_identity(0), hash);
    }

    #[test]
    fn identities_distinguish_bytes_not_revision_numbers() {
        let font = atlas(0, 1);
        let other = atlas(0, 2);
        let style = styles();
        let expected = [FontIdentity {
            slot: 0,
            hash: Some(content_hash(&font)),
        }];
        let contract = SpecializationContract {
            viewport: (480.0, 272.0),
            tick_hz: 60,
            text_provider: TextProvider::Baked,
            styles: content_hash(&style),
            fonts: &expected,
        };
        let mut first = Ui::new();
        first.enable_font_identity();
        assert!(first.load_styles(&style));
        assert!(first.load_font_atlas(&font));
        let mut second = Ui::new();
        second.enable_font_identity();
        assert!(second.load_styles(&style));
        assert!(second.load_font_atlas(&other));
        assert_eq!(first.font_atlas_revision(0), second.font_atlas_revision(0));
        assert!(contract.matches(&first));
        assert!(matches!(
            contract.validate(&second).diagnostics.as_slice(),
            [SpecializationDiagnostic::FontIdentity { slot: 0, .. }]
        ));
        assert!(first.load_font_atlas(&font));
        assert_ne!(first.font_atlas_revision(0), second.font_atlas_revision(0));
        assert!(contract.matches(&first));
        let before = first.viewport();
        first.set_viewport(320.0, 240.0);
        let result = contract.validate(&first);
        assert!(!result.enabled);
        assert!(
            matches!(result.diagnostics.as_slice(), [SpecializationDiagnostic::Viewport { expected, actual }] if *expected == before && *actual == (320.0, 240.0))
        );
    }

    #[test]
    fn native_text_and_missing_identities_use_the_generic_path() {
        let style = styles();
        let expected = [FontIdentity {
            slot: 0,
            hash: Some(content_hash(&atlas(0, 1))),
        }];
        let contract = SpecializationContract {
            viewport: (480.0, 272.0),
            tick_hz: 60,
            text_provider: TextProvider::Baked,
            styles: content_hash(&style),
            fonts: &expected,
        };
        let mut ui = Ui::new();
        assert!(ui.load_styles(&style));
        let result = contract.validate(&ui);
        assert!(!result.enabled);
        assert!(result
            .diagnostics
            .contains(&SpecializationDiagnostic::MissingStylesIdentity));
        assert!(result
            .diagnostics
            .contains(&SpecializationDiagnostic::MissingFontIdentity { slot: 0 }));
        ui.enable_font_identity();
        assert!(ui.load_styles(&style));
        assert!(ui.load_font_atlas(&atlas(0, 1)));
        assert!(contract.matches(&ui));
        ui.set_text_measure(Some(alloc::boxed::Box::new(|_, _, _, _| (1.0, 1.0))));
        assert_eq!(
            contract.validate(&ui).diagnostics,
            vec![SpecializationDiagnostic::NativeTextProvider]
        );
        ui.set_text_measure(None);
        assert!(ui.set_tick_rate(50));
        assert_eq!(
            contract.validate(&ui).diagnostics,
            vec![SpecializationDiagnostic::TickRate {
                expected: 60,
                actual: 50
            }]
        );
    }

    #[test]
    fn atomic_assets_and_streaming_cannot_leave_stale_identities() {
        use crate::assets::{AssetInput, AssetKind};
        let font = atlas(0, 1);
        let style = styles();
        let mut ui = Ui::new();
        ui.enable_font_identity();
        ui.load_assets(
            &[
                AssetInput {
                    kind: AssetKind::Styles,
                    bytes: &style,
                },
                AssetInput {
                    kind: AssetKind::Font,
                    bytes: &font,
                },
            ],
            &mut [-1, -1],
        )
        .unwrap();
        assert_eq!(ui.font_atlas_identity(0), Some(content_hash(&font)));
        assert_eq!(ui.styles_identity(), Some(content_hash(&style)));
        let replacement = atlas(0, 2);
        assert!(ui
            .load_assets(
                &[
                    AssetInput {
                        kind: AssetKind::Font,
                        bytes: &replacement
                    },
                    AssetInput {
                        kind: AssetKind::Styles,
                        bytes: b"bad"
                    }
                ],
                &mut [-1, -1]
            )
            .is_err());
        assert_eq!(ui.font_atlas_identity(0), Some(content_hash(&font)));
        let mut stream = vec![0u8; 20];
        stream[..4].copy_from_slice(&crate::font_stream::CONFIG_MAGIC.to_le_bytes());
        stream[4..8].copy_from_slice(&1u32.to_le_bytes());
        stream[9..15].copy_from_slice(&[1, 1, 1, 1, 1, 1]);
        stream[16..18].copy_from_slice(&1u16.to_le_bytes());
        assert!(ui.font_stream_configure(&stream));
        assert!(ui.font_atlas_is_streamed(0));
        assert_eq!(ui.font_atlas_identity(0), None);
        let expected = [FontIdentity {
            slot: 0,
            hash: Some(content_hash(&font)),
        }];
        let contract = SpecializationContract {
            viewport: (480.0, 272.0),
            tick_hz: 60,
            text_provider: TextProvider::Baked,
            styles: content_hash(&style),
            fonts: &expected,
        };
        assert_eq!(
            contract.validate(&ui).diagnostics,
            vec![SpecializationDiagnostic::StreamedFont { slot: 0 }]
        );
    }
}
