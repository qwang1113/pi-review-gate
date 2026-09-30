//! The sidebar's two states (§4.4): expanded or fully collapsed (0 px). Wide
//! windows push the main area; below `breakpoint.sidebar_overlay` it collapses
//! on its own and ⌘B opens an overlay drawer instead. Pure apart from the
//! remembered choice on disk (`~/.pi/desktop/ui-state.json`).

use super::motion::{Curve, Tween};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    pub toggle: Duration,
    pub enter: Duration,
    pub exit: Duration,
    pub smooth: Curve,
    pub exit_curve: Curve,
    pub reduce: bool,
    pub fade: Duration,
}

impl Timing {
    fn pick(&self, d: Duration, c: Curve) -> (Duration, Curve) {
        if self.reduce { (Duration::ZERO, Curve::Linear) } else { (d, c) }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidebarState {
    /// The user's choice for wide windows (remembered across launches).
    pub open: bool,
    /// The dragged width it returns to (remembered).
    pub width: f32,
    /// Narrow window: the overlay drawer is shown.
    pub overlay: bool,
    /// Closed for a drawer that needed the room (§6.1), reopened after it.
    pub yielded: bool,
    pub narrow: bool,
    /// Pushing width in px (wide windows).
    pub push: Tween,
    /// Overlay drawer progress 0..1 (narrow windows).
    pub slide: Tween,
}

impl SidebarState {
    pub fn new(open: bool, width: f32) -> SidebarState {
        SidebarState { open, width, overlay: false, yielded: false, narrow: false, push: Tween::at_rest(if open { width } else { 0.0 }), slide: Tween::at_rest(0.0) }
    }

    fn push_target(&self) -> f32 {
        if self.open && !self.narrow && !self.yielded { self.width } else { 0.0 }
    }

    fn settle(&mut self, now: Instant, t: &Timing) {
        let (d, c) = t.pick(t.toggle, t.smooth);
        self.push.retarget(self.push_target(), now, d, c);
        let target = if self.overlay && self.narrow { 1.0 } else { 0.0 };
        let (d, c) = if target > 0.0 { t.pick(t.enter, t.smooth) } else { t.pick(t.exit, t.exit_curve) };
        // Reduced motion keeps the overlay's opacity fade (§4.4).
        let (d, c) = if t.reduce { (t.fade, Curve::Linear) } else { (d, c) };
        self.slide.retarget(target, now, d, c);
    }

    /// ⌘B or the title-bar button.
    pub fn toggle(&mut self, now: Instant, t: &Timing) {
        if self.narrow {
            self.overlay = !self.overlay;
        } else if self.yielded {
            (self.yielded, self.open) = (false, true);
        } else {
            self.open = !self.open;
        }
        self.settle(now, t);
    }

    /// The window width crossed the breakpoint (or the first layout).
    pub fn set_narrow(&mut self, narrow: bool, now: Instant, t: &Timing) {
        if narrow != self.narrow {
            self.narrow = narrow;
            self.overlay = false;
            self.settle(now, t);
        }
    }

    /// Esc, a click on the scrim, or picking a session closes the overlay.
    pub fn close_overlay(&mut self, now: Instant, t: &Timing) {
        if self.overlay {
            self.overlay = false;
            self.settle(now, t);
        }
    }

    /// A drawer asks for the room (§6.1): step aside while it is open.
    pub fn yield_to_drawer(&mut self, need: bool, now: Instant, t: &Timing) {
        if need != self.yielded && (!need || (self.open && !self.narrow)) {
            self.yielded = need;
            self.settle(now, t);
        }
    }

    /// Dragged to `w`; released below half the minimum ⇒ collapse (§4.4).
    pub fn drag(&mut self, w: f32, min: f32, max: f32) {
        self.width = w.clamp(min, max);
        self.push = Tween::at_rest(self.width);
    }

    pub fn release(&mut self, w: f32, min: f32, now: Instant, t: &Timing) {
        if w < min / 2.0 {
            self.open = false;
            self.settle(now, t);
        }
    }

    /// Nothing of the list is on screen (the toggle's waiting badge shows).
    pub fn hidden(&self, now: Instant) -> bool {
        if self.narrow { self.slide.value(now) <= 0.0 && !self.overlay } else { self.push.value(now) <= 0.0 && self.push_target() == 0.0 }
    }

    pub fn to_json(&self) -> String {
        serde_json::json!({"sidebarOpen": self.open, "sidebarWidth": self.width}).to_string()
    }

    pub fn from_json(s: &str, default_width: f32, min: f32, max: f32) -> SidebarState {
        let v: serde_json::Value = serde_json::from_str(s).unwrap_or_default();
        let open = v["sidebarOpen"].as_bool().unwrap_or(true);
        let width = v["sidebarWidth"].as_f64().map_or(default_width, |w| (w as f32).clamp(min, max));
        SidebarState::new(open, width)
    }
}

pub fn state_file() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".pi/desktop/ui-state.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timing(reduce: bool) -> Timing {
        let ms = Duration::from_millis;
        Timing { toggle: ms(220), enter: ms(240), exit: ms(200), smooth: Curve::Linear, exit_curve: Curve::Linear, reduce, fade: ms(60) }
    }

    #[test]
    fn toggle_collapses_to_zero_and_returns_to_the_dragged_width() {
        let (t, now) = (timing(false), Instant::now());
        let mut s = SidebarState::new(true, 300.0);
        s.toggle(now, &t);
        assert!(!s.open);
        assert_eq!(s.push.value(now + Duration::from_millis(220)), 0.0);
        assert!(s.hidden(now + Duration::from_millis(220)));
        s.toggle(now + Duration::from_millis(300), &t);
        assert_eq!(s.push.value(now + Duration::from_secs(1)), 300.0);
    }

    #[test]
    fn a_reversed_toggle_mid_flight_does_not_jump() {
        let (t, now) = (timing(false), Instant::now());
        let mut s = SidebarState::new(true, 260.0);
        s.toggle(now, &t);
        let mid = now + Duration::from_millis(110);
        let w = s.push.value(mid);
        s.toggle(mid, &t);
        assert!((s.push.value(mid) - w).abs() < 1e-3);
    }

    #[test]
    fn narrow_windows_collapse_and_toggle_the_overlay_instead() {
        let (t, now) = (timing(false), Instant::now());
        let mut s = SidebarState::new(true, 260.0);
        s.set_narrow(true, now, &t);
        assert_eq!(s.push.to, 0.0);
        assert!(s.open, "the wide-window choice is kept for later");
        s.toggle(now, &t);
        assert!(s.overlay && s.slide.to == 1.0);
        s.close_overlay(now, &t);
        assert_eq!(s.slide.to, 0.0);
        s.set_narrow(false, now, &t);
        assert_eq!(s.push.to, 260.0, "back to what the user picked in a wide window");
    }

    #[test]
    fn a_drawer_borrows_the_room_and_gives_it_back() {
        let (t, now) = (timing(true), Instant::now());
        let mut s = SidebarState::new(true, 260.0);
        s.yield_to_drawer(true, now, &t);
        assert_eq!(s.push.value(now), 0.0, "reduced motion jumps");
        s.yield_to_drawer(false, now, &t);
        assert_eq!(s.push.value(now), 260.0);
        let mut closed = SidebarState::new(false, 260.0);
        closed.yield_to_drawer(true, now, &t);
        assert!(!closed.yielded, "a closed sidebar has nothing to give");
    }

    #[test]
    fn dragging_below_half_the_minimum_collapses() {
        let (t, now) = (timing(false), Instant::now());
        let mut s = SidebarState::new(true, 260.0);
        s.drag(500.0, 200.0, 400.0);
        assert_eq!(s.width, 400.0);
        s.drag(90.0, 200.0, 400.0);
        s.release(90.0, 200.0, now, &t);
        assert!(!s.open);
        assert_eq!(s.width, 200.0, "the width to come back to stays legal");
    }

    #[test]
    fn remembered_state_round_trips() {
        let s = SidebarState::new(false, 333.0);
        let back = SidebarState::from_json(&s.to_json(), 260.0, 200.0, 400.0);
        assert_eq!((back.open, back.width), (false, 333.0));
        let d = SidebarState::from_json("garbage", 260.0, 200.0, 400.0);
        assert_eq!((d.open, d.width), (true, 260.0));
    }
}
