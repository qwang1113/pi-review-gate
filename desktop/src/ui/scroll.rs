//! Program-driven scrolling (§11.4): 「回到最新」, 「还有 N 行未读」, ⌘↑ / ⌘↓,
//! PageUp / PageDown ride `motion.spring.scroll`; far jumps land one viewport
//! short first; any wheel / trackpad touch hands control straight back.
//! Native momentum is never touched.

use super::motion::{Curve, Tween};
use crate::app::Shell;
use gpui_kit::*;
use std::time::{Duration, Instant};

pub struct ScrollAnim {
    pub handle: ScrollHandle,
    pub y: Tween,
}

/// Where a far jump starts animating from: one `screen` short of `to` (offsets
/// are negative, GPUI style). Near targets start where they are.
pub fn start_from(from: f32, to: f32, screen: f32, max_screens: f32) -> f32 {
    if (to - from).abs() <= screen * max_screens {
        return from;
    }
    to + if to < from { screen } else { -screen }
}

impl Shell {
    /// Scroll `handle` to `target` px from the top (None = the end).
    pub fn scroll_to(&mut self, handle: ScrollHandle, target: Option<f32>, cx: &mut Context<Self>) {
        let th = self.th;
        let max = f32::from(handle.max_offset().y);
        let to = -target.unwrap_or(max).clamp(0., max);
        let now_y = f32::from(handle.offset().y);
        let screen = f32::from(handle.bounds().size.height).max(1.);
        let from = start_from(now_y, to, screen, th.n("limit.programmatic_scroll.max_screens"));
        if from != now_y {
            handle.set_offset(point(px(0.), px(from)));
        }
        let s = th.spring("scroll");
        let dur = if self.reduce_motion { Duration::ZERO } else { s.duration() };
        let mut y = Tween::at_rest(from);
        y.retarget(to, Instant::now(), dur, Curve::Spring(s));
        self.scroll_anim = Some(ScrollAnim { handle, y });
        cx.notify();
    }

    /// A wheel / trackpad touch: stop at once.
    pub fn stop_programmatic_scroll(&mut self) {
        self.scroll_anim = None;
    }

    /// One frame of the running scroll (called from `render`).
    pub(crate) fn step_scroll(&mut self, window: &mut Window) {
        let Some(a) = &self.scroll_anim else { return };
        let now = Instant::now();
        a.handle.set_offset(point(px(0.), px(a.y.value(now))));
        if a.y.running(now) {
            window.request_animation_frame();
        } else {
            self.scroll_anim = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::start_from;

    #[test]
    fn far_jumps_start_one_screen_short() {
        assert_eq!(start_from(0., -500., 400., 3.), 0., "near: animate the whole way");
        assert_eq!(start_from(0., -5000., 400., 3.), -4600., "down: one screen above");
        assert_eq!(start_from(-5000., 0., 400., 3.), -400., "up: one screen below");
    }
}
