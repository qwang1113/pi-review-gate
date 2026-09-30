//! The bottom status strip (§9): mode badge · branch · round · unmet pill for
//! the selected session, from prg's `review-gate-agents` widget, then the
//! other `setStatus` texts in ANSI colour (§9.3). The unmet pill opens the
//! popover listing the items the widget carries (§9.2).

use super::ansi::{self, Color};
use super::anim;
use super::assets::icon;
use super::chat::{mono, text_font};
use super::controls::icon_button;
use super::motion::{Curve, Tween};
use super::status_model::{self, GATE_WIDGET_KEY, Parsed};
use super::theme::Th;
use crate::app::Shell;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

/// Below these window widths the segments fold, 5 → 4 → 3 → 2 (§9.1).
const FOLD_EXTRAS: f32 = 980.0;
const FOLD_UNMET: f32 = 900.0;
const FOLD_ROUND: f32 = 820.0;
const FOLD_BRANCH: f32 = 760.0;

/// The unmet popover's state: open fraction and where the pill sits.
pub struct Unmet {
    pub open: Tween,
    pub anchor_x: Rc<Cell<f32>>,
}

impl Default for Unmet {
    fn default() -> Self {
        Unmet { open: Tween::at_rest(0.0), anchor_x: Rc::new(Cell::new(0.0)) }
    }
}

impl Unmet {
    pub fn is_open(&self) -> bool {
        self.open.to > 0.0
    }

    pub fn set(&mut self, open: bool, th: Th, reduce: bool) {
        let now = Instant::now();
        let (d, c) = match (reduce, open) {
            (true, _) => (th.ms("reduced_motion_fade"), Curve::Linear),
            (false, true) => (th.ms("popover_enter"), th.curve("smooth")),
            (false, false) => (th.ms("popover_exit"), th.curve("exit")),
        };
        self.open.retarget(if open { 1.0 } else { 0.0 }, now, d, c);
    }
}

fn palette(th: Th, c: Color) -> Hsla {
    match c {
        Color::Palette(n) => th.c(&format!("ansi.{n}")),
        Color::Rgb(r, g, b) => Rgba { r: r as f32 / 255., g: g as f32 / 255., b: b as f32 / 255., a: 1. }.into(),
    }
}

/// One ANSI string as styled text (§9.3). `base` is the default foreground.
pub fn ansi_text(th: Th, s: &str, base: Hsla) -> StyledText {
    let spans = ansi::parse(s);
    let text: String = spans.iter().map(|s| s.text.as_str()).collect();
    let mut at = 0;
    let mut runs = vec![];
    for sp in &spans {
        let st = sp.style;
        let (mut fg, mut bg) = (st.fg.map_or(base, |c| palette(th, c)), st.bg.map(|c| palette(th, c)));
        if st.inverse {
            (fg, bg) = (bg.unwrap_or(th.c("bg.surface")), Some(fg));
        }
        if st.dim {
            fg.a *= 0.6;
        }
        let style = HighlightStyle {
            color: Some(fg),
            background_color: bg,
            font_weight: st.bold.then_some(FontWeight(600.)),
            underline: st.underline.then(|| UnderlineStyle { thickness: px(1.), color: Some(fg), wavy: false }),
            ..Default::default()
        };
        runs.push((at..at + sp.text.len(), style));
        at += sp.text.len();
    }
    StyledText::new(text).with_highlights(runs)
}

fn widget_lines(shell: &Shell, sid: Option<&str>) -> (Option<Vec<String>>, Vec<String>) {
    let st = shell.hub.lock();
    let w = sid.and_then(|s| st.widgets.get(s));
    let lines = w.and_then(|w| w.get(GATE_WIDGET_KEY).or_else(|| w.values().next())).cloned();
    let extras = sid.and_then(|s| st.statuses.get(s)).map(|m| m.values().cloned().collect()).unwrap_or_default();
    (lines, extras)
}

fn unmet_pill(shell: &Shell, th: Th, n: usize, width: f32, cx: &mut Context<Shell>) -> AnyElement {
    let (glyph, color, text) = if n > 0 { ("circle-alert", th.c("semantic.warning"), format!("{n} 项未满足")) } else { ("check", th.c("semantic.success"), "门禁已满足".to_string()) };
    let anchor = shell.unmet.anchor_x.clone();
    let glyph_el = if n == 0 {
        anim::pop_size(icon(glyph, px(10.), color), "unmet-zero", th, 10., 12.).into_any_element()
    } else {
        anim::appear(icon(glyph, px(12.), color), format!("unmet-glyph-{}", n > 0), th.ms("dot_color"), th.ease("standard"), 0., 0.).into_any_element()
    };
    let pill = div()
        .id("status-unmet")
        .relative()
        .h(px(20.))
        .px(th.sp(2))
        .flex()
        .items_center()
        .gap(th.sp(1))
        .rounded(th.r("full"))
        .cursor_pointer()
        .when(shell.unmet.is_open(), |d| d.bg(th.c("bg.elevated")))
        .hover(move |s| s.bg(th.c("bg.elevated")))
        .child(canvas(move |b, _, _| anchor.set(f32::from(b.origin.x)), |_, _, _, _| {}).absolute().inset_0())
        .child(glyph_el)
        .when(width >= FOLD_UNMET, |d| d.child(anim::appear(div().child(text), format!("unmet-n-{n}"), th.ms("hover"), th.ease("standard"), 0., 0.)))
        .on_click(cx.listener(|this, _, _, cx| {
            let open = !this.unmet.is_open();
            this.unmet.set(open, this.th, cx.reduce_motion());
            cx.notify();
        }));
    anim::press(pill, th, Some("border.subtle"), cx.reduce_motion()).into_any_element()
}

pub fn render_status(shell: &Shell, sid: Option<&str>, width: f32, cx: &mut Context<Shell>) -> Div {
    let th = shell.th;
    let (lines, extras) = widget_lines(shell, sid);
    let line = lines.as_ref().and_then(|l| l.first().cloned());
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
        Some(Parsed::Raw(raw)) => bar.child(div().truncate().child(ansi_text(th, &raw, secondary))),
        Some(Parsed::Gate(s)) => {
            let (bg, fg) = status_model::mode_tokens(&s.mode);
            let bar = bar.child(
                text_font(th, div(), "caption")
                    .h(px(18.))
                    .px(px(6.))
                    .flex()
                    .flex_none()
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
            let bar = bar.child(unmet_pill(shell, th, s.unmet, width, cx));
            bar.when_some(s.stages, |b, stages| b.child(div().text_color(th.c("text.muted")).child(stages)))
        }
    };
    let bar = bar.child(div().flex_1());
    if width < FOLD_EXTRAS {
        return bar;
    }
    bar.children(extras.into_iter().enumerate().map(|(i, e)| {
        let full = ansi::plain(&e);
        div()
            .id(("status-extra", i))
            .max_w(px(240.))
            .truncate()
            .child(ansi_text(th, &e, th.c("text.muted")))
            .tooltip(move |window, cx| Tooltip::new(full.clone()).build(window, cx))
    }))
}

/// The unmet popover (§9.2), or nothing while it is closed.
pub fn render_popover(shell: &Shell, sid: Option<&str>, win: Size<Pixels>, window: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let th = shell.th;
    let now = Instant::now();
    let f = shell.unmet.open.value(now).clamp(0., 1.);
    if shell.unmet.open.running(now) {
        window.request_animation_frame();
    }
    if f <= 0.0 {
        return None;
    }
    let (lines, _) = widget_lines(shell, sid);
    let lines = lines.unwrap_or_default();
    let count = lines.first().map(|l| status_model::parse(l)).and_then(|p| if let Parsed::Gate(s) = p { Some(s.unmet) } else { None }).unwrap_or(0);
    let items = status_model::unmet_items(&lines);
    let w = th.n("popover.unmet_width");
    let left = shell.unmet.anchor_x.get().min(f32::from(win.width) - w - 8.).max(8.);
    let reduce = cx.reduce_motion();
    let all = items.iter().map(|i| ansi::plain(i)).collect::<Vec<_>>().join("\n");
    let header = div()
        .h(px(36.))
        .flex_none()
        .px(th.sp(3))
        .flex()
        .items_center()
        .gap(th.sp(1))
        .border_b_1()
        .border_color(th.c("border.subtle"))
        .child(text_font(th, div(), "body_strong").flex_1().text_color(th.c("text.primary")).child(format!("门禁未满足项（{count}）")))
        .child(super::chat::copy_button(shell, th, "unmet-all", all, cx))
        .child(icon_button(th, "unmet-close", "x", reduce).on_click(cx.listener(|this, _, _, cx| {
            this.unmet.set(false, this.th, cx.reduce_motion());
            cx.notify();
        })));
    let list = div().id("unmet-list").flex_1().min_h_0().overflow_y_scroll().py(th.sp(1)).children(items.iter().enumerate().map(|(i, item)| {
        let row = text_font(th, div(), "small")
            .id(("unmet-item", i))
            .px(th.sp(3))
            .py(px(6.))
            .flex()
            .items_start()
            .gap(th.sp(2))
            .hover(move |s| s.bg(th.c("bg.elevated")))
            .child(div().pt(px(2.)).child(icon("circle-alert", px(12.), th.c("semantic.warning"))))
            .child(div().flex_1().min_w_0().child(ansi_text(th, item, th.c("text.primary"))));
        anim::appear(row, format!("unmet-row-{}", ansi::plain(item)), th.ms("message_enter"), th.ease("smooth"), 0., th.n("message.enter_shift"))
    }));
    let empty = items.is_empty().then(|| {
        text_font(th, div(), "small")
            .px(th.sp(3))
            .py(th.sp(2))
            .text_color(th.c("text.secondary"))
            .child(if count > 0 { format!("{count} 项未满足 —— 这个会话没有上报明细") } else { "门禁已满足，没有未满足项".to_string() })
    });
    let card = div()
        .id("unmet-popover")
        .absolute()
        .left(px(left))
        .bottom(th.px("statusbar.height") + th.px("popover.offset") - px(if reduce { 0. } else { th.n("popover.offset") * (1. - f) }))
        .w(px(w))
        .max_h(th.px("popover.unmet_max_height"))
        .flex()
        .flex_col()
        .overflow_hidden()
        .opacity(f)
        .rounded(th.r("xl"))
        .bg(th.c("bg.overlay"))
        .border_1()
        .border_color(th.c("border.default"))
        .shadow(th.shadow("mid"))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(header)
        .child(list)
        .children(empty)
        .child(
            text_font(th, div(), "small")
                .h(px(28.))
                .flex_none()
                .px(th.sp(3))
                .flex()
                .items_center()
                .border_t_1()
                .border_color(th.c("border.subtle"))
                .text_color(th.c("text.muted"))
                .child("完整诊断：在会话里运行 /gate-status"),
        );
    // A click anywhere else closes it (§9.2).
    let outside = div().id("unmet-outside").absolute().inset_0().when(shell.unmet.is_open(), |d| {
        d.on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
            this.unmet.set(false, this.th, cx.reduce_motion());
            cx.notify();
        }))
    });
    Some(div().absolute().inset_0().child(outside).child(card).into_any_element())
}
