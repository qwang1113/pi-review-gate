//! The gate dialog (§6), its long-text confirm variant (§7) and pi's own
//! `extension_ui_request` boxes, painted from `DialogUi` (`dialog_state`).
//! The overlay covers the chat stream only; the composer and the status strip
//! stay usable (§5.5).

use super::assets::icon;
use super::chat::{markdown_style, text_font};
use super::dialog_state::{DialogUi, DocKind, Kind, Row, doc_kind, progress_of, question_of};
use super::theme::Th;
use crate::app::{ActiveDialog, Shell};
use gpui_kit::component::input::Textarea;
use gpui_kit::component::text::TextView;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

const LETTERS: [&str; 16] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Ghost,
}

/// §8 button: primary / secondary / ghost, 32 high.
pub fn button(th: Th, id: impl Into<SharedString>, kind: Btn, focused: bool, label: impl Into<SharedString>) -> Stateful<Div> {
    let (bg, fg, hover, pressed) = match kind {
        Btn::Primary => ("accent.primary", "text.on_accent", "accent.hover", "accent.pressed"),
        Btn::Secondary => ("bg.elevated", "text.primary", "border.subtle", "border.default"),
        Btn::Ghost => ("", "text.secondary", "bg.elevated", "border.subtle"),
    };
    text_font(th, div(), "body")
        .id(id.into())
        .h(th.px("button.height"))
        .px(th.px("button.padding_x"))
        .flex()
        .items_center()
        .gap(th.sp(1))
        .rounded(th.r("md"))
        .font_weight(FontWeight(500.))
        .cursor_pointer()
        .text_color(th.c(fg))
        .when(!bg.is_empty(), |d| d.bg(th.c(bg)))
        .when(kind == Btn::Secondary, |d| d.border_1().border_color(th.c(if focused { "border.focus" } else { "border.default" })))
        .when(focused, |d| d.shadow(vec![ring(th)]))
        .hover(move |s| s.bg(th.c(hover)))
        .active(move |s| s.bg(th.c(pressed)))
        .child(label.into())
}

/// The 2 px `focus.ring` glow as a spread-only shadow.
pub fn ring(th: Th) -> BoxShadow {
    BoxShadow { offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.), color: th.c("focus.ring"), inset: false }
}

fn rec_badge(th: Th) -> Div {
    text_font(th, div(), "caption")
        .h(px(20.))
        .px(px(6.))
        .flex()
        .items_center()
        .flex_none()
        .rounded(th.r("sm"))
        .border_1()
        .border_color(th.c("badge.rec.border"))
        .bg(th.c("badge.rec.bg"))
        .text_color(th.c("badge.rec.text"))
        .child("（推荐）")
}

fn progress(th: Th, n: usize, m: usize, h: Pixels) -> Div {
    div().flex().gap(th.px("dialog.progress_gap")).w_full().h(h).children((1..=m).map(|i| div().flex_1().h_full().bg(th.c(if i <= n { "accent.primary" } else { "border.subtle" }))))
}

/// Opacity + an 8 px rise over `dialog_enter` (GPUI cannot scale a div; the report lists it).
fn enter(th: Th, key: &str, el: Div) -> AnimationElement<Div> {
    el.with_animation(
        ElementId::Name(format!("enter-{key}").into()),
        Animation::new(th.ms("dialog_enter")).with_easing(th.ease("emphasized")),
        |d, t| d.opacity(t).mt(px(8. * (1. - t))),
    )
}

fn option_row(th: Th, key: &str, ui: &DialogUi, i: usize, focused_panel: bool, cx: &mut Context<Shell>) -> Stateful<Div> {
    let focused = ui.focus == Row::Option(i) && focused_panel;
    let multi = ui.kind == Kind::Multi;
    let selected = if multi { ui.checked.get(i).copied().unwrap_or(false) } else { ui.selected == Some(i) };
    let letter_color = th.c(if selected { "accent.primary" } else { "text.secondary" });
    let mark: AnyElement = if multi {
        let boxed = div().size(th.px("checkbox")).flex_none().rounded(th.r("sm")).flex().items_center().justify_center();
        if selected {
            boxed.bg(th.c("accent.primary")).child(icon("check", px(12.), th.c("text.on_accent"))).into_any_element()
        } else {
            boxed.border(px(1.5)).border_color(th.c(if focused { "text.primary" } else { "border.strong" })).into_any_element()
        }
    } else {
        icon(if selected { "circle-dot" } else { "circle" }, px(16.), letter_color).into_any_element()
    };
    let k = key.to_string();
    div()
        .id(SharedString::from(format!("{key}-opt-{i}")))
        .min_h(th.px("choice.row_min_height"))
        .px(th.sp(3))
        .py(px(10.))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .rounded(th.r("lg"))
        .cursor_pointer()
        .bg(th.c(if selected && !multi { "accent.subtle" } else if focused { "bg.elevated" } else { "bg.surface" }))
        .border(px(if focused || (selected && !multi) { 1.5 } else { 1. }))
        .border_color(th.c(if selected && !multi {
            "accent.primary"
        } else if focused {
            "border.focus"
        } else {
            "border.subtle"
        }))
        .when(focused, |d| d.shadow(vec![ring(th)]))
        .when(ui.answered, |d| d.text_color(th.c("text.disabled")))
        .when(!ui.answered, |d| d.hover(move |s| s.bg(th.c("bg.elevated")).border_color(th.c("border.default"))))
        .active(move |s| s.bg(th.c("border.subtle")))
        .child(mark)
        .child(text_font(th, div(), "body_strong").w(px(20.)).flex_none().text_color(letter_color).child(format!("{}.", LETTERS.get(i).unwrap_or(&"?"))))
        .child(text_font(th, div(), "body").flex_1().text_color(th.c(if ui.answered { "text.disabled" } else { "text.primary" })).child(ui.options[i].clone()))
        .when(ui.recommended() == Some(i), |d| d.child(rec_badge(th)))
        .on_click(cx.listener(move |this, _, window, cx| {
            if multi {
                this.dialog_toggle(&k, i, cx);
            } else {
                this.dialog_activate(&k, Row::Option(i), window, cx);
            }
        }))
}

fn extra_row(th: Th, key: &str, ui: &DialogUi, row: Row, focused_panel: bool, cx: &mut Context<Shell>) -> Stateful<Div> {
    let focused = ui.focus == row && focused_panel;
    let (glyph, label, dashed) = match row {
        Row::Decline => ("pencil", ui.decline.clone().unwrap_or_default(), true),
        _ => ("arrow-left", "← 返回上一题".to_string(), false),
    };
    let k = key.to_string();
    div()
        .id(SharedString::from(format!("{key}-{}", if dashed { "decline" } else { "back" })))
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
        .on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, row, window, cx)))
}

fn reason_editor(shell: &Shell, th: Th, key: &str, drawer: bool) -> Div {
    let editor = shell.reason_editors.get(key).cloned();
    div()
        .flex()
        .flex_col()
        .gap(th.sp(2))
        .child(
            text_font(th, div(), "body")
                .min_h(th.px(if drawer { "reason_editor.min_height" } else { "reason_editor.min_height" }))
                .max_h(th.px("reason_editor.max_height"))
                .p(px(10.))
                .rounded(th.r("md"))
                .bg(th.c("bg.app"))
                .border(px(1.5))
                .border_color(th.c("border.focus"))
                .shadow(vec![ring(th)])
                .when_some(editor, |d, e| d.child(Textarea::new(&e).appearance(false).h_full())),
        )
        .child(text_font(th, div(), "small").text_right().text_color(th.c("text.muted")).child("⌘Enter 提交 · Esc 返回选项（保留已输入）"))
}

fn choice_panel(shell: &Shell, th: Th, key: &str, who: &str, title: &str, body: Option<&str>, ui: &DialogUi, panel_focused: bool, width: Pixels, cx: &mut Context<Shell>) -> Div {
    let prog = progress_of(title);
    let question = question_of(title).to_string();
    let multi = ui.kind == Kind::Multi;
    let mut panel = div()
        .w(width)
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(th.r("xl"))
        .bg(th.c("bg.overlay"))
        .shadow(th.shadow("mid"))
        .border(px(if panel_focused { 1.5 } else { 1. }))
        .border_color(th.c(if panel_focused { "border.focus" } else { "border.default" }));
    if let Some((n, m)) = prog.filter(|(_, m)| *m > 1) {
        panel = panel.child(progress(th, n, m, th.px("dialog.progress_height")));
    }
    let mut inner = div().flex().flex_col().p(th.sp(5)).gap(th.sp(3));
    inner = inner.child(
        text_font(th, div(), "base")
            .h(th.px("dialog.title_height"))
            .flex()
            .items_center()
            .gap(th.sp(2))
            .font_weight(FontWeight(600.))
            .text_color(th.c("text.primary"))
            .child(icon("message-circle-question-mark", px(18.), th.c("accent.primary")))
            .child(div().flex_1().truncate().child(format!("等你回答 · {who}")))
            .when_some(prog.filter(|(_, m)| *m > 1), |d, (n, m)| {
                d.child(text_font(th, div(), "small").font_weight(FontWeight(400.)).text_color(th.c("text.muted")).child(format!("第 {n} / {m} 题")))
            }),
    );
    let text = match body {
        Some(b) if !b.trim().is_empty() => format!("{question}\n\n{b}"),
        _ => question,
    };
    inner = inner.child(
        div()
            .id(SharedString::from(format!("{key}-q")))
            .max_h(th.px(if body.is_some() { "reason_editor.max_height" } else { "dialog.question_max_height" }))
            .overflow_y_scroll()
            .child(TextView::markdown(ElementId::Name(format!("{key}-md").into()), text).style(markdown_style(th)).text_color(th.c("text.primary"))),
    );
    if ui.reason_open {
        inner = inner.child(reason_editor(shell, th, key, false));
    } else {
        let mut rows = div().flex().flex_col().gap(th.px("choice.row_gap"));
        for i in 0..ui.options.len() {
            rows = rows.child(option_row(th, key, ui, i, panel_focused, cx));
        }
        for extra in ui.rows().into_iter().filter(|r| !matches!(r, Row::Option(_))) {
            rows = rows.child(extra_row(th, key, ui, extra, panel_focused, cx));
        }
        inner = inner.child(rows);
        if !multi {
            let hint = if ui.back { "↑↓ 选择 · A–D 直选 · Enter 确认 · ⌘← 上一题 · Esc 关闭" } else { "↑↓ 选择 · A–D 直选 · Enter 确认 · Esc 关闭" };
            inner = inner.child(text_font(th, div(), "small").text_right().text_color(th.c("text.muted")).child(hint));
        }
    }
    panel = panel.child(inner);
    if multi && !ui.reason_open {
        let k = key.to_string();
        let n = ui.checked.iter().filter(|c| **c).count();
        panel = panel.child(
            div()
                .h(th.px("dialog.multi_footer_height"))
                .px(th.sp(5))
                .flex()
                .items_center()
                .border_t_1()
                .border_color(th.c("border.subtle"))
                .child(text_font(th, div(), "small").flex_1().text_color(th.c("text.secondary")).child(format!("已勾选 {n} / {} 项", ui.options.len())))
                .child(button(th, format!("{key}-submit"), Btn::Primary, false, "提交（Enter）").on_click(cx.listener(move |this, _, window, cx| {
                    this.dialog_activate(&k, Row::Option(0), window, cx)
                }))),
        );
    }
    panel
}

fn doc_badge(th: Th, kind: DocKind) -> Div {
    let (label, base) = match kind {
        DocKind::Restatement => ("需求反述", "doc.restatement"),
        DocKind::Goal => ("goal", "doc.goal"),
        DocKind::Plan => ("plan", "doc.plan"),
        DocKind::Other => ("全文", "doc.restatement"),
    };
    text_font(th, div(), "caption")
        .h(px(20.))
        .px(th.sp(2))
        .flex()
        .items_center()
        .flex_none()
        .rounded(th.r("sm"))
        .border_1()
        .border_color(th.c(&format!("{base}.border")))
        .bg(th.c(&format!("{base}.bg")))
        .text_color(th.c(&format!("{base}.text")))
        .child(label)
}

#[allow(clippy::too_many_arguments)]
fn long_panel(shell: &Shell, th: Th, key: &str, title: &str, body: &str, ui: &DialogUi, panel_focused: bool, win: Size<Pixels>, cx: &mut Context<Shell>) -> Div {
    let w = (win.width * th.n("ratio.confirm.width")).min(th.px("confirm.width_max"));
    let h = (win.height * th.n("ratio.confirm.height")).min(th.px("confirm.height_max"));
    let prog = progress_of(title);
    let scroll = shell.doc_scrolls.get(key).cloned().unwrap_or_default();
    let scroll = &scroll;
    let (off, max) = (-scroll.offset().y, scroll.max_offset().y);
    let read = if max > px(0.) { (off / max).clamp(0., 1.) } else { 1. };
    let left_px = max - off;
    let unread_lines = (f32::from(left_px) / th.font("body").line_height).ceil() as usize;
    let header = div()
        .h(th.px("confirm.header_height"))
        .px(th.sp(5))
        .flex()
        .items_center()
        .gap(th.sp(3))
        .border_b_1()
        .border_color(th.c("border.subtle"))
        .child(doc_badge(th, doc_kind(title)))
        .child(text_font(th, div(), "h2").flex_1().truncate().text_color(th.c("text.primary")).child(question_of(title).to_string()))
        .when_some(prog.filter(|(_, m)| *m > 1), |d, (n, m)| d.child(text_font(th, div(), "small").text_color(th.c("text.muted")).child(format!("第 {n} / {m} 题"))));
    let doc = div()
        .relative()
        .flex_1()
        .min_h_0()
        .child(
            div()
                .id(SharedString::from(format!("{key}-doc")))
                .size_full()
                .overflow_y_scroll()
                .track_scroll(scroll)
                .px(th.sp(6))
                .py(th.sp(4))
                .on_scroll_wheel(cx.listener(|_, _, _, cx| cx.notify()))
                .child(TextView::markdown(ElementId::Name(format!("{key}-body").into()), body.to_string()).style(markdown_style(th)).selectable(true).text_color(th.c("text.primary"))),
        )
        .when(f32::from(left_px) > th.n("limit.confirm.unread_hint_px"), |d| {
            d.child(
                div().absolute().bottom(th.sp(3)).left_0().right_0().flex().justify_center().child(
                    text_font(th, div(), "small")
                        .id(SharedString::from(format!("{key}-unread")))
                        .h(px(26.))
                        .px(th.sp(3))
                        .flex()
                        .items_center()
                        .rounded(th.r("full"))
                        .bg(th.c("bg.elevated"))
                        .border_1()
                        .border_color(th.c("border.default"))
                        .shadow(th.shadow("low"))
                        .text_color(th.c("text.primary"))
                        .cursor_pointer()
                        .child(format!("↓ 还有 {unread_lines} 行未读"))
                        .on_click({
                            let k = key.to_string();
                            cx.listener(move |this, _, _, cx| {
                                if let Some(s) = this.doc_scrolls.get(&k) {
                                    s.scroll_to_bottom();
                                }
                                cx.notify();
                            })
                        }),
                ),
            )
        });
    let mut footer = div()
        .h(th.px("confirm.footer_height"))
        .px(th.sp(5))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .bg(th.c("bg.overlay"))
        .border_t_1()
        .border_color(th.c("border.subtle"));
    let k = key.to_string();
    if ui.decline.is_some() {
        footer = footer.child(
            button(th, format!("{key}-decline"), Btn::Ghost, panel_focused && ui.focus == Row::Decline, ui.decline.clone().unwrap_or_default())
                .on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Decline, window, cx))),
        );
    }
    footer = footer.child(div().flex_1());
    // Buttons right-aligned, the recommendation last (rightmost) as the primary.
    let mut order: Vec<usize> = (0..ui.options.len()).rev().collect();
    if let Some(r) = ui.recommended() {
        order.retain(|i| *i != r);
        order.push(r);
    }
    for i in order {
        let k = key.to_string();
        let kind = if ui.recommended() == Some(i) { Btn::Primary } else { Btn::Secondary };
        let label = format!("{}. {}{}", LETTERS.get(i).unwrap_or(&"?"), ui.options[i], if kind == Btn::Primary { "（推荐）" } else { "" });
        let focused = panel_focused && ui.focus == Row::Option(i);
        footer = footer.child(button(th, format!("{key}-btn-{i}"), kind, focused, label).on_click(cx.listener(move |this, _, window, cx| this.dialog_activate(&k, Row::Option(i), window, cx))));
    }
    let drawer = ui.reason_open.then(|| {
        let (k1, k2) = (key.to_string(), key.to_string());
        div()
            .h(th.px("confirm.reject_drawer_height"))
            .px(th.sp(5))
            .py(th.sp(2))
            .flex()
            .gap(th.sp(3))
            .items_start()
            .border_t_1()
            .border_color(th.c("border.subtle"))
            .child(div().flex_1().h_full().child(reason_editor(shell, th, key, true)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(th.sp(2))
                    .child(button(th, format!("{key}-rsubmit"), Btn::Primary, false, "提交（⌘Enter）").on_click(cx.listener(move |this, _, window, cx| this.submit_reason(&k1, window, cx))))
                    .child(button(th, format!("{key}-rback"), Btn::Secondary, false, "返回（Esc）").on_click(cx.listener(move |this, _, window, cx| {
                        this.dialog_key(&k2, super::dialog_state::Key::Esc, window, cx)
                    }))),
            )
            .with_animation(ElementId::Name(format!("drawer-{key}").into()), Animation::new(th.ms("drawer")).with_easing(th.ease("emphasized")), move |d, t| {
                d.h(th.px("confirm.reject_drawer_height") * t).opacity(t)
            })
    });
    div()
        .w(w)
        .h(h)
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(th.r("xl"))
        .bg(th.c("bg.overlay"))
        .shadow(th.shadow("high"))
        .border(px(if panel_focused { 1.5 } else { 1. }))
        .border_color(th.c(if panel_focused { "border.focus" } else { "border.default" }))
        .child(div().h(th.px("confirm.progress_height")).w(relative(read)).bg(th.c("accent.primary")))
        .child(header)
        .child(doc)
        .children(drawer)
        .child(footer)
}

/// A pi `input` / `editor` request: a text box and two buttons.
fn text_panel(shell: &Shell, th: Th, key: &str, title: &str, cx: &mut Context<Shell>) -> Div {
    let (k1, k2) = (key.to_string(), key.to_string());
    let editor = shell.reason_editors.get(key).cloned();
    div()
        .w(th.px("dialog.choice_width"))
        .p(th.sp(5))
        .flex()
        .flex_col()
        .gap(th.sp(3))
        .rounded(th.r("xl"))
        .bg(th.c("bg.overlay"))
        .shadow(th.shadow("mid"))
        .border(px(1.5))
        .border_color(th.c("border.focus"))
        .child(text_font(th, div(), "base").font_weight(FontWeight(600.)).text_color(th.c("text.primary")).child(title.to_string()))
        .child(
            text_font(th, div(), "body")
                .min_h(th.px("reason_editor.min_height"))
                .max_h(th.px("reason_editor.max_height"))
                .p(px(10.))
                .rounded(th.r("md"))
                .bg(th.c("bg.app"))
                .border(px(1.5))
                .border_color(th.c("border.focus"))
                .when_some(editor, |d, e| d.child(Textarea::new(&e).appearance(false).h_full())),
        )
        .child(
            div()
                .flex()
                .justify_end()
                .gap(th.sp(2))
                .child(button(th, format!("{key}-cancel"), Btn::Secondary, false, "取消（Esc）").on_click(cx.listener(move |this, _, window, cx| {
                    this.dialog_key(&k1, super::dialog_state::Key::Esc, window, cx)
                })))
                .child(button(th, format!("{key}-ok"), Btn::Primary, false, "提交（⌘Enter）").on_click(cx.listener(move |this, _, window, cx| this.submit_reason(&k2, window, cx)))),
        )
}

pub fn render_overlay(shell: &Shell, sid: &str, who: &str, window: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let th = shell.th;
    let (key, active) = shell.active_dialog(sid)?;
    let ui = shell.dialog_uis.get(&key)?;
    let focused = shell.dialog_focus.contains_focused(window, cx) || shell.reason_focused(&key, window, cx);
    let win = window.viewport_size();
    let chat_w = shell.chat_width(win.width);
    let choice_w = th.px("dialog.choice_width").min(chat_w - px(64.));
    let panel = match &active {
        ActiveDialog::Gate(p) => {
            let body = match p {
                crate::protocol::DialogParams::Choice { body, .. } | crate::protocol::DialogParams::Multi { body, .. } => body.as_deref(),
            };
            match (ui.long, body) {
                (true, Some(b)) => long_panel(shell, th, &key, p.title(), b, ui, focused, win, cx),
                _ => choice_panel(shell, th, &key, who, p.title(), body, ui, focused, choice_w, cx),
            }
        }
        ActiveDialog::Native(req) => match req {
            crate::rpc::UiRequest::Input { title, .. } | crate::rpc::UiRequest::Editor { title, .. } => text_panel(shell, th, &key, title, cx),
            crate::rpc::UiRequest::Confirm { title, message, .. } => choice_panel(shell, th, &key, who, title, Some(message), ui, focused, choice_w, cx),
            crate::rpc::UiRequest::Select { title, .. } => choice_panel(shell, th, &key, who, title, None, ui, focused, choice_w, cx),
            _ => return None,
        },
    };
    let scrim = div().absolute().inset_0().bg(th.c("bg.scrim")).with_animation(
        ElementId::Name(format!("scrim-{key}").into()),
        Animation::new(th.ms("scrim_enter")).with_easing(th.ease("emphasized")),
        |d, t| d.opacity(t),
    );
    let k = key.clone();
    Some(
        div()
            .id("dialog-layer")
            .absolute()
            .inset_0()
            .child(scrim)
            .child(
                div()
                    .id(SharedString::from(format!("{key}-focus")))
                    .track_focus(&shell.dialog_focus)
                    .key_context("GateDialog")
                    .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| this.dialog_keystroke(&k, ev, window, cx)))
                    .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                        if !this.dialog_focus.contains_focused(window, cx) {
                            window.focus(&this.dialog_focus, cx);
                        }
                    }))
                    .absolute()
                    .inset_0()
                    .flex()
                    .justify_center()
                    .items_center()
                    .p(th.sp(4))
                    // Vertical centre raised by 10 % (§6.1): push from below. The long box
                    // is sized off the window, so it only gets the margin.
                    .when(!ui.long, |d| d.pb(win.height * 0.1))
                    // Never taller than the chat area: the panel shrinks and scrolls inside.
                    .child(enter(th, &key, div().max_h_full().flex().flex_col().child(panel.flex_shrink(1.).min_h_0()))),
            )
            .into_any_element(),
    )
}
