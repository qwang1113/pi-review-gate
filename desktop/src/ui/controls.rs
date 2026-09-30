//! Buttons and small shared pieces (§8): primary / secondary / ghost / danger
//! with hover, press sink and focus ring, used by the drawer, the popover and
//! the empty state.

use super::anim;
use super::chat::text_font;
use super::theme::Th;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Btn {
    Primary,
    Secondary,
    Ghost,
}

/// §8 button, `button.height` high.
pub fn button(th: Th, id: impl Into<SharedString>, kind: Btn, focused: bool, label: impl Into<SharedString>, reduce: bool) -> Stateful<Div> {
    let (bg, fg, hover, pressed) = match kind {
        Btn::Primary => ("accent.primary", "text.on_accent", "accent.hover", "accent.pressed"),
        Btn::Secondary => ("bg.elevated", "text.primary", "border.subtle", "border.default"),
        Btn::Ghost => ("", "text.secondary", "bg.elevated", "border.subtle"),
    };
    let el = text_font(th, div(), "body")
        .id(id.into())
        .h(th.px("button.height"))
        .px(th.px("button.padding_x"))
        .flex()
        .flex_none()
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
        .child(label.into());
    anim::press(el, th, Some(pressed), reduce)
}

/// A 28 × 28 icon button in ghost style (title bar, popover header).
pub fn icon_button(th: Th, id: impl Into<SharedString>, glyph: &'static str, reduce: bool) -> Stateful<Div> {
    let el = div()
        .id(id.into())
        .size(th.px("titlebar.button"))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(th.r("md"))
        .cursor_pointer()
        .hover(move |s| s.bg(th.c("bg.elevated")))
        .child(super::assets::icon(glyph, px(16.), th.c("text.secondary")));
    anim::press(el, th, Some("border.subtle"), reduce)
}

/// The 2 px `focus.ring` glow as a spread-only shadow.
pub fn ring(th: Th) -> BoxShadow {
    BoxShadow { offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.), color: th.c("focus.ring"), inset: false }
}

/// A small bordered badge: `（推荐）` or a document type (§6.2, §6.5).
pub fn badge(th: Th, base: &str, label: impl Into<SharedString>) -> Div {
    text_font(th, div(), "caption")
        .h(px(20.))
        .px(px(6.))
        .flex()
        .items_center()
        .flex_none()
        .rounded(th.r("sm"))
        .border_1()
        .border_color(th.c(&format!("{base}.border")))
        .bg(th.c(&format!("{base}.bg")))
        .text_color(th.c(&format!("{base}.text")))
        .child(label.into())
}
