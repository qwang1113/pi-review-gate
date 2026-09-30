//! The right drawer (§6.1): every gate question and pi dialog opens here,
//! pushing the chat column (composer included) to the left. It belongs to a
//! session: switching away swaps it with the chat, switching back finds it in
//! place. `DrawerView` is what is on screen — it outlives the hub's request
//! for the exit animation and for the outgoing question of a switch (§6.2).

use super::anim;
use super::dialogs::{self, Ctx};
use super::motion::{Curve, Tween};
use super::theme::Th;
use crate::app::{ActiveDialog, Shell};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::time::{Duration, Instant};

/// The outgoing question of a switch (§6.2): shown for `question_out`, then
/// the incoming one enters from the other side.
pub struct Switch {
    pub old_key: String,
    pub old: ActiveDialog,
    pub at: Instant,
    pub back: bool,
}

pub struct DrawerView {
    pub key: String,
    /// What is shown; kept after the hub drops it so the exit can play.
    pub active: ActiveDialog,
    /// 0 = closed, 1 = open.
    pub open: Tween,
    pub wide: bool,
    pub opened_at: Instant,
    pub switch: Option<Switch>,
    /// When the hub dropped the request (the exit waits a moment for a queued next question).
    pub leaving: Option<Instant>,
}

impl DrawerView {
    pub fn closing(&self) -> bool {
        self.open.to == 0.0
    }
}

/// The durations a drawer transition uses, honouring reduced motion (§11.3).
pub fn timing(th: Th, reduce: bool, entering: bool) -> (Duration, Curve) {
    match (reduce, entering) {
        (true, _) => (th.ms("reduced_motion_fade"), Curve::Linear),
        (false, true) => (th.ms("drawer_enter"), th.curve("smooth")),
        (false, false) => (th.ms("drawer_exit"), th.curve("exit")),
    }
}

/// The drawer's target width (§6.1): its kind's width, clamped so the chat keeps
/// `drawer.min_chat_width`.
pub fn width(th: Th, wide: bool, main_w: f32) -> f32 {
    let target = th.n(if wide { "drawer.confirm_width" } else { "drawer.choice_width" });
    target.min(main_w - th.n("drawer.min_chat_width")).max(0.0)
}

/// Does opening this drawer need the sidebar out of the way (§6.1)?
pub fn needs_room(th: Th, wide: bool, main_w: f32) -> bool {
    main_w - th.n(if wide { "drawer.confirm_width" } else { "drawer.choice_width" }) < th.n("drawer.min_chat_width")
}

/// The drawer for `sid`, and its open fraction (the chat scrim follows it).
pub fn render(shell: &Shell, sid: &str, who: &str, main_w: f32, window: &mut Window, cx: &mut Context<Shell>) -> Option<(AnyElement, f32)> {
    let th = shell.th;
    let view = shell.drawers.get(sid)?;
    let now = Instant::now();
    let f = view.open.value(now).clamp(0.0, 1.0);
    if view.open.running(now) || view.switch.as_ref().is_some_and(|s| s.at.elapsed() < th.ms("question_out")) {
        window.request_animation_frame();
    }
    let reduce = cx.reduce_motion();
    let w = width(th, view.wide, main_w);
    let focused = !view.closing() && (shell.dialog_focus.contains_focused(window, cx) || shell.reason_focused(&view.key, window, cx));
    // The outgoing question during a switch, else the current one.
    let out_t = view.switch.as_ref().map(|s| s.at.elapsed().as_secs_f32() / th.ms("question_out").as_secs_f32().max(1e-3)).filter(|t| *t < 1.0 && !reduce);
    let (key, active, phase) = match (&view.switch, out_t) {
        (Some(s), Some(t)) => (s.old_key.as_str(), &s.old, Some((t, s.back))),
        _ => (view.key.as_str(), &view.active, None),
    };
    let ui = shell.dialog_uis.get(key)?;
    let c = Ctx { shell, th, key, who, ui, focused, reduce, opened_at: view.opened_at };
    let parts = dialogs::build(&c, active, cx);
    let scroll = shell.doc_scrolls.get(key).cloned().unwrap_or_default();
    let pad = th.px("drawer.padding");
    let shift = th.n("drawer.question_shift");
    let body = if parts.body_fills {
        div().flex_1().min_h_0().p(pad).flex().flex_col().child(parts.body).into_any_element()
    } else {
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .id(SharedString::from(format!("{key}-drawer-body")))
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .on_scroll_wheel(cx.listener(|this, _, _, cx| {
                        this.stop_programmatic_scroll();
                        cx.notify();
                    }))
                    .p(pad)
                    .child(parts.body),
            )
            .children(anim::scroll_fades(th, &scroll, th.c("bg.overlay")))
            .children(parts.overlay)
            .into_any_element()
    };
    // §6.2 switch: the old question leaves (question_out / exit), then the new
    // one enters from the opposite side (question_in / smooth).
    let body = match phase {
        Some((t, back)) => {
            let e = th.curve("exit").at(t);
            let dir = if back { 1. } else { -1. };
            div().flex_1().min_h_0().flex().flex_col().relative().left(px(dir * shift * e)).opacity(1. - e).child(body).into_any_element()
        }
        None if view.switch.is_some() => {
            let back = view.switch.as_ref().is_some_and(|s| s.back);
            let from = if back { -shift } else { shift };
            anim::appear(div().flex_1().min_h_0().flex().flex_col().child(body), format!("{key}-q-in"), th.ms("question_in"), th.ease("smooth"), from, 0.).into_any_element()
        }
        None => body,
    };
    let k = key.to_string();
    let content = div()
        .id(SharedString::from(format!("{key}-focus")))
        .track_focus(&shell.dialog_focus)
        .key_context("GateDialog")
        .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| this.dialog_keystroke(&k, ev, window, cx)))
        .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
            if !this.dialog_focus.contains_focused(window, cx) {
                window.focus(&this.dialog_focus, cx);
            }
        }))
        .w(px(w))
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .relative()
        .left(px(th.n("drawer.content_shift") * (1. - f) * if reduce { 0. } else { 1. }))
        .opacity(f)
        .bg(th.c("bg.overlay"))
        .children(parts.top_bar)
        .child(
            div()
                .h(th.px("drawer.header_height"))
                .flex_none()
                .px(pad)
                .border_b_1()
                .border_color(th.c("border.subtle"))
                .child(parts.header),
        )
        .children(parts.under_header)
        .child(body)
        .children(parts.pinned)
        .child(div().h(th.px("drawer.footer_height")).flex_none().px(pad).flex().items_center().border_t_1().border_color(th.c("border.subtle")).child(parts.footer));
    // The left edge says where the keys go (§5.5): focus colour inside, subtle in the composer.
    let edge = if focused { th.c("border.focus") } else { th.c("border.subtle") };
    let edge = anim::fade_bg(div().w(px(if focused { 1.5 } else { 1. })).h_full().flex_none(), format!("{sid}-edge-{focused}"), th, if focused { th.c("border.subtle") } else { th.c("border.focus") }, edge, "hover");
    let shell_el = div()
        .id(SharedString::from(format!("drawer-{sid}")))
        .h_full()
        .flex_none()
        .w(px((w + 1.5) * if reduce { 1. } else { f }))
        .overflow_hidden()
        .flex()
        .when(reduce, |d| d.opacity(f))
        .child(edge)
        .child(content);
    // The scrim has its own timing (scrim_enter / emphasized, scrim_exit / exit).
    let el = view.open.start.elapsed().as_secs_f32();
    let s = match (reduce || view.open.dur.is_zero(), view.closing()) {
        (true, _) => f,
        (false, false) => th.curve("emphasized").at(el / th.ms("scrim_enter").as_secs_f32()),
        (false, true) => 1. - th.curve("exit").at(el / th.ms("scrim_exit").as_secs_f32()),
    };
    Some((shell_el.into_any_element(), s.clamp(0., 1.)))
}

/// The dimming over the chat stream while a drawer is open (§6.1): no pointer
/// capture (it has no handlers), so the stream still scrolls and selects.
pub fn scrim(th: Th, s: f32) -> AnyElement {
    div().absolute().inset_0().bg(th.c("bg.scrim_drawer")).opacity(s).into_any_element()
}
