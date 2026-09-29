//! Damage from draw segments. Segments with an unchanged revision skip word
//! decoding, and a partial repaint must equal a full render.

use core::ops::Range;
use pocketjs_core::damage::{DamageRect, DamageTarget, DamageTracker};
use pocketjs_core::resources::{DrawSegment, FontView, RenderResources};
use pocketjs_core::{raster, spec::draw_op, TexView};

const BLUE: u32 = 0xff00_00ff;
const RED: u32 = 0xffff_0000;
const GREEN: u32 = 0xff00_ff00;
const WHITE: u32 = 0xffff_ffff;
const SCREEN: DamageRect = DamageRect::new(0, 0, 80, 40);

fn target() -> DamageTarget {
    DamageTarget::new(80, 40, 1, 9)
}

/// Draw words over an 80x40 background, one segment per card.
struct Frame {
    words: Vec<u32>,
    segments: Vec<DrawSegment>,
}

impl RenderResources for Frame {
    fn viewport(&self) -> (f32, f32) {
        (80.0, 40.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
    fn draw_segments(&self) -> &[DrawSegment] {
        &self.segments
    }
}

/// A 20x20 card at (x, 5). A badge adds a second rect at words 8..12 of the card.
#[derive(Clone, Copy)]
struct Card {
    id: u64,
    x: i32,
    color: u32,
    revision: u64,
    badge: bool,
}

fn card(id: u64, x: i32, color: u32) -> Card {
    Card { id, x, color, revision: 1, badge: false }
}

/// A 2x3 affine placement that translates by `x`.
fn translate(x: f32) -> [u32; 6] {
    [1f32.to_bits(), 0, 0, 1f32.to_bits(), x.to_bits(), 0]
}

fn rect(words: &mut Vec<u32>, b: DamageRect, color: u32) {
    let size = (b.x1 - b.x0) as u32 | (((b.y1 - b.y0) as u32) << 16);
    words.extend_from_slice(&[draw_op::RECT, b.x0 as u16 as u32 | ((b.y0 as u16 as u32) << 16), size, color]);
}

fn frame(cards: &[Card]) -> Frame {
    let mut frame = Frame { words: vec![], segments: vec![] };
    rect(&mut frame.words, SCREEN, 0xff20_2020);
    for (order, card) in cards.iter().enumerate() {
        let bounds = DamageRect::new(card.x, 5, card.x + 20, 25);
        let word_start = frame.words.len();
        rect(&mut frame.words, bounds, card.color);
        if card.badge {
            rect(&mut frame.words, DamageRect::new(card.x + 2, 7, card.x + 6, 11), WHITE);
        }
        frame.segments.push(DrawSegment {
            id: card.id,
            parent: None,
            word_start,
            word_end: frame.words.len(),
            bounds,
            clip: SCREEN,
            revision: card.revision,
            patch_bounds: None,
            placement: translate(card.x as f32),
            order: order as u32,
        });
    }
    frame
}

/// A segment for `words` nested in segment `parent`, sharing its geometry.
fn nested(frame: &Frame, parent: usize, id: u64, words: Range<usize>) -> DrawSegment {
    let outer = frame.segments[parent];
    DrawSegment { id, parent: Some(outer.id), word_start: words.start, word_end: words.end, ..outer }
}

/// Wraps every card segment in one outer segment (id 99) with `revision`.
#[cfg(feature = "counters")]
fn wrapped(mut frame: Frame, revision: u64) -> Frame {
    for segment in &mut frame.segments {
        segment.parent = Some(99);
    }
    let word_end = frame.words.len();
    let outer = DrawSegment {
        id: 99,
        parent: None,
        word_start: 0,
        word_end,
        bounds: SCREEN,
        clip: SCREEN,
        revision,
        patch_bounds: None,
        placement: translate(0.0),
        order: 0,
    };
    frame.segments.insert(0, outer);
    frame
}

/// Commits `from`, then prepares damage for `to`.
fn damage(from: &Frame, to: &Frame) -> (DamageRect, DamageTracker<8>) {
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(from, &from.words, target());
    let bounds = tracker.prepare(to, &to.words, target()).unwrap().bounds();
    (bounds, tracker)
}

#[test]
fn partial_repaints_match_full_renders_across_edits_reorders_and_skipped_frames() {
    // Translucent cards so every repaint also blends over the background.
    let a = Card { color: 0x9000_00ff, ..card(1, 4, 0) };
    let a_badged = Card { color: 0x90ff_0000, revision: 2, badge: true, ..a };
    let b = card(2, 16, 0x9000_ff00);
    let frames = [
        frame(&[a, b]),
        frame(&[a_badged, b]),
        frame(&[b, a_badged]),
        frame(&[card(3, 48, WHITE), b, a_badged]),
        frame(&[Card { x: 32, ..b }, a_badged]),
        frame(&[]),
        frame(&[Card { revision: 3, ..a }]),
    ];
    // Buffer 1 skips odd frames, so it retains a different committed frame.
    let mut trackers = [DamageTracker::<8>::new(), DamageTracker::<8>::new()];
    let mut buffers = [vec![0; 80 * 40 * 4], vec![0; 80 * 40 * 4]];
    for (index, frame) in frames.iter().enumerate() {
        let mut expected = vec![0; 80 * 40 * 4];
        raster::render(frame, &frame.words, &mut expected);
        for slot in (0..2).filter(|&slot| slot == 0 || index % 2 == 0) {
            let plan = trackers[slot].prepare(frame, &frame.words, target()).unwrap();
            assert_eq!(plan, trackers[slot].prepare(frame, &frame.words, target()).unwrap(), "prepare is pure");
            assert!(index == 0 || !plan.is_full_redraw(), "frame {index}, buffer {slot}");
            raster::render_scaled_regions(frame, &frame.words, &mut buffers[slot], 1, plan.regions());
            assert_eq!(buffers[slot], expected, "frame {index}, buffer {slot}");
            trackers[slot].commit(frame, &frame.words, target());
        }
    }
}

#[test]
fn a_changed_card_or_an_insertion_damages_only_its_bounds() {
    let first = frame(&[card(1, 4, BLUE), card(2, 48, GREEN)]);
    let changed = frame(&[Card { color: RED, revision: 2, badge: true, ..card(1, 4, 0) }, card(2, 48, GREEN)]);
    assert_eq!(damage(&first, &changed).0, DamageRect::new(4, 5, 24, 25));
    let inserted = frame(&[card(3, 28, WHITE), card(1, 4, BLUE), card(2, 48, GREEN)]);
    assert_eq!(damage(&first, &inserted).0, DamageRect::new(28, 5, 48, 25));
}

#[test]
fn nested_segments_are_compared_when_the_outer_revision_changes() {
    let badged = Card { badge: true, ..card(1, 4, BLUE) };
    let mut first = frame(&[badged]);
    first.segments.push(nested(&first, 0, 2, 8..12));
    let mut second = frame(&[Card { revision: 2, ..badged }]);
    second.words[11] = GREEN; // the badge color
    second.segments.push(DrawSegment { revision: 2, ..first.segments[1] });
    assert_eq!(damage(&first, &second).0, DamageRect::new(6, 7, 10, 11));
}

#[test]
fn overlapping_or_reversed_nested_segments_fall_back_to_word_damage() {
    for reversed in [false, true] {
        let mut first = frame(&[Card { badge: true, ..card(1, 4, BLUE) }]);
        first.segments.push(nested(&first, 0, 2, 8..12));
        first.segments.push(nested(&first, 0, 3, if reversed { 4..8 } else { 8..12 }));
        let mut second = Frame { words: first.words.clone(), segments: first.segments.clone() };
        second.words[11] = GREEN;
        second.segments.iter_mut().for_each(|segment| segment.revision += 1);
        assert_eq!(damage(&first, &second).0, DamageRect::new(6, 7, 10, 11));
    }
}

#[cfg(feature = "counters")]
#[test]
fn unchanged_and_moved_segments_decode_no_words() {
    let first = frame(&[card(1, 4, BLUE), card(2, 48, GREEN)]);
    let moved = frame(&[card(1, 8, BLUE), card(2, 48, GREEN)]);
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&first, &first.words, target());
    assert!(tracker.prepare(&first, &first.words, target()).unwrap().is_empty());
    assert!(!tracker.prepare(&moved, &moved.words, target()).unwrap().is_empty());
    assert_eq!(tracker.counters().decoded_ops, 0);
}

#[cfg(feature = "counters")]
#[test]
fn a_changed_nested_segment_skips_its_unchanged_sibling() {
    let first = wrapped(frame(&[card(1, 4, BLUE), card(2, 48, GREEN)]), 1);
    let second = wrapped(frame(&[Card { color: RED, revision: 2, ..card(1, 4, 0) }, card(2, 48, GREEN)]), 2);
    let (bounds, tracker) = damage(&first, &second);
    assert_eq!(bounds, DamageRect::new(4, 5, 24, 25));
    assert_eq!(tracker.counters().decoded_ops, 2, "the old and new rect of card 1 only");
}
