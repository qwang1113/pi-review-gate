//! The bottom status strip (§9): mode badge · branch · round · unmet count for
//! the selected session, from prg's `review-gate-agents` widget line.

use super::assets::icon;
use super::chat::{mono, text_font};
use super::status_model::{self, GATE_WIDGET_KEY, Parsed};
use crate::app::Shell;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

/// Below these window widths the segments fold to icons, 4 → 3 → 2 (§9).
const FOLD_UNMET: f32 = 900.0;
const FOLD_ROUND: f32 = 820.0;
const FOLD_BRANCH: f32 = 760.0;

pub fn render_status(shell: &Shell, sid: Option<&str>, width: f32, cx: &mut Context<Shell>) -> Div {
    let th = shell.th;
    let (line, extras) = {
        let st = shell.hub.lock();
        let w = sid.and_then(|s| st.widgets.get(s));
        let line = w.and_then(|w| w.get(GATE_WIDGET_KEY).or_else(|| w.values().next())).and_then(|l| l.first().cloned());
        let extras: Vec<String> = sid.and_then(|s| st.statuses.get(s)).map(|m| m.values().cloned().collect()).unwrap_or_default();
        (line, extras)
    };
    let bar = text_font(th, div(), "small")
        .h(th.px("statusbar.height"))
        .flex_none()
        .px(th.px("statusbar.padding_x"))
        .flex()
        .items_center()
        .gap(th.sp(3))
        .bg(th.c("bg.surface"))
        .border_t_1()
        .border_color(th.c("border.subtle"))
        .text_color(th.c("text.secondary"))
        .whitespace_nowrap()
        .overflow_hidden();
    let secondary = th.c("text.secondary");
    let bar = match line.as_deref().map(status_model::parse) {
        None => bar.child(div().text_color(th.c("text.muted")).child(if sid.is_some() { "门禁状态未上报" } else { "没有选中的会话" })),
        Some(Parsed::Raw(raw)) => bar.child(div().truncate().child(raw)),
        Some(Parsed::Gate(s)) => {
            let (bg, fg) = status_model::mode_tokens(&s.mode);
            let bar = bar.child(
                text_font(th, div(), "caption")
                    .h(px(18.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .gap(th.sp(1))
                    .rounded(th.r("sm"))
                    .bg(th.c(bg))
                    .text_color(th.c(fg))
                    .child(icon("layers", px(10.), th.c(fg)))
                    .child(s.mode.clone()),
            );
            let bar = bar.when_some(s.branch.clone(), |b, branch| {
                b.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(th.sp(1))
                        .child(icon("git-branch", px(12.), secondary))
                        .when(width >= FOLD_BRANCH, |d| d.child(mono(th, div(), "code_small", cx).max_w(px(160.)).truncate().child(branch))),
                )
            });
            let bar = bar.when_some(s.round, |b, n| {
                b.child(div().flex().items_center().gap(th.sp(1)).child(icon("refresh-cw", px(12.), secondary)).when(width >= FOLD_ROUND, |d| d.child(format!("轮 {n}"))))
            });
            let (glyph, color, text) = if s.unmet > 0 {
                ("circle-alert", th.c("semantic.warning"), format!("{} 项未满足", s.unmet))
            } else {
                ("check", th.c("semantic.success"), "门禁已满足".to_string())
            };
            let n = s.unmet;
            let bar = bar.child(
                div()
                    .id("status-unmet")
                    .flex()
                    .items_center()
                    .gap(th.sp(1))
                    .cursor_pointer()
                    .child(icon(glyph, px(12.), color))
                    .when(width >= FOLD_UNMET, |d| d.child(text))
                    // The widget line carries only the count; the list itself is `/gate-status`'s.
                    .tooltip(move |window, cx| Tooltip::new(format!("{n} 项未满足 —— 明细在该会话里运行 /gate-status 查看")).build(window, cx)),
            );
            bar.when_some(s.stages, |b, stages| b.child(div().text_color(th.c("text.muted")).child(stages)))
        }
    };
    bar.child(div().flex_1()).children(extras.into_iter().map(|e| div().text_color(th.c("text.muted")).truncate().max_w(px(240.)).child(e)))
}
