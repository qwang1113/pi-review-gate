//! What goes inside the right drawer (§6.2–6.7): the gate's single choice,
//! reason editor, checklist and long-text confirm, and pi's own select /
//! input / confirm / editor. Each builder returns `Parts`; `drawer.rs` puts
//! them in the shell (width, entrance, header, body scroll, footer).

use super::anim;
use super::assets::icon;
use super::chat::{markdown_style, text_font};
use super::controls::{Btn, badge, button, ring};
use super::dialog_state::{DialogUi, DocKind, Key, Kind, Row, doc_kind, progress_of, question_of};
use super::theme::Th;
use crate::app::{ActiveDialog, Shell};
use crate::rpc::UiRequest;
use gpui_kit::component::input::Textarea;
use gpui_kit::component::text::TextView;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::time::Instant;

const LETTERS: [&str; 16] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

/// The drawer's regions for one dialog (§6.1 structure, top to bottom).
pub struct Parts {
    pub header: AnyElement,
    /// At the drawer's top edge: the N/M segments or a timeout countdown.
    pub top_bar: Option<AnyElement>,
    /// Under the header: the long box's reading progress.
    pub under_header: Option<AnyElement>,
    pub body: AnyElement,
    /// The body is an editor that fills the height (no scroll wrapper).
    pub body_fills: bool,
    /// Absolute over the body's bottom edge (the unread pill).
    pub overlay: Option<AnyElement>,
    /// Between body and footer, not scrolling (the long box's reason area).
    pub pinned: Option<AnyElement>,
    pub footer: AnyElement,
}

/// Everything a builder needs besides the dialog itself.
pub struct Ctx<'a> {
    pub shell: &'a Shell,
    pub th: Th,
    pub key: &'a str,
    pub who: &'a str,
    pub ui: &'a DialogUi,
    pub focused: bool,
    pub reduce: bool,
    pub opened_at: Instant,
}

pub fn build(c: &Ctx, active: &ActiveDialog, cx: &mut Context<Shell>) -> Parts {
    match active {
        ActiveDialog::Gate(p) => {
            let body = match p {
                crate::protocol::DialogParams::Choice { body, .. } | crate::protocol::DialogParams::Multi { body, .. } => body.as_deref(),
            };
            match body.filter(|_| c.ui.long) {
                Some(doc) => long_confirm(c, p.title(), doc, cx),
                None => choice(c, p.title(), body, cx),
            }
        }
        ActiveDialog::Native(req) => native(c, req, cx),
    }
}

/// Whether this dialog takes the wide drawer (§6.1).
pub fn is_wide(active: &ActiveDialog, ui: Option<&DialogUi>) -> bool {
    match active {
        ActiveDialog::Gate(_) => ui.is_some_and(|u| u.long),
        ActiveDialog::Native(r) => matches!(r, UiRequest::Editor { .. }),
    }
}

fn segments(th: Th, n: usize, m: usize) -> AnyElement {
    let bar = |i: usize| div().flex_1().h_full().bg(th.c(if i <= n { "accent.primary" } else { "border.subtle" }));
    let el = div().flex().gap(th.px("dialog.progress_gap")).w_full().h(th.px("dialog.progress_height")).children((1..=m).map(|i| {
        // The segment that just turned on eases in over `question_in`.
        if i == n {
            anim::fade_bg(bar(i), format!("seg-{n}-{m}"), th, th.c("border.subtle"), th.c("accent.primary"), "question_in").into_any_element()
        } else {
            bar(i).into_any_element()
        }
    }));
    el.into_any_element()
}

fn header(th: Th, glyph: &'static str, title: String, prog: Option<(usize, usize)>) -> AnyElement {
    text_font(th, div(), "base")
        .size_full()
        .flex()
        .items_center()
        .gap(th.sp(2))
        .font_weight(FontWeight(600.))
        .text_color(th.c("text.primary"))
        .child(icon(glyph, px(18.), th.c("accent.primary")))
        .child(div().flex_1().min_w_0().truncate().child(title))
        .when_some(prog, |d, (n, m)| d.child(text_font(th, div(), "small").flex_none().text_color(th.c("text.muted")).child(format!("第 {n} / {m} 题"))))
        .into_any_element()
}

fn hint(th: Th, text: &str) -> AnyElement {
    text_font(th, div(), "small").w_full().text_right().text_color(th.c("text.muted")).child(text.to_string()).into_any_element()
}

fn mark(c: &Ctx, i: usize, multi: bool, on: bool, row_focused: bool) -> AnyElement {
    let th = c.th;
    if !multi {
        let color = th.c(if on { "accent.primary" } else { "text.secondary" });
        return icon(if on { "circle-dot" } else { "circle" }, px(16.), color).into_any_element();
    }
    let boxed = || div().size(th.px("checkbox")).flex_none().rounded(th.r("sm")).flex().items_center().justify_center();
    let stamp = format!("chk-{}-{i}", c.key);
    let recent = !c.reduce && c.shell.stamps.running(&stamp, th.spring("snappy").duration());
    let check = |size: AnyElement| boxed().bg(th.c("accent.primary")).child(size);
    match (on, recent) {
        (true, true) => check(anim::pop_size(icon("check", px(0.), th.c("text.on_accent")), format!("{stamp}-on-{}", c.ui.reason_flips), th, 0.0, 12.0).into_any_element()).into_any_element(),
        (true, false) => check(icon("check", px(12.), th.c("text.on_accent")).into_any_element()).into_any_element(),
        (false, true) => {
            // Unchecking: the tick shrinks away while the fill fades back.
            let t = c.shell.stamps.progress(&stamp, th.spring("snappy").duration(), super::motion::Curve::Spring(th.spring("snappy")));
            boxed()
                .bg(anim::mix(th.c("accent.primary"), th.c("bg.surface"), t))
                .border(px(1.5))
                .border_color(th.c("border.strong"))
                .child(icon("check", px(12. * (1. - t).max(0.)), th.c("text.on_accent")))
                .into_any_element()
        }
        (false, false) => boxed().border(px(1.5)).border_color(th.c(if row_focused { "text.primary" } else { "border.strong" })).into_any_element(),
    }
}

/// One option row (§6.2, §6.7). `letters` is off for pi's own select.
fn option_row(c: &Ctx, i: usize, letters: bool, cx: &mut Context<Shell>) -> AnyElement {
    let th = c.th;
    let ui = c.ui;
    let focused = ui.focus == Row::Option(i) && c.focused;
    let multi = ui.kind == Kind::Multi;
    let on = if multi { ui.checked.get(i).copied().unwrap_or(false) } else { ui.selected == Some(i) };
    let picked = on && !multi;
    let id = format!("{}-opt-{i}", c.key);
    let hovered = c.shell.hovered.as_deref() == Some(id.as_str()) && !ui.answered;
    let hot = focused || hovered;
    let recent = [format!("hover-{id}"), format!("focus-{}", c.key)].iter().any(|s| c.shell.stamps.running(s, th.ms("choice_hover")));
    let k = c.key.to_string();
    let hover_id = id.clone();
    let row = div()
        .id(SharedString::from(id.clone()))
        .min_h(th.px("choice.row_min_height"))
        .px(th.sp(3))
        .py(px(10.))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .rounded(th.r("lg"))
        .cursor_pointer()
        .border(px(if focused || picked { 1.5 } else { 1. }))
        .border_color(th.c(if picked {
            "accent.primary"
        } else if focused {
            "border.focus"
        } else if hovered {
            "border.default"
        } else {
            "border.subtle"
        }))
        .when(focused, |d| d.shadow(vec![ring(th)]))
        .child(mark(c, i, multi, on, focused))
        .when(letters, |d| {
            d.child(text_font(th, div(), "body_strong").w(px(20.)).flex_none().text_color(th.c(if on { "accent.primary" } else { "text.secondary" })).child(format!("{}.", LETTERS.get(i).unwrap_or(&"?"))))
        })
        .child(text_font(th, div(), "body").flex_1().text_color(th.c(if ui.answered { "text.disabled" } else { "text.primary" })).child(ui.options[i].clone()))
        .when(ui.recommended() == Some(i), |d| d.child(badge(th, "badge.rec", "（推荐）")))
        .on_hover(cx.listener(move |this, h: &bool, _, cx| this.set_hovered(&hover_id, *h, cx)))
        .on_click(cx.listener(move |this, _, window, cx| {
            if multi {
                this.dialog_toggle(&k, i, cx);
            } else {
                this.dialog_activate(&k, Row::Option(i), window, cx);
            }
        }));
    let row = anim::press(row, th, Some("border.subtle"), c.reduce);
    if picked {
        return row.bg(th.c("accent.subtle")).into_any_element();
    }
    anim::state_bg(row, &id, th, hot, th.c("bg.elevated"), th.c("bg.surface"), recent, "choice_hover")
}

fn extra_row(c: &Ctx, row: Row, cx: &mut Context<Shell>) -> AnyElement {
    let th = c.th;
    let focused = c.ui.focus == row && c.focused;
    let (glyph, label, dashed) = match row {
        Row::Decline => ("pencil", c.ui.decline.clone().unwrap_or_default(), true),
        _ => ("arrow-left", "返回上一题".to_string(), false),
    };
    let k = c.key.to_string();
    let el = div()
        .id(SharedString::from(format!("{}-{}", c.key, if dashed { "decline" } else { "back" })))
        .min_h(th.px("choice.row_min_height"))
        .px(th.sp(3))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .rounded(th.r("lg"))
        .cursor_pointer()
        .text_color(th.c("text.secondary"))
        .when(dashed, |d| d.border_1().border_dashed().border_color(th.c(if focused { "border.focus" } else { "border.default" })))
        .when(focused, |d| d.bg(th.c("bg.elevated")).shadow(vec![ring(th)]))
        .hover(move |s| s.bg(th.c("bg.elevated")).text_color(th.c("text.primary")))
        .child(icon(glyph, px(16.), th.c("text.secondary")))
        .child(text_font(th, div(), "body").child(label.trim_start_matches(['✎', '←', ' ']).to_string()))
        .on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, row, window, cx)));
    anim::press(el, th, Some("border.subtle"), c.reduce).into_any_element()
}

fn rows(c: &Ctx, letters: bool, cx: &mut Context<Shell>) -> Div {
    let mut col = div().flex().flex_col().gap(th_gap(c.th));
    for i in 0..c.ui.options.len() {
        col = col.child(option_row(c, i, letters, cx));
    }
    for extra in c.ui.rows().into_iter().filter(|r| !matches!(r, Row::Option(_))) {
        col = col.child(extra_row(c, extra, cx));
    }
    col
}

fn th_gap(th: Th) -> Pixels {
    th.px("choice.row_gap")
}

fn editor_box(c: &Ctx, min: &str, fills: bool) -> Div {
    let th = c.th;
    let editor = c.shell.reason_editors.get(c.key).cloned();
    text_font(th, div(), "body")
        .when(!fills, |d| d.min_h(th.px(min)).max_h(th.px("reason_editor.max_height")))
        .when(fills, |d| d.flex_1().min_h_0())
        .p(px(10.))
        .rounded(th.r("md"))
        .bg(th.c("bg.app"))
        .border(px(1.5))
        .border_color(th.c("border.focus"))
        .shadow(vec![ring(th)])
        .when_some(editor, |d, e| d.child(Textarea::new(&e).appearance(false).h_full()))
}

/// pi `input`: one line, `button.height` tall (§6.6).
fn line_box(c: &Ctx) -> Div {
    let th = c.th;
    let editor = c.shell.reason_editors.get(c.key).cloned();
    text_font(th, div(), "body")
        .h(th.px("button.height"))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(th.r("md"))
        .bg(th.c("bg.app"))
        .border(px(1.5))
        .border_color(th.c("border.focus"))
        .shadow(vec![ring(th)])
        .when_some(editor, |d, e| d.child(div().flex_1().child(Textarea::new(&e).appearance(false))))
}

/// The list ↔ editor swap (§6.3): the incoming side rises / drops `reason_shift`.
fn swap_in(c: &Ctx, el: Div, down: bool) -> AnyElement {
    let th = c.th;
    let dy = th.n("drawer.reason_shift") * if down { 1. } else { -1. };
    anim::appear(el, format!("{}-swap-{}", c.key, c.ui.reason_flips), th.ms("reason_in"), th.ease("smooth"), 0., dy).into_any_element()
}

fn choice(c: &Ctx, title: &str, body: Option<&str>, cx: &mut Context<Shell>) -> Parts {
    let th = c.th;
    let prog = progress_of(title).filter(|(_, m)| *m > 1);
    let question = question_of(title).to_string();
    let multi = c.ui.kind == Kind::Multi;
    let text = match body {
        Some(b) if !b.trim().is_empty() => format!("{question}\n\n{b}"),
        _ => question.clone(),
    };
    let (body_el, footer) = if c.ui.reason_open {
        let el = div()
            .flex()
            .flex_col()
            .gap(th.sp(3))
            .child(text_font(th, div(), "body").text_color(th.c("text.secondary")).child(question))
            .child(editor_box(c, "reason_editor.min_height", false));
        (swap_in(c, el, true), hint(th, "⌘Enter 提交 · Esc 返回选项（保留已输入）"))
    } else {
        let el = div()
            .flex()
            .flex_col()
            .gap(th.sp(4))
            .child(TextView::markdown(ElementId::Name(format!("{}-md", c.key).into()), text).style(markdown_style(th)).text_color(th.c("text.primary")))
            .child(rows(c, true, cx));
        let el = if c.ui.reason_flips > 0 { swap_in(c, el, false) } else { el.into_any_element() };
        let footer = if multi {
            let n = c.ui.checked.iter().filter(|x| **x).count();
            let k = c.key.to_string();
            div()
                .w_full()
                .flex()
                .items_center()
                .child(anim::appear(text_font(th, div(), "small").text_color(th.c("text.secondary")).child(format!("已勾选 {n} / {} 项", c.ui.options.len())), format!("{}-n-{n}", c.key), th.ms("hover"), th.ease("standard"), 0., 0.))
                .child(div().flex_1())
                .child(button(th, format!("{}-submit", c.key), Btn::Primary, false, "提交（Enter）", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Option(0), window, cx))))
                .into_any_element()
        } else if c.ui.back {
            hint(th, "↑↓ 选择 · 字母直选 · Enter 确认 · ⌘← 上一题 · Esc 关闭")
        } else {
            hint(th, "↑↓ 选择 · 字母直选 · Enter 确认 · Esc 关闭")
        };
        (el, footer)
    };
    Parts {
        header: header(th, "message-circle-question-mark", format!("等你回答 · {}", c.who), prog),
        top_bar: prog.map(|(n, m)| segments(th, n, m)),
        under_header: None,
        body: body_el,
        body_fills: false,
        overlay: None,
        pinned: None,
        footer,
    }
}

fn long_confirm(c: &Ctx, title: &str, doc: &str, cx: &mut Context<Shell>) -> Parts {
    let th = c.th;
    let ui = c.ui;
    let prog = progress_of(title).filter(|(_, m)| *m > 1);
    let scroll = c.shell.doc_scrolls.get(c.key).cloned().unwrap_or_default();
    let (off, max) = (-scroll.offset().y, scroll.max_offset().y);
    let read = if max > px(0.) { (off / max).clamp(0., 1.) } else { 1. };
    let left_px = f32::from(max - off);
    let unread = (left_px / th.font("body").line_height).ceil() as usize;
    let (label, base) = match doc_kind(title) {
        DocKind::Restatement => ("需求反述", "doc.restatement"),
        DocKind::Goal => ("goal", "doc.goal"),
        DocKind::Plan => ("plan", "doc.plan"),
        DocKind::Other => ("全文", "doc.restatement"),
    };
    let head = div()
        .size_full()
        .flex()
        .items_center()
        .gap(th.sp(3))
        .child(badge(th, base, label).px(th.sp(2)))
        .child(text_font(th, div(), "h2").flex_1().min_w_0().truncate().text_color(th.c("text.primary")).child(question_of(title).to_string()))
        .when_some(prog, |d, (n, m)| d.child(text_font(th, div(), "small").flex_none().text_color(th.c("text.muted")).child(format!("第 {n} / {m} 题"))));
    let many = ui.options.len() > 3;
    let body = div()
        .flex()
        .flex_col()
        .gap(th.sp(4))
        .child(TextView::markdown(ElementId::Name(format!("{}-body", c.key).into()), doc.to_string()).style(markdown_style(th)).selectable(true).text_color(th.c("text.primary")))
        .when(many && !ui.reason_open, |d| d.child(rows(c, true, cx)));
    let overlay = (left_px > th.n("limit.confirm.unread_hint_px")).then(|| {
        let k = c.key.to_string();
        let pill = text_font(th, div(), "small")
            .id(SharedString::from(format!("{}-unread", c.key)))
            .h(px(26.))
            .px(th.sp(3))
            .flex()
            .items_center()
            .gap(th.sp(1))
            .rounded(th.r("full"))
            .bg(th.c("bg.elevated"))
            .border_1()
            .border_color(th.c("border.default"))
            .shadow(th.shadow("low"))
            .text_color(th.c("text.primary"))
            .cursor_pointer()
            .child(icon("arrow-down", px(12.), th.c("text.primary")))
            .child(format!("还有 {unread} 行未读"))
            .on_click(cx.listener(move |this, _, _, cx| this.scroll_doc_to_end(&k, cx)));
        div()
            .absolute()
            .bottom(th.sp(3))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(anim::appear(pill, format!("{}-unread-in", c.key), th.ms("popover_enter"), th.ease("smooth"), 0., th.n("popover.offset")))
            .into_any_element()
    });
    let pinned = ui.reason_open.then(|| {
        let (k1, k2) = (c.key.to_string(), c.key.to_string());
        let h = th.px("confirm.reject_drawer_height");
        div()
            .h(h)
            .flex_none()
            .overflow_hidden()
            .px(th.px("drawer.padding"))
            .py(th.sp(2))
            .flex()
            .gap(th.sp(3))
            .border_t_1()
            .border_color(th.c("border.subtle"))
            .child(div().flex_1().h_full().flex().flex_col().child(editor_box(c, "reason_editor.min_height", true)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(th.sp(2))
                    .child(button(th, format!("{}-rsubmit", c.key), Btn::Primary, false, "提交（⌘Enter）", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.submit_reason(&k1, window, cx))))
                    .child(button(th, format!("{}-rback", c.key), Btn::Secondary, false, "返回（Esc）", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_key(&k2, Key::Esc, window, cx)))),
            )
            .with_animation(ElementId::Name(format!("{}-rexpand-{}", c.key, ui.reason_flips).into()), Animation::new(th.ms("reason_expand")).with_easing(th.ease("smooth")), move |d, t| d.h(h * t).opacity(t))
            .into_any_element()
    });
    let footer = if many {
        hint(th, "↑↓ 滚动 · Tab 切换 · 字母直选 · Enter 确认 · Esc 关闭")
    } else {
        let mut f = div().w_full().flex().items_center().gap(th.sp(2));
        if ui.decline.is_some() {
            let k = c.key.to_string();
            f = f.child(button(th, format!("{}-decline", c.key), Btn::Ghost, c.focused && ui.focus == Row::Decline, "✎ 不选，我说明原因", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Decline, window, cx))));
        }
        if ui.back {
            let k = c.key.to_string();
            f = f.child(button(th, format!("{}-back", c.key), Btn::Ghost, c.focused && ui.focus == Row::Back, "← 返回上一题", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Back, window, cx))));
        }
        f = f.child(div().flex_1());
        // The recommendation last (rightmost) as the primary.
        let mut order: Vec<usize> = (0..ui.options.len()).rev().collect();
        if let Some(r) = ui.recommended() {
            order.retain(|i| *i != r);
            order.push(r);
        }
        for i in order {
            let k = c.key.to_string();
            let kind = if ui.recommended() == Some(i) { Btn::Primary } else { Btn::Secondary };
            let label = format!("{}. {}{}", LETTERS.get(i).unwrap_or(&"?"), ui.options[i], if kind == Btn::Primary { "（推荐）" } else { "" });
            let focused = c.focused && ui.focus == Row::Option(i);
            f = f.child(button(th, format!("{}-btn-{i}", c.key), kind, focused, label, c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Option(i), window, cx))));
        }
        f.into_any_element()
    };
    Parts {
        header: head.into_any_element(),
        top_bar: prog.map(|(n, m)| segments(th, n, m)),
        under_header: Some(div().h(th.px("confirm.progress_height")).w(relative(read)).bg(th.c("accent.primary")).into_any_element()),
        body: body.into_any_element(),
        body_fills: false,
        overlay,
        pinned,
        footer,
    }
}

fn countdown(c: &Ctx, timeout_ms: Option<u64>) -> Option<AnyElement> {
    let total = timeout_ms.filter(|t| *t > 0)? as f32;
    let left = (1.0 - c.opened_at.elapsed().as_millis() as f32 / total).clamp(0.0, 1.0);
    Some(div().h(c.th.px("confirm.progress_height")).w(relative(left)).bg(c.th.c("semantic.warning")).into_any_element())
}

fn native(c: &Ctx, req: &UiRequest, cx: &mut Context<Shell>) -> Parts {
    let th = c.th;
    let head = |title: &str| header(th, "message-circle-question-mark", format!("等你回答 · {title}"), None);
    let two_buttons = |ok: &str, cx: &mut Context<Shell>| {
        let (k1, k2) = (c.key.to_string(), c.key.to_string());
        let ok_focused = c.focused && c.ui.focus == Row::Option(0);
        let cancel_focused = c.focused && c.ui.focus == Row::Option(1);
        let is_text = c.ui.options.is_empty();
        div()
            .w_full()
            .flex()
            .justify_end()
            .gap(th.sp(2))
            .child(button(th, format!("{}-cancel", c.key), Btn::Secondary, cancel_focused, "取消", c.reduce).on_click(cx.listener(move |this, _, window, cx| this.dialog_key(&k1, Key::Esc, window, cx))))
            .child(button(th, format!("{}-ok", c.key), Btn::Primary, ok_focused, ok.to_string(), c.reduce).on_click(cx.listener(move |this, _, window, cx| {
                if is_text {
                    this.submit_reason(&k2, window, cx)
                } else {
                    this.dialog_activate(&k2, Row::Option(0), window, cx)
                }
            })))
            .into_any_element()
    };
    let (header, top, body, fills, footer) = match req {
        UiRequest::Select { title, timeout, .. } => (head(title), countdown(c, *timeout), rows(c, false, cx).into_any_element(), false, hint(th, "↑↓ 移动 · Enter 选中 · Esc 取消")),
        UiRequest::Confirm { title, message, timeout } => (
            head(title),
            countdown(c, *timeout),
            TextView::markdown(ElementId::Name(format!("{}-msg", c.key).into()), message.clone()).style(markdown_style(th)).text_color(th.c("text.primary")).into_any_element(),
            false,
            two_buttons("确定", cx),
        ),
        UiRequest::Input { title, .. } => (head(title), None, line_box(c).into_any_element(), false, two_buttons("确定（Enter）", cx)),
        UiRequest::Editor { title, .. } => (head(title), None, div().size_full().flex().flex_col().child(editor_box(c, "reason_editor.min_height", true)).into_any_element(), true, hint(th, "⌘Enter 提交 · Esc 取消")),
        _ => (head(""), None, div().into_any_element(), false, div().into_any_element()),
    };
    Parts { header, top_bar: top, under_header: None, body, body_fills: fills, overlay: None, pinned: None, footer }
}
