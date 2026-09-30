//! The session list (§4): grouped rows with role icons, animated status dots,
//! unread marks and the dead/idle distinction, the sliding selection, the drag
//! handle; fully collapsible (§4.4) — pushing in wide windows, an overlay
//! drawer below the breakpoint.

use super::anim;
use super::assets::icon;
use super::chat::text_font;
use super::motion::{Curve, Tween, sidebar_content};
use super::sidebar_model::{Group, GroupRows, Row, RowSlot, Status};
use super::sidebar_state::{Timing, state_file};
use super::theme::{Th, heartbeat_scale};
use crate::app::Shell;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::time::Instant;

impl Shell {
    pub(crate) fn sidebar_timing(&self) -> Timing {
        let th = self.th;
        Timing {
            toggle: th.ms("sidebar_toggle"),
            enter: th.ms("drawer_enter"),
            exit: th.ms("drawer_exit"),
            smooth: th.curve("smooth"),
            exit_curve: th.curve("exit"),
            reduce: self.reduce_motion,
            fade: th.ms("reduced_motion_fade"),
        }
    }

    /// The collapsed choice and the width survive a restart (§4.4); the demo never writes.
    pub(crate) fn save_sidebar(&self) {
        if self.demo {
            return;
        }
        if let Some(p) = state_file() {
            let _ = p.parent().map(std::fs::create_dir_all);
            let _ = std::fs::write(p, self.sidebar.to_json());
        }
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        let t = self.sidebar_timing();
        self.sidebar.toggle(Instant::now(), &t);
        self.save_sidebar();
        cx.notify();
    }

    pub fn close_sidebar_overlay(&mut self, cx: &mut Context<Self>) {
        let t = self.sidebar_timing();
        self.sidebar.close_overlay(Instant::now(), &t);
        cx.notify();
    }
}

/// The selection highlight, one block that slides between rows (§4.3).
#[derive(Default)]
pub struct SelSlide {
    pub id: Option<String>,
    pub group: Option<Group>,
    pub y: Option<Tween>,
    pub x: Option<Tween>,
    /// Bumped when the block jumps instead of sliding (it fades in).
    pub seq: u64,
}

impl SelSlide {
    /// Follow the selected row: slide within a group, jump (and fade) across.
    pub fn follow(&mut self, slot: Option<&RowSlot>, indent: f32, th: Th, reduce: bool) {
        let Some(slot) = slot else {
            self.id = None;
            return;
        };
        if self.id.as_deref() == Some(slot.id.as_str()) {
            return;
        }
        let now = Instant::now();
        let x = indent * slot.depth as f32;
        let slide = !reduce && self.id.is_some() && self.group == Some(slot.group);
        match (&mut self.y, &mut self.x, slide) {
            (Some(y), Some(xt), true) => {
                let s = th.spring("gentle");
                y.retarget(slot.y, now, s.duration(), Curve::Spring(s));
                xt.retarget(x, now, s.duration(), Curve::Spring(s));
            }
            _ => {
                self.y = Some(Tween::at_rest(slot.y));
                self.x = Some(Tween::at_rest(x));
                self.seq += 1;
            }
        }
        self.id = Some(slot.id.clone());
        self.group = Some(slot.group);
    }
}

const DOT_SLOT: f32 = 12.0;

/// The status dot, or the dead cross (§4.2). Sized inside a fixed slot so the
/// pulses never shift the row.
pub fn status_dot(th: Th, id: &str, s: Status, reduce: bool) -> AnyElement {
    let d = th.n("status_dot");
    let color = th.c(s.token());
    let slot = || div().size(px(DOT_SLOT)).flex().items_center().justify_center().flex_none();
    let dot = move |size: f32, alpha: f32| div().size(px(size)).rounded(th.r("full")).bg(color.opacity(alpha));
    match s {
        Status::Dead => slot().child(icon("circle-x", px(DOT_SLOT), color)).into_any_element(),
        Status::Idle => slot().child(div().size(px(d)).rounded(th.r("full")).border(px(1.5)).border_color(color)).into_any_element(),
        Status::WaitingInput if reduce => slot()
            .child(div().size(px(DOT_SLOT)).rounded(th.r("full")).border(px(1.5)).border_color(color).flex().items_center().justify_center().child(dot(6.0, 1.0)))
            .into_any_element(),
        Status::Working if !reduce => slot()
            .child(dot(d, 1.0).with_animation(
                ElementId::Name(format!("pulse-{id}").into()),
                Animation::new(th.ms("pulse_working")).repeat().with_max_fps(super::LOOP_FPS).with_easing(th.ease("pulse")),
                move |el, t| {
                    // 0 → 1 → 0 over one period.
                    let k = 1.0 - (2.0 * t - 1.0).abs();
                    el.size(px(d * (0.92 + 0.16 * k))).bg(color.opacity(0.5 + 0.5 * k))
                },
            ))
            .into_any_element(),
        Status::WaitingInput => slot()
            .child(dot(d, 1.0).with_animation(
                ElementId::Name(format!("beat-{id}").into()),
                Animation::new(th.ms("pulse_waiting_input")).repeat().with_max_fps(super::LOOP_FPS),
                move |el, t| el.size(px(d * heartbeat_scale(t))),
            ))
            .into_any_element(),
        // Settling into done: the colour fades in and the dot pops 6 → 8 (§11.1).
        Status::Done => slot().child(anim::pop_size(dot(6.0, 1.0), format!("dot-{id}-done"), th, 6.0, d)).into_any_element(),
        _ => slot().child(anim::appear(dot(d, 1.0), format!("dot-{id}-{}", s.label()), th.ms("dot_color"), th.ease("standard"), 0., 0.)).into_any_element(),
    }
}

fn role_icon(th: Th, row: &Row, color: Hsla, reduce: bool) -> Div {
    div()
        .relative()
        .size(px(16.))
        .flex_none()
        .child(icon(row.icon, px(16.), color))
        .child(div().absolute().right(px(-4.)).bottom(px(-4.)).child(status_dot(th, &row.id, row.status, reduce)))
}

fn waiting_note(row: &Row) -> Option<String> {
    let since = row.state_at?;
    let now = crate::hub::now_ms() / 1000;
    (row.status == Status::WaitingJudge).then(|| format!("在等 judge，已等 {}s", now.saturating_sub(since)))
}

fn row_el(shell: &Shell, th: Th, row: &Row, visual_depth: usize, selected: bool, cx: &mut Context<Shell>) -> AnyElement {
    let reduce = cx.reduce_motion();
    let dead = row.status == Status::Dead;
    let bold = row.status == Status::WaitingInput;
    let hover_id = format!("row-{}", row.id);
    let hovered = !selected && shell.hovered.as_deref() == Some(hover_id.as_str());
    let name_color = if dead { th.c("text.secondary") } else if selected || hovered { th.c("text.primary") } else { th.c("text.secondary") };
    let id = row.id.clone();
    let note = waiting_note(row);
    let el = div()
        .id(SharedString::from(hover_id.clone()))
        .relative()
        .h(th.px("sidebar.item_height"))
        .ml(px(th.n("sidebar.child_indent") * visual_depth as f32))
        .px(th.sp(2))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .rounded(th.r("md"))
        .cursor_pointer()
        .text_color(name_color)
        .on_hover(cx.listener(move |this, h: &bool, _, cx| this.set_hovered(&hover_id, *h, cx)))
        .child(role_icon(th, row, th.c("text.secondary"), reduce))
        .child(
            text_font(th, div(), if bold { "body_strong" } else { "body" })
                .flex_1()
                .min_w_0()
                .truncate()
                .when(dead, |d| d.text_color(th.c("text.secondary")))
                .child(row.name.clone()),
        )
        .when(row.unread && !selected, |d| {
            let dot = div().size(th.px("unread_dot")).rounded(th.r("full")).bg(th.c("accent.primary")).flex_none();
            d.child(anim::pop_size(dot, format!("unread-{}", row.id), th, 0.0, th.n("unread_dot")))
        })
        .when(dead, |d| {
            d.child(
                text_font(th, div(), "caption")
                    .px(px(6.))
                    .rounded(th.r("sm"))
                    .bg(th.c("button.danger.bg"))
                    .text_color(th.c("button.danger.text"))
                    .child("dead"),
            )
        })
        .on_click(cx.listener(move |this, _, window, cx| this.select(Some(id.clone()), window, cx)));
    let el = anim::press(el, th, Some("border.subtle"), reduce).when_some(note, |el, note| el.tooltip(move |window, cx| Tooltip::new(note.clone()).build(window, cx)));
    // Hover in and out cross-fade (`hover` / `standard`); the selected row is painted by the slide block.
    let hover_key = format!("row-{}", row.id);
    let recent = shell.stamps.running(&format!("hover-{hover_key}"), th.ms("hover"));
    let el = if selected { el.into_any_element() } else { anim::state_bg(el, &hover_key, th, hovered, th.c("bg.elevated"), th.ca("bg.elevated", 0.), recent, "hover") };
    // Guide line for nested rows (§4.1).
    if visual_depth > 0 {
        return div()
            .relative()
            .child(div().absolute().top_0().bottom_0().left(px(th.n("sidebar.child_indent") * visual_depth as f32 - 12.)).w(px(1.)).bg(th.c("border.default")))
            .child(el)
            .into_any_element();
    }
    el
}

fn group_header(th: Th, g: &GroupRows, collapsed: bool, cx: &mut Context<Shell>) -> Stateful<Div> {
    let group = g.group;
    let muted = th.c("text.muted");
    div()
        .id(SharedString::from(format!("group-{}", g.group.title())))
        .h(th.px("sidebar.group_header_height"))
        .px(th.sp(2))
        .mt(th.sp(2))
        .flex()
        .items_center()
        .gap(th.sp(1))
        .cursor_pointer()
        .text_color(muted)
        .child(super::chat::chevron(th, format!("grp-{}", g.group.title()).into(), !collapsed, px(10.), muted))
        .child(text_font(th, div(), "caption").font_weight(FontWeight(600.)).flex_1().child(g.group.title().to_uppercase()))
        .when(collapsed && g.waiting_input, |d| d.child(div().size(px(6.)).rounded(th.r("full")).bg(th.c("status.waiting_input"))))
        .child(text_font(th, div(), "caption").px(px(6.)).rounded(th.r("full")).bg(th.c("bg.elevated")).child(format!("{}/{}", g.active, g.rows.len())))
        .on_click(cx.listener(move |this, _, _, cx| {
            if !this.collapsed_groups.remove(&group) {
                this.collapsed_groups.insert(group);
            }
            cx.notify();
        }))
}

/// The selection block under the selected row (§4.3): accent fill + 3 px bar.
fn selection(shell: &Shell, th: Th, window: &mut Window) -> Option<AnyElement> {
    let sel = &shell.sel;
    sel.id.as_ref()?;
    let now = Instant::now();
    let (y, x) = (sel.y?, sel.x?);
    if y.running(now) || x.running(now) {
        window.request_animation_frame();
    }
    let block = div()
        .absolute()
        .top(px(y.value(now)))
        .left(th.sp(2) + px(x.value(now)))
        .right(th.sp(2))
        .h(th.px("sidebar.item_height"))
        .rounded(th.r("md"))
        .bg(th.c("accent.subtle"))
        .child(div().absolute().left_0().top_0().bottom_0().w(px(3.)).rounded(th.r("xs")).bg(th.c("accent.primary")));
    Some(anim::appear(block, format!("sel-{}", sel.seq), th.ms("sidebar_select"), th.ease("standard"), 0., 0.).into_any_element())
}

/// The list itself, laid out at the sidebar's full width (it never reflows
/// while the sidebar animates — the container clips it).
fn list(shell: &Shell, th: Th, groups: &[GroupRows], window: &mut Window, cx: &mut Context<Shell>) -> Div {
    let selected = shell.hub.lock().focused.clone();
    let mut col = div().relative().flex().flex_col().px(th.sp(2)).pb(th.sp(2)).children(selection(shell, th, window));
    for g in groups {
        let collapsed = shell.collapsed_groups.contains(&g.group);
        col = col.child(group_header(th, g, collapsed, cx));
        if collapsed {
            continue;
        }
        let extra = usize::from(g.group != Group::Sessions);
        for row in &g.rows {
            col = col.child(row_el(shell, th, row, row.depth + extra, selected.as_deref() == Some(row.id.as_str()), cx));
        }
    }
    col
}

/// The list's content at animated width `w` (§4.4): faded and slid left as it narrows.
fn content(shell: &Shell, th: Th, groups: &[GroupRows], full: f32, w: f32, window: &mut Window, cx: &mut Context<Shell>) -> Div {
    let (opacity, x) = sidebar_content(w, th.n("sidebar.fade_span"), th.n("sidebar.slide_span"), th.n("sidebar.slide_offset"));
    let x = if cx.reduce_motion() { 0. } else { x };
    div()
        .w(px(full))
        .h_full()
        .flex_none()
        .relative()
        .left(px(x))
        .opacity(opacity)
        .child(div().id("sidebar-scroll").size_full().overflow_y_scroll().child(list(shell, th, groups, window, cx)))
}

/// The pushing sidebar in a wide window (0 px wide when collapsed).
pub fn render_sidebar(shell: &Shell, groups: &[GroupRows], window: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let th = shell.th;
    let now = Instant::now();
    let w = shell.sidebar.push.value(now).max(0.);
    if shell.sidebar.push.running(now) {
        window.request_animation_frame();
    }
    if w <= 0. {
        return None;
    }
    let settled = !shell.sidebar.push.running(now) && shell.sidebar.push.to > 0.;
    Some(
        div()
            .relative()
            .w(px(w))
            .h_full()
            .flex_none()
            .bg(th.c("bg.surface"))
            .border_r_1()
            .border_color(th.c("border.subtle"))
            .child(div().size_full().overflow_hidden().child(content(shell, th, groups, shell.sidebar.width, w, window, cx)))
            .when(settled, |d| {
                d.child(
                    div()
                        .id("sidebar-resize")
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(px(-th.n("sidebar.resize_hit") / 2.))
                        .w(th.px("sidebar.resize_hit"))
                        .flex()
                        .justify_center()
                        .cursor_col_resize()
                        .child(div().w(th.px("sidebar.resize_handle")).h_full().when(shell.dragging, |d| d.bg(th.c("border.focus"))))
                        .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                            this.dragging = true;
                            cx.notify();
                        })),
                )
            })
            .into_any_element(),
    )
}

/// The overlay drawer in a narrow window (§4.4): slides in over a scrim;
/// a click on the scrim closes it.
pub fn render_overlay(shell: &Shell, groups: &[GroupRows], window: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let th = shell.th;
    let now = Instant::now();
    let f = shell.sidebar.slide.value(now).clamp(0., 1.);
    if shell.sidebar.slide.running(now) {
        window.request_animation_frame();
    }
    if f <= 0. || !shell.sidebar.narrow {
        return None;
    }
    let reduce = cx.reduce_motion();
    let w = th.n("sidebar.width_default");
    let left = if reduce { 0. } else { -w * (1. - f) };
    let panel = div()
        .id("sidebar-overlay")
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(left))
        .w(px(w))
        .bg(th.c("bg.surface"))
        .shadow(th.shadow("high"))
        .when(reduce, |d| d.opacity(f))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(content(shell, th, groups, w, if reduce { w } else { w * f }, window, cx));
    let scrim = div()
        .id("sidebar-scrim")
        .absolute()
        .inset_0()
        .bg(th.c("bg.scrim"))
        .opacity(f)
        .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
            this.close_sidebar_overlay(cx);
        }));
    Some(div().absolute().inset_0().child(scrim).child(panel).into_any_element())
}
