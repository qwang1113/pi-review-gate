//! Window chrome: the title bar with the sidebar toggle and its「等你回答」
//! badge (§4.4), and the in-app toasts (§10) — stacked, held while hovered,
//! pushed down by newer ones with `motion.spring.gentle`.

use super::anim;
use super::assets::icon;
use super::chat::text_font;
use super::controls::icon_button;
use super::motion::{Curve, Tween};
use super::theme::heartbeat_scale;
use crate::app::Shell;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::*;
use std::time::{Duration, Instant};

/// Toast height used for stacking (icon row + one body line + padding).
const TOAST_H: f32 = 60.0;

pub struct Toast {
    pub session: Option<String>,
    pub glyph: &'static str,
    pub title: String,
    pub body: String,
    pub id: u64,
    born: Instant,
    /// Time spent hovered (does not count toward `toast_hold`).
    paused: Duration,
    hovered_since: Option<Instant>,
    pub leaving: Option<Instant>,
    /// Stack offset (px from the first slot).
    y: Tween,
}

impl Toast {
    pub fn new(session: Option<String>, glyph: &'static str, title: impl Into<String>, body: impl Into<String>) -> Toast {
        let now = Instant::now();
        Toast { session, glyph, title: title.into(), body: body.into(), id: 0, born: now, paused: Duration::ZERO, hovered_since: None, leaving: None, y: Tween::at_rest(0.0) }
    }

    fn shown_for(&self, now: Instant) -> Duration {
        let hover = self.hovered_since.map_or(Duration::ZERO, |h| now - h);
        (now - self.born).saturating_sub(self.paused + hover)
    }
}

impl Shell {
    /// Show a toast; the oldest beyond `limit.toast.max_visible` starts leaving.
    pub fn toast(&mut self, mut t: Toast) {
        self.toast_seq += 1;
        t.id = self.toast_seq;
        self.toasts.insert(0, t);
        self.restack();
    }

    fn restack(&mut self) {
        let th = self.th;
        let now = Instant::now();
        let max = th.n("limit.toast.max_visible") as usize;
        let step = TOAST_H + th.n("toast.gap");
        let (d, c) = if self.reduce_motion { (Duration::ZERO, Curve::Linear) } else { (th.spring("gentle").duration(), Curve::Spring(th.spring("gentle"))) };
        let mut slot = 0;
        for t in self.toasts.iter_mut() {
            if t.leaving.is_some() {
                continue;
            }
            if slot >= max {
                t.leaving = Some(now);
                continue;
            }
            t.y.retarget(slot as f32 * step, now, d, c);
            slot += 1;
        }
    }

    /// Hold / expire / drop toasts; true while any is on screen.
    pub(crate) fn tick_toasts(&mut self) -> bool {
        let th = self.th;
        let now = Instant::now();
        let mut changed = false;
        for t in self.toasts.iter_mut() {
            if t.leaving.is_none() && t.shown_for(now) > th.ms("toast_hold") {
                t.leaving = Some(now);
                changed = true;
            }
        }
        let before = self.toasts.len();
        self.toasts.retain(|t| t.leaving.is_none_or(|l| now - l < th.ms("toast_exit")));
        if changed || before != self.toasts.len() {
            self.restack();
        }
        !self.toasts.is_empty()
    }

    fn hover_toast(&mut self, id: u64, on: bool) {
        let now = Instant::now();
        if let Some(t) = self.toasts.iter_mut().find(|t| t.id == id) {
            match (on, t.hovered_since) {
                (true, None) => t.hovered_since = Some(now),
                (false, Some(h)) => {
                    t.paused += now - h;
                    t.hovered_since = None;
                }
                _ => {}
            }
        }
    }
}

/// The toasts, top-right of the main area; `right` keeps them off an open drawer.
pub fn toasts(shell: &Shell, right: Pixels, window: &mut Window, cx: &mut Context<Shell>) -> Vec<AnyElement> {
    let th = shell.th;
    let now = Instant::now();
    let reduce = cx.reduce_motion();
    let top = th.px("titlebar.height") + th.sp(2);
    let mut out = vec![];
    for t in &shell.toasts {
        if t.y.running(now) || t.leaving.is_some() {
            window.request_animation_frame();
        }
        let exit = t.leaving.map(|l| th.curve("exit").at((now - l).as_secs_f32() / th.ms("toast_exit").as_secs_f32()));
        let target = t.session.clone();
        let id = t.id;
        let el = div()
            .id(ElementId::Name(format!("toast-{id}").into()))
            .w(th.px("toast.width"))
            .h(px(TOAST_H))
            .p(th.sp(3))
            .flex()
            .gap(th.sp(3))
            .rounded(th.r("lg"))
            .bg(th.c("bg.overlay"))
            .border_1()
            .border_color(th.c("border.default"))
            .shadow(th.shadow("low"))
            .cursor_pointer()
            .child(icon(t.glyph, px(16.), th.c(match t.glyph {
                "check" => "semantic.success",
                "circle-alert" => "semantic.warning",
                _ => "accent.primary",
            })))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .child(text_font(th, div(), "body_strong").text_color(th.c("text.primary")).truncate().child(t.title.clone()))
                    .child(text_font(th, div(), "small").text_color(th.c("text.secondary")).truncate().child(t.body.lines().next().unwrap_or("").to_string())),
            )
            .on_hover(cx.listener(move |this, on: &bool, _, cx| {
                this.hover_toast(id, *on);
                cx.notify();
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.toasts.retain(|t| t.id != id);
                if target.is_some() {
                    this.select(target.clone(), window, cx);
                }
                cx.notify();
            }));
        let el = match exit {
            Some(e) => el.opacity(1. - e).relative().top(px(if reduce { 0. } else { -4. * e })).into_any_element(),
            None => anim::appear(el, format!("toast-in-{id}"), th.ms("toast"), th.ease("smooth"), 0., if reduce { 0. } else { -8. }).into_any_element(),
        };
        out.push(div().absolute().top(top + px(t.y.value(now))).right(right + th.sp(4)).child(el).into_any_element());
    }
    out
}

/// The title bar (§1, §4.4): drag area, the sidebar toggle at `titlebar.toggle_x`
/// with the waiting badge while the list is hidden, the session title.
pub fn titlebar(shell: &Shell, name: &str, waiting: usize, sidebar_hidden: bool, cx: &mut Context<Shell>) -> Div {
    let th = shell.th;
    let reduce = cx.reduce_motion();
    let tip = if sidebar_hidden { "展开侧栏 ⌘B" } else { "收起侧栏 ⌘B" };
    let badge = (sidebar_hidden && waiting > 0).then(|| {
        let color = th.c("status.waiting_input");
        let el = if waiting >= 2 {
            text_font(th, div(), "caption")
                .h(th.px("titlebar.badge_pill_height"))
                .min_w(th.px("titlebar.badge_pill_height"))
                .px(px(4.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(th.r("full"))
                .bg(color)
                .text_color(th.c("text.on_accent"))
                .child(waiting.to_string())
                .into_any_element()
        } else if reduce {
            // Reduced motion: the static double ring instead of the heartbeat (§11.3).
            div().size(px(12.)).rounded(th.r("full")).border(px(1.5)).border_color(color).flex().items_center().justify_center().child(div().size(px(6.)).rounded(th.r("full")).bg(color)).into_any_element()
        } else {
            let d = th.n("unread_dot");
            div()
                .size(px(d))
                .rounded(th.r("full"))
                .bg(color)
                .with_animation("toggle-beat", Animation::new(th.ms("pulse_waiting_input")).repeat().with_max_fps(super::LOOP_FPS), move |el, t| el.size(px(d * heartbeat_scale(t))))
                .into_any_element()
        };
        div().absolute().top(px(-3.)).right(px(-3.)).child(el)
    });
    let toggle = icon_button(th, "sidebar-toggle", "panel-left", reduce)
        .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
        .on_click(cx.listener(|this, _, _, cx| this.toggle_sidebar(cx)));
    div()
        .relative()
        .h(th.px("titlebar.height"))
        .flex_none()
        .flex()
        .items_center()
        .pl(th.px("titlebar.title_x"))
        .bg(th.c("bg.surface"))
        .border_b_1()
        .border_color(th.c("border.subtle"))
        .window_control_area(WindowControlArea::Drag)
        .child(div().absolute().left(th.px("titlebar.toggle_x")).top((th.px("titlebar.height") - th.px("titlebar.button")) / 2.).child(div().relative().child(toggle).children(badge)))
        .child(text_font(th, div(), "body_strong").text_color(th.c("text.primary")).child(name.to_string()))
}
