//! Bounded opt-in cache populated only by generated native code. The byte
//! budget includes the cache header, fixed entry table, and owned UTF-8 keys;
//! allocator bookkeeping is outside the budget, as for other core buffers.

use crate::spec;
use alloc::{boxed::Box, vec::Vec};

struct Entry {
    slot: u8,
    revision: u64,
    text: Box<str>,
    tracking: u32,
    line_height: u32,
    size: (f32, f32),
    misses: u32,
}

pub(crate) struct ShapedSizeCache {
    entries: Box<[Option<Entry>]>,
    revisions: [u64; spec::MAX_FONT_SLOTS],
    text_bytes: usize,
    text_budget: usize,
    count: usize,
    next: usize,
}

impl ShapedSizeCache {
    pub(crate) fn new(budget: usize) -> Option<Box<Self>> {
        let available = budget.checked_sub(core::mem::size_of::<Self>())?;
        let entry_bytes = core::mem::size_of::<Option<Entry>>();
        if available <= entry_bytes {
            return None;
        }
        let capacity = (available / (entry_bytes * 2)).clamp(1, 64);
        let entries = core::iter::repeat_with(|| None)
            .take(capacity)
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Some(Box::new(Self {
            entries,
            revisions: [0; spec::MAX_FONT_SLOTS],
            text_bytes: 0,
            text_budget: available - capacity * entry_bytes,
            count: 0,
            next: 0,
        }))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub(crate) fn bytes(&self) -> usize {
        core::mem::size_of::<Self>() + core::mem::size_of_val(&*self.entries) + self.text_bytes
    }

    fn remove(&mut self, index: usize) {
        if let Some(entry) = self.entries[index].take() {
            self.text_bytes -= entry.text.len();
            self.count -= 1;
        }
    }

    pub(crate) fn invalidate(&mut self, slot: u8) {
        for index in 0..self.entries.len() {
            if self.entries[index]
                .as_ref()
                .is_some_and(|entry| entry.slot == slot)
            {
                self.remove(index);
            }
        }
    }

    pub(crate) fn insert(
        &mut self,
        slot: u8,
        revision: u64,
        text: &str,
        tracking: f32,
        line_height: f32,
        size: (f32, f32),
        misses: u32,
    ) -> bool {
        if slot as usize >= spec::MAX_FONT_SLOTS || text.len() > self.text_budget {
            return false;
        }
        if self.revisions[slot as usize] != revision {
            self.invalidate(slot);
            self.revisions[slot as usize] = revision;
        }
        if let Some(index) = self.entries.iter().position(|entry| {
            entry.as_ref().is_some_and(|entry| {
                entry.slot == slot
                    && &*entry.text == text
                    && entry.tracking == tracking.to_bits()
                    && entry.line_height == line_height.to_bits()
            })
        }) {
            // Repeated template instances share this key. Updating the value
            // must not consume FIFO capacity or evict another template's size.
            let entry = self.entries[index].as_mut().unwrap();
            entry.size = size;
            entry.misses = misses;
            return true;
        }
        let target = self.next;
        self.remove(target);
        while self.text_bytes + text.len() > self.text_budget {
            self.next = (self.next + 1) % self.entries.len();
            self.remove(self.next);
        }
        self.entries[target] = Some(Entry {
            slot,
            revision,
            text: text.into(),
            tracking: tracking.to_bits(),
            line_height: line_height.to_bits(),
            size,
            misses,
        });
        self.text_bytes += text.len();
        self.count += 1;
        self.next = (target + 1) % self.entries.len();
        true
    }

    pub(crate) fn lookup(
        &self,
        slot: u8,
        text: &str,
        tracking: f32,
        line_height: f32,
    ) -> Option<((f32, f32), u32)> {
        if self.count == 0 {
            return None;
        }
        let revision = *self.revisions.get(slot as usize)?;
        self.entries
            .iter()
            .filter_map(Option::as_ref)
            .find(|entry| {
                entry.slot == slot
                    && entry.revision == revision
                    && entry.tracking == tracking.to_bits()
                    && entry.line_height == line_height.to_bits()
                    && &*entry.text == text
            })
            .map(|entry| (entry.size, entry.misses))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn repeated_template_prefill_preserves_other_cached_sizes() {
        let mut cache = ShapedSizeCache::new(1024).unwrap();
        let count = cache.entries.len();
        for i in 0..count {
            assert!(cache.insert(0, 1, &format!("{i}"), 0.0, f32::NAN, (i as f32, 9.0), 0));
        }
        let bytes = cache.bytes();
        for _ in 0..count * 3 {
            assert!(cache.insert(0, 1, "0", 0.0, f32::NAN, (10.0, 9.0), 0));
        }
        assert_eq!(cache.bytes(), bytes);
        assert_eq!(cache.lookup(0, "0", 0.0, f32::NAN), Some(((10.0, 9.0), 0)));
        for i in 1..count {
            assert_eq!(
                cache.lookup(0, &format!("{i}"), 0.0, f32::NAN),
                Some(((i as f32, 9.0), 0))
            );
        }
    }

    #[test]
    fn fifo_evicts_oldest_entry_without_flushing_other_entries() {
        let mut cache = ShapedSizeCache::new(1024).unwrap();
        let count = cache.entries.len();
        assert!(count > 2);
        for i in 0..=count {
            assert!(cache.insert(0, 1, &format!("{i}"), 0.0, f32::NAN, (i as f32, 9.0), 0));
            assert!(cache.bytes() <= 1024);
        }
        assert!(cache.lookup(0, "0", 0.0, f32::NAN).is_none());
        for i in 1..=count {
            assert_eq!(
                cache.lookup(0, &format!("{i}"), 0.0, f32::NAN),
                Some(((i as f32, 9.0), 0))
            );
        }
    }
}
