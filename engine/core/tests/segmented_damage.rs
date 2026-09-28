use pocketjs_core::{
    damage::{DamageRect, DamageTarget, DamageTracker},
    raster,
    resources::{DrawSegment, FontView, RenderResources},
    spec::draw_op,
    TexView,
};

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
fn rect(words: &mut Vec<u32>, bounds: DamageRect, color: u32) {
    words.extend_from_slice(&[
        draw_op::RECT,
        bounds.x0 as u16 as u32 | ((bounds.y0 as u16 as u32) << 16),
        (bounds.x1 - bounds.x0) as u32 | (((bounds.y1 - bounds.y0) as u32) << 16),
        color,
    ]);
}
fn frame(cards: &[(u64, i32, u32, u64, bool)]) -> Frame {
    let mut frame = Frame {
        words: vec![],
        segments: vec![],
    };
    rect(&mut frame.words, DamageRect::new(0, 0, 80, 40), 0xff202020);
    for (order, &(id, x, color, revision, split)) in cards.iter().enumerate() {
        let bounds = DamageRect::new(x, 5, x + 20, 25);
        let start = frame.words.len();
        rect(&mut frame.words, bounds, color);
        if split {
            rect(
                &mut frame.words,
                DamageRect::new(x + 2, 7, x + 6, 11),
                0xffffffff,
            );
        }
        frame.segments.push(DrawSegment {
            id,
            parent: None,
            word_start: start,
            word_end: frame.words.len(),
            bounds,
            clip: DamageRect::new(0, 0, 80, 40),
            revision,
            patch_bounds: None,
            placement: [
                1f32.to_bits(),
                0,
                0,
                1f32.to_bits(),
                (x as f32).to_bits(),
                0,
            ],
            order: order as u32,
        });
    }
    frame
}
fn target() -> DamageTarget {
    DamageTarget::new(80, 40, 1, 9)
}

#[test]
fn segmented_replay_matches_full_pixels_across_structure_order_and_skipped_frames() {
    let frames = [
        frame(&[(1, 4, 0x900000ff, 1, false), (2, 16, 0x9000ff00, 1, false)]),
        frame(&[(1, 4, 0x90ff0000, 2, true), (2, 16, 0x9000ff00, 1, false)]),
        frame(&[(2, 16, 0x9000ff00, 1, false), (1, 4, 0x90ff0000, 2, true)]),
        frame(&[
            (3, 48, 0xffffffff, 1, false),
            (2, 16, 0x9000ff00, 1, false),
            (1, 4, 0x90ff0000, 2, true),
        ]),
        frame(&[(2, 32, 0x9000ff00, 1, false), (1, 4, 0x90ff0000, 2, true)]),
        frame(&[]),
        frame(&[(1, 4, 0x900000ff, 3, false)]),
    ];
    let mut trackers = [DamageTracker::<8>::new(), DamageTracker::<8>::new()];
    let mut buffers = [vec![0; 80 * 40 * 4], vec![0; 80 * 40 * 4]];
    for (index, frame) in frames.iter().enumerate() {
        let mut expected = vec![0; 80 * 40 * 4];
        raster::render(frame, &frame.words, &mut expected);
        for slot in 0..2 {
            // Each framebuffer retains a different successfully committed frame.
            if slot == 1 && index % 2 == 1 {
                continue;
            }
            let plan = trackers[slot]
                .prepare(frame, &frame.words, target())
                .unwrap();
            assert_eq!(
                plan,
                trackers[slot]
                    .prepare(frame, &frame.words, target())
                    .unwrap()
            );
            if index > 0 {
                assert!(!plan.is_full_redraw(), "frame {index}, target {slot}");
            }
            raster::render_scaled_regions(
                frame,
                &frame.words,
                &mut buffers[slot],
                1,
                plan.regions(),
            );
            assert_eq!(buffers[slot], expected, "frame {index}, target {slot}");
            trackers[slot].commit(frame, &frame.words, target());
        }
    }
}

#[test]
fn one_changed_card_and_insertions_keep_damage_local() {
    let first = frame(&[(1, 4, 0xff0000ff, 1, false), (2, 48, 0xff00ff00, 1, false)]);
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&first, &first.words, target());
    let second = frame(&[(1, 4, 0xffff0000, 2, true), (2, 48, 0xff00ff00, 1, false)]);
    let plan = tracker.prepare(&second, &second.words, target()).unwrap();
    assert_eq!(plan.bounds(), DamageRect::new(4, 5, 24, 25));
    let inserted = frame(&[
        (3, 28, 0xffffffff, 1, false),
        (1, 4, 0xff0000ff, 1, false),
        (2, 48, 0xff00ff00, 1, false),
    ]);
    let plan = tracker
        .prepare(&inserted, &inserted.words, target())
        .unwrap();
    assert_eq!(plan.bounds(), DamageRect::new(28, 5, 48, 25));
}

#[test]
fn nested_regions_are_compared_through_the_outer_revision() {
    let mut first = frame(&[(1, 4, 0xff0000ff, 1, true)]);
    let outer = first.segments[0];
    first.segments.push(DrawSegment {
        id: 2,
        parent: Some(1),
        word_start: 8,
        word_end: 12,
        ..outer
    });
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&first, &first.words, target());
    let mut second = frame(&[(1, 4, 0xff0000ff, 2, true)]);
    second.words[11] = 0xff00ff00;
    second.segments.push(DrawSegment {
        revision: 2,
        ..first.segments[1]
    });
    let plan = tracker.prepare(&second, &second.words, target()).unwrap();
    assert_eq!(plan.bounds(), DamageRect::new(6, 7, 10, 11));
}

#[cfg(feature = "counters")]
#[test]
fn unchanged_and_moved_regions_do_not_decode_operations() {
    let first = frame(&[(1, 4, 0xff0000ff, 1, false), (2, 48, 0xff00ff00, 1, false)]);
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&first, &first.words, target());
    assert!(tracker
        .prepare(&first, &first.words, target())
        .unwrap()
        .is_empty());
    let moved = frame(&[(1, 8, 0xff0000ff, 1, false), (2, 48, 0xff00ff00, 1, false)]);
    assert!(!tracker
        .prepare(&moved, &moved.words, target())
        .unwrap()
        .is_empty());
    assert_eq!(tracker.counters().decoded_ops, 0);
}

#[cfg(feature = "counters")]
#[test]
fn changing_one_nested_region_skips_unchanged_sibling_operations() {
    let nest = |mut f: Frame| {
        for child in &mut f.segments {
            child.parent = Some(99);
        }
        f.segments.insert(
            0,
            DrawSegment {
                id: 99,
                parent: None,
                word_start: 0,
                word_end: f.words.len(),
                bounds: DamageRect::new(0, 0, 80, 40),
                clip: DamageRect::new(0, 0, 80, 40),
                revision: 1,
                patch_bounds: None,
                placement: [1f32.to_bits(), 0, 0, 1f32.to_bits(), 0, 0],
                order: 0,
            },
        );
        f
    };
    let first = nest(frame(&[
        (1, 4, 0xff0000ff, 1, false),
        (2, 48, 0xff00ff00, 1, false),
    ]));
    let mut second = nest(frame(&[
        (1, 4, 0xffff0000, 2, false),
        (2, 48, 0xff00ff00, 1, false),
    ]));
    second.segments[0].revision = 2;
    let mut tracker = DamageTracker::<8>::new();
    tracker.commit(&first, &first.words, target());
    let plan = tracker.prepare(&second, &second.words, target()).unwrap();
    assert_eq!(plan.bounds(), DamageRect::new(4, 5, 24, 25));
    assert_eq!(tracker.counters().decoded_ops, 2);
}

#[test]
fn overlapping_or_reversed_nested_metadata_falls_back_to_legacy_damage() {
    for reversed in [false, true] {
        let mut first = frame(&[(1, 4, 0xff0000ff, 1, true)]);
        let outer = first.segments[0];
        first.segments.push(DrawSegment {
            id: 2,
            parent: Some(1),
            word_start: 8,
            word_end: 12,
            ..outer
        });
        first.segments.push(DrawSegment {
            id: 3,
            parent: Some(1),
            word_start: if reversed { 4 } else { 8 },
            word_end: if reversed { 8 } else { 12 },
            ..outer
        });
        let mut second = Frame {
            words: first.words.clone(),
            segments: first.segments.clone(),
        };
        second.words[11] = 0xff00ff00;
        for segment in &mut second.segments {
            segment.revision += 1;
        }
        let mut tracker = DamageTracker::<8>::new();
        tracker.commit(&first, &first.words, target());
        let plan = tracker.prepare(&second, &second.words, target()).unwrap();
        assert_eq!(plan.bounds(), DamageRect::new(6, 7, 10, 11));
    }
}
