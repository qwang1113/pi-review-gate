//! The GPUI side of §11: one-shot entrances keyed by element id, the press
//! sink, spring pops, scroll-edge fades and the stamp clock for transitions
//! that must also play on the way OUT (collapses, exits). The maths is in
//! `motion.rs`. GPUI cannot scale a div, so nothing here scales: opacity,
//! relative offsets, sizes and colours only.
//!
//! `with_animation` already renders the end state when `cx.reduce_motion()`
//! is set (§11.3); the stamp clock and the tweens ask `reduce` themselves.

use super::motion::Curve;
use super::theme::Th;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Opacity 0 → 1 plus a relative offset (dx, dy) → 0, once per `id`. With no
/// offset only the opacity moves, so an absolutely placed element keeps its place.
pub fn appear<E: Styled + IntoElement + 'static>(el: E, id: impl Into<SharedString>, dur: Duration, ease: impl Fn(f32) -> f32 + 'static, dx: f32, dy: f32) -> AnimationElement<E> {
    el.with_animation(ElementId::Name(id.into()), Animation::new(dur).with_easing(ease), move |el, t| {
        let el = el.opacity(t.clamp(0.0, 1.0));
        if dx == 0.0 && dy == 0.0 { el } else { el.relative().left(px(dx * (1.0 - t))).top(px(dy * (1.0 - t))) }
    })
}

/// The press feedback of every clickable (§8): colour to pressed, content sinks
/// `press.shift` (no scale 0.96 — GPUI cannot scale a div).
pub fn press<E: StatefulInteractiveElement + Styled>(el: E, th: Th, pressed_bg: Option<&str>, reduce: bool) -> E {
    let shift = if reduce { px(0.) } else { th.px("press.shift") };
    let bg = pressed_bg.map(|b| th.c(b));
    el.active(move |s| {
        let s = s.top(shift);
        match bg {
            Some(bg) => s.bg(bg),
            None => s,
        }
    })
}

/// A size that pops in with `motion.spring.snappy` whenever `key` changes
/// (check marks, the unread dot, tool completion icons).
pub fn pop_size<E: Styled + IntoElement + 'static>(el: E, key: impl Into<SharedString>, th: Th, from: f32, to: f32) -> AnimationElement<E> {
    let s = th.spring("snappy");
    el.with_animation(ElementId::Name(key.into()), Animation::new(s.duration()).with_easing(move |t| s.ease(t)), move |el, t| el.size(px(from + (to - from) * t)))
}

/// Colour cross-fade when `key` changes (hover, state colours): the element
/// starts at `from` and eases to `to` over `motion.duration.hover` / `standard`.
pub fn fade_bg<E: Styled + IntoElement + 'static>(el: E, key: impl Into<SharedString>, th: Th, from: Hsla, to: Hsla, dur: &str) -> AnimationElement<E> {
    el.with_animation(ElementId::Name(key.into()), Animation::new(th.ms(dur)).with_easing(th.ease("standard")), move |el, t| el.bg(mix(from, to, t)))
}

/// A background that eases between `off` and `on` — but only while `recent`
/// (a hover / focus change just happened), so the first paint never flashes.
#[allow(clippy::too_many_arguments)]
pub fn state_bg<E: Styled + IntoElement + 'static>(el: E, key: &str, th: Th, on_state: bool, on: Hsla, off: Hsla, recent: bool, dur: &str) -> AnyElement {
    let (from, to) = if on_state { (off, on) } else { (on, off) };
    if recent { fade_bg(el, format!("{key}-{on_state}"), th, from, to, dur).into_any_element() } else { el.bg(to).into_any_element() }
}

pub fn mix(a: Hsla, b: Hsla, t: f32) -> Hsla {
    let (a, b) = (Rgba::from(a), Rgba::from(b));
    let l = |x: f32, y: f32| x + (y - x) * t.clamp(0.0, 1.0);
    Rgba { r: l(a.r, b.r), g: l(a.g, b.g), b: l(a.b, b.b), a: l(a.a, b.a) }.into()
}

/// Edge fades on a scroll container (§11.4): a `scroll.fade_height` gradient
/// from the container colour to transparent on the side that has more.
pub fn scroll_fades(th: Th, scroll: &ScrollHandle, bg: Hsla) -> Vec<AnyElement> {
    let (off, max) = (-scroll.offset().y, scroll.max_offset().y);
    let edge = |top: bool| {
        let clear = Hsla { a: 0.0, ..bg };
        let (from, to) = if top { (bg, clear) } else { (clear, bg) };
        div()
            .absolute()
            .left_0()
            .right_0()
            .h(th.px("scroll.fade_height"))
            .map(|d| if top { d.top_0() } else { d.bottom_0() })
            .bg(linear_gradient(180., linear_color_stop(from, 0.), linear_color_stop(to, 1.)))
            .into_any_element()
    };
    let mut out = vec![];
    if off > px(1.) {
        out.push(edge(true));
    }
    if max - off > px(1.) {
        out.push(edge(false));
    }
    out
}

/// When each transition that also plays on the way out started. The views ask
/// `progress`; `Shell::render` requests the next frame while any is running.
#[derive(Default)]
pub struct Stamps {
    at: HashMap<String, Instant>,
}

impl Stamps {
    pub fn mark(&mut self, key: &str) {
        self.at.insert(key.to_string(), Instant::now());
    }

    /// Eased progress in [0, 1] of the transition `key` over `dur`; 1 when it
    /// never ran or has finished (and is then forgotten on the next `sweep`).
    pub fn progress(&self, key: &str, dur: Duration, curve: Curve) -> f32 {
        match self.at.get(key) {
            Some(at) if !dur.is_zero() => curve.at((at.elapsed().as_secs_f32() / dur.as_secs_f32()).min(1.0)),
            _ => 1.0,
        }
    }

    pub fn running(&self, key: &str, dur: Duration) -> bool {
        self.at.get(key).is_some_and(|at| at.elapsed() < dur)
    }

    /// Forget stamps older than `keep`; true while any is younger (a frame is due).
    pub fn sweep(&mut self, keep: Duration) -> bool {
        self.at.retain(|_, at| at.elapsed() < keep);
        !self.at.is_empty()
    }
}
