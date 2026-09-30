//! Motion maths (§11 of `docs/desktop/ui-design.md`): spring easings, the
//! retargetable tween every state-driven transition uses, the sidebar's
//! width → content mapping (§4.4) and the streamed-word fade timing (§5.1).
//! Pure — the views feed it the clock; `anim.rs` holds the GPUI side.

use std::time::{Duration, Instant};

/// `motion.spring.*` (§11.2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spring {
    pub stiffness: f32,
    pub damping: f32,
    pub mass: f32,
    /// Where the envelope is inside 1 %: used as the animation's duration.
    pub settle_ms: u64,
}

impl Spring {
    /// The analytic under-damped step response at `t` ∈ [0, 1] of `settle`;
    /// the last frame writes the target exactly.
    pub fn ease(self, t: f32) -> f32 {
        if t >= 1.0 {
            return 1.0;
        }
        let secs = t.max(0.0) * self.settle_ms as f32 / 1000.0;
        let w0 = (self.stiffness / self.mass).sqrt();
        let zeta = self.damping / (2.0 * (self.stiffness * self.mass).sqrt());
        if zeta >= 1.0 {
            // Critically / over-damped fallback: no overshoot.
            return 1.0 - (-w0 * secs).exp() * (1.0 + w0 * secs);
        }
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        1.0 - (-zeta * w0 * secs).exp() * ((wd * secs).cos() + (zeta * w0 / wd) * (wd * secs).sin())
    }

    pub fn duration(self) -> Duration {
        Duration::from_millis(self.settle_ms)
    }
}

/// How a tween maps linear progress to eased progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Curve {
    Bezier([f32; 4]),
    Spring(Spring),
    Linear,
}

impl Curve {
    pub fn at(self, t: f32) -> f32 {
        match self {
            Curve::Bezier(p) => super::theme::cubic_bezier(p, t),
            Curve::Spring(s) => s.ease(t),
            Curve::Linear => t.clamp(0.0, 1.0),
        }
    }
}

/// A value moving from `from` to `to`. Retargeting mid-flight starts from the
/// value on screen now, so a reversed toggle never jumps (§11 principle).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tween {
    pub from: f32,
    pub to: f32,
    pub start: Instant,
    pub dur: Duration,
    pub curve: Curve,
}

impl Tween {
    pub fn at_rest(v: f32) -> Tween {
        Tween { from: v, to: v, start: Instant::now(), dur: Duration::ZERO, curve: Curve::Linear }
    }

    pub fn progress(&self, now: Instant) -> f32 {
        if self.dur.is_zero() {
            return 1.0;
        }
        (now.saturating_duration_since(self.start).as_secs_f32() / self.dur.as_secs_f32()).clamp(0.0, 1.0)
    }

    pub fn value(&self, now: Instant) -> f32 {
        self.from + (self.to - self.from) * self.curve.at(self.progress(now))
    }

    pub fn running(&self, now: Instant) -> bool {
        self.progress(now) < 1.0
    }

    /// Move to `to` from wherever the value is now. `dur` zero ⇒ jump (reduced motion).
    pub fn retarget(&mut self, to: f32, now: Instant, dur: Duration, curve: Curve) {
        if to == self.to {
            return;
        }
        *self = Tween { from: self.value(now), to, start: now, dur, curve };
    }
}

/// §4.4: the sidebar's content follows its animated width — opacity over the
/// first `fade_span` px, a left slide of up to `slide_offset` over `slide_span`.
pub fn sidebar_content(w: f32, fade_span: f32, slide_span: f32, slide_offset: f32) -> (f32, f32) {
    let opacity = (w / fade_span).clamp(0.0, 1.0);
    let x = -slide_offset * (1.0 - (w / slide_span).clamp(0.0, 1.0));
    (opacity, x)
}

/// A value in [0, 1] that goes 0 → 1 → 0 over one period (pulses).
pub fn triangle(t: f32) -> f32 {
    1.0 - (2.0 * t.clamp(0.0, 1.0) - 1.0).abs()
}

/// Word boundaries of freshly streamed text (§5.1): split at whitespace and
/// punctuation, and every CJK character is a word on its own. Returns the byte
/// offsets where each word starts, relative to `text`.
pub fn word_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![];
    let mut in_word = false;
    for (i, c) in text.char_indices() {
        let cjk = is_cjk(c);
        let sep = c.is_whitespace() || (c.is_ascii_punctuation() && c != '_' && c != '\'');
        if cjk || (!sep && !in_word) {
            starts.push(i);
        }
        in_word = !sep && !cjk;
    }
    starts
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x3000..=0x303F)
}

/// When each word of one arriving batch appears: `stagger` apart, the whole
/// batch capped at `cap` (later words share the cap). Offsets are shifted by
/// `base` (the batch's position in the block).
pub fn batch_schedule(batch: &str, base: usize, arrive_ms: u64, stagger_ms: u64, cap_ms: u64) -> Vec<(usize, u64)> {
    word_starts(batch).into_iter().enumerate().map(|(i, at)| (base + at, arrive_ms + (i as u64 * stagger_ms).min(cap_ms))).collect()
}

/// A streamed word's alpha at `now` (linear progress; the caller eases it).
pub fn word_progress(t0_ms: u64, now_ms: u64, fade_ms: u64) -> f32 {
    if now_ms <= t0_ms {
        return 0.0;
    }
    ((now_ms - t0_ms) as f32 / fade_ms.max(1) as f32).min(1.0)
}

/// The alpha runs of `text[from..len]` (§5.1): each fading word's progress
/// covers it up to the next fading word; text before the first one is fully
/// shown. `words` are (byte offset, appear time) in text order.
pub fn fade_runs(words: &[(usize, u64)], from: usize, len: usize, now_ms: u64, fade_ms: u64) -> Vec<(std::ops::Range<usize>, f32)> {
    let words: Vec<(usize, u64)> = words.iter().copied().filter(|(w, _)| *w >= from).collect();
    let mut runs = vec![];
    let (mut pos, mut i) = (from, 0);
    while pos < len {
        let (p, end) = match words.get(i) {
            Some(&(w, t0)) if w <= pos => {
                i += 1;
                (word_progress(t0, now_ms, fade_ms), words.get(i).map_or(len, |n| n.0))
            }
            Some(&(w, _)) => (1.0, w),
            None => (1.0, len),
        };
        runs.push((pos..end, p));
        pos = end;
    }
    runs
}

/// The fade state of one streaming text block: which bytes were seen when, so
/// a word never replays (§5.1 rule 3).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamFade {
    pub seen: usize,
    /// (byte offset, appear time) of each word still fading, in text order.
    pub words: Vec<(usize, u64)>,
}

impl StreamFade {
    /// Register text that grew to `text`. The first sighting of a block
    /// (switching to a session mid-stream) marks everything as already shown.
    pub fn observe(&mut self, text: &str, now_ms: u64, stagger_ms: u64, cap_ms: u64, first: bool) {
        if text.len() < self.seen || !text.is_char_boundary(self.seen) {
            // The block was rewritten: keep nothing that could replay.
            *self = StreamFade { seen: text.len(), words: vec![] };
            return;
        }
        if first {
            self.seen = text.len();
            return;
        }
        if text.len() > self.seen {
            let batch = &text[self.seen..];
            self.words.extend(batch_schedule(batch, self.seen, now_ms, stagger_ms, cap_ms));
            self.seen = text.len();
        }
    }

    /// Drop words that finished fading; true while any is still fading.
    pub fn prune(&mut self, now_ms: u64, fade_ms: u64) -> bool {
        self.words.retain(|(_, t0)| word_progress(*t0, now_ms, fade_ms) < 1.0);
        !self.words.is_empty()
    }

    /// The first byte still fading, if any.
    pub fn fresh_from(&self) -> Option<usize> {
        self.words.first().map(|(at, _)| *at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPPY: Spring = Spring { stiffness: 500.0, damping: 30.0, mass: 1.0, settle_ms: 300 };

    #[test]
    fn spring_starts_at_zero_overshoots_a_little_and_lands_exactly() {
        assert!(SNAPPY.ease(0.0).abs() < 1e-6);
        let peak = (0..=100).map(|i| SNAPPY.ease(i as f32 / 100.0)).fold(0.0f32, f32::max);
        assert!(peak > 1.01 && peak < 1.10, "snappy overshoots ≈ 6 %: {peak}");
        assert!((SNAPPY.ease(0.99) - 1.0).abs() < 0.02, "settled inside the envelope");
        assert_eq!(SNAPPY.ease(1.0), 1.0);
        let scroll = Spring { stiffness: 280.0, damping: 30.0, mass: 1.0, settle_ms: 300 };
        let peak = (0..=100).map(|i| scroll.ease(i as f32 / 100.0)).fold(0.0f32, f32::max);
        assert!(peak < 1.01, "scroll barely overshoots: {peak}");
    }

    #[test]
    fn tween_retargets_from_the_current_value() {
        let t0 = Instant::now();
        let mut tw = Tween::at_rest(260.0);
        assert_eq!(tw.value(t0), 260.0);
        tw.retarget(0.0, t0, Duration::from_millis(200), Curve::Linear);
        let mid = t0 + Duration::from_millis(100);
        assert!((tw.value(mid) - 130.0).abs() < 1e-3);
        assert!(tw.running(mid));
        tw.retarget(260.0, mid, Duration::from_millis(200), Curve::Linear);
        assert!((tw.value(mid) - 130.0).abs() < 1e-3, "reversal does not jump");
        assert_eq!(tw.value(mid + Duration::from_millis(300)), 260.0);
        tw.retarget(0.0, mid, Duration::ZERO, Curve::Linear);
        assert_eq!(tw.value(mid), 0.0, "zero duration jumps (reduced motion)");
    }

    #[test]
    fn sidebar_content_fades_before_the_width_reaches_zero() {
        assert_eq!(sidebar_content(260.0, 96.0, 156.0, 12.0), (1.0, 0.0));
        assert_eq!(sidebar_content(0.0, 96.0, 156.0, 12.0), (0.0, -12.0));
        let (o, x) = sidebar_content(48.0, 96.0, 156.0, 12.0);
        assert!((o - 0.5).abs() < 1e-6 && x < 0.0 && x > -12.0);
    }

    #[test]
    fn pulses() {
        assert_eq!(triangle(0.5), 1.0);
        assert_eq!(triangle(0.0), 0.0);
        assert_eq!(triangle(1.0), 0.0);
    }

    #[test]
    fn words_split_on_spaces_punctuation_and_each_cjk_char() {
        assert_eq!(word_starts("hello, big world"), vec![0, 7, 11]);
        assert_eq!(word_starts("状态条ok"), vec![0, 3, 6, 9]);
        assert_eq!(word_starts("  "), Vec::<usize>::new());
        assert_eq!(word_starts("don't"), vec![0]);
    }

    #[test]
    fn a_batch_is_staggered_and_capped() {
        let s = batch_schedule("a b c d e f g h", 10, 1000, 20, 60);
        assert_eq!(s[0], (10, 1000));
        assert_eq!(s[1], (12, 1020));
        assert_eq!(s[3].1, 1060);
        assert_eq!(s[7].1, 1060, "capped");
        assert_eq!(word_progress(1000, 900, 160), 0.0);
        assert_eq!(word_progress(1000, 1080, 160), 0.5);
        assert_eq!(word_progress(1000, 2000, 160), 1.0);
    }

    #[test]
    fn fade_runs_cover_the_line_and_carry_each_words_progress() {
        // "ab cd ef": words at 3 (t0 1000) and 6 (t0 1080); fade 160, now 1080.
        let runs = fade_runs(&[(3, 1000), (6, 1080)], 0, 8, 1080, 160);
        assert_eq!(runs, vec![(0..3, 1.0), (3..6, 0.5), (6..8, 0.0)]);
        assert_eq!(fade_runs(&[(3, 1000)], 4, 8, 1080, 160), vec![(4..8, 1.0)], "words before the line are ignored");
        assert_eq!(fade_runs(&[], 0, 0, 0, 160), vec![]);
    }

    #[test]
    fn stream_fade_never_replays_and_skips_the_first_sighting() {
        let mut f = StreamFade::default();
        f.observe("already here", 0, 20, 120, true);
        assert_eq!((f.seen, f.words.len()), (12, 0));
        f.observe("already here and more", 100, 20, 120, false);
        assert_eq!(f.fresh_from(), Some(13));
        assert_eq!(f.words, vec![(13, 100), (17, 120)]);
        assert!(f.prune(150, 160));
        assert!(!f.prune(1000, 160));
        f.observe("already here and more", 1000, 20, 120, false);
        assert!(f.words.is_empty(), "no new text, nothing fades");
        f.observe("rewritten", 1000, 20, 120, false);
        assert_eq!((f.seen, f.words.len()), (9, 0));
    }
}
