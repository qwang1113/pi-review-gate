//! The session list (§4): grouped rows with role icons, animated status dots,
//! unread marks and the dead/idle distinction; the 52 px icon rail below the
//! breakpoint or after ⌘B; the drag handle.

use super::assets::icon;
use super::chat::text_font;
use super::sidebar_model::{Group, GroupRows, Row, Status};
use super::theme::{Th, heartbeat_scale};
use crate::app::Shell;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

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
        _ => slot().child(dot(d, 1.0)).into_any_element(),
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
    let name_color = if dead { th.c("text.secondary") } else if selected { th.c("text.primary") } else { th.c("text.secondary") };
    let id = row.id.clone();
    let note = waiting_note(row);
    let mut el = div()
        .id(SharedString::from(format!("row-{}", row.id)))
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
        .when(!selected, |d| d.hover(|s| s.bg(th.c("bg.elevated")).text_color(th.c("text.primary"))))
        .active(|s| s.bg(th.c("border.subtle")))
        .when(selected, |d| d.bg(th.c("accent.subtle")))
        .child(role_icon(th, row, th.c("text.secondary"), reduce))
        .child(
            text_font(th, div(), if bold { "body_strong" } else { "body" })
                .flex_1()
                .min_w_0()
                .truncate()
                .when(dead, |d| d.text_color(th.c("text.secondary")))
                .child(row.name.clone()),
        )
        .when(row.unread && !selected, |d| d.child(div().size(th.px("unread_dot")).rounded(th.r("full")).bg(th.c("accent.primary")).flex_none()))
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
    if selected {
        el = el.child(
            div().absolute().left_0().top_0().bottom_0().flex().items_center().child(div().w(px(3.)).h_full().rounded(th.r("xs")).bg(th.c("accent.primary")).with_animation(
                ElementId::Name(format!("sel-{}-{}", row.id, shell.switch_seq).into()),
                Animation::new(th.ms("sidebar_select")).with_easing(th.ease("standard")),
                |d, t| d.h(relative(t)),
            )),
        );
    }
    if let Some(note) = note {
        el = el.tooltip(move |window, cx| Tooltip::new(note.clone()).build(window, cx));
    }
    // Guide line for nested rows (§4.1).
    if visual_depth > 0 {
        return div()
            .relative()
            .child(div().absolute().top_0().bottom_0().left(px(th.n("sidebar.child_indent") * visual_depth as f32 - 12.)).w(px(1.)).bg(th.c("border.default")))
            .child(el)
            .into_any_element();
    }
    el.into_any_element()
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

fn rail(th: Th, groups: &[GroupRows], selected: Option<&str>, cx: &mut Context<Shell>) -> Div {
    let reduce = cx.reduce_motion();
    let mut col = div().flex().flex_col().items_center().gap(th.sp(1)).pt(th.sp(2));
    for row in groups.iter().flat_map(|g| &g.rows) {
        let id = row.id.clone();
        let is_sel = selected == Some(row.id.as_str());
        let card = format!("{} · {}{}", row.name, row.status.label(), if row.unread { " · 未读" } else { "" });
        col = col.child(
            div()
                .id(SharedString::from(format!("rail-{}", row.id)))
                .size(px(36.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(th.r("md"))
                .cursor_pointer()
                .when(is_sel, |d| d.bg(th.c("accent.subtle")))
                .when(!is_sel, |d| d.hover(|s| s.bg(th.c("bg.elevated"))))
                .child(role_icon(th, row, th.c(if is_sel { "text.primary" } else { "text.secondary" }), reduce))
                .tooltip(move |window, cx| Tooltip::new(card.clone()).build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| this.select(Some(id.clone()), window, cx))),
        );
    }
    col
}

pub fn render_sidebar(shell: &Shell, groups: &[GroupRows], is_rail: bool, cx: &mut Context<Shell>) -> AnyElement {
    let th = shell.th;
    let selected = shell.hub.lock().focused.clone();
    let body = if is_rail {
        rail(th, groups, selected.as_deref(), cx).into_any_element()
    } else {
        let mut col = div().flex().flex_col().px(th.sp(2)).pb(th.sp(2));
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
        col.into_any_element()
    };
    let width = if is_rail { th.px("sidebar.rail_width") } else { px(shell.sidebar_w) };
    div()
        .relative()
        .w(width)
        .h_full()
        .flex_none()
        .bg(th.c("bg.surface"))
        .border_r_1()
        .border_color(th.c("border.subtle"))
        .child(div().id("sidebar-scroll").size_full().overflow_y_scroll().child(body))
        .when(!is_rail, |d| {
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
        .into_any_element()
}
