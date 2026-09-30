//! The composer (§5.5): grows 44 → 180, send / abort button that cross-fades
//! with the session's running state, focus ring, disabled when dead.

use super::anim;
use super::assets::icon;
use super::chat::text_font;
use super::controls::ring;
use crate::app::Shell;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub fn render(shell: &Shell, composer: &Entity<TextareaState>, sid: &str, window: &Window, cx: &mut Context<Shell>) -> Div {
    let th = shell.th;
    let reduce = cx.reduce_motion();
    let running = shell.hub.lock().chats.get(sid).is_some_and(|c| c.running);
    let dead = !shell.hub.lock().tree.is_alive(sid);
    let has_text = !composer.read(cx).value().trim().is_empty();
    let b = th.px("composer.button");
    let button = div().id("composer-send").size(b).flex_none().rounded(th.r("md")).flex().items_center().justify_center();
    let (button, state, from, to) = if running {
        let el = button.cursor_pointer().child(div().size(px(10.)).rounded(th.r("xs")).bg(th.c("text.on_accent"))).on_click(cx.listener(|this, _, _, cx| {
            if let Some(s) = this.selected() {
                drop(this.hub.abort(&s));
            }
            cx.notify();
        }));
        (el, "abort", th.c("accent.primary"), th.c("semantic.danger"))
    } else if has_text {
        let el = button.cursor_pointer().child(icon("arrow-up", px(16.), th.c("text.on_accent"))).on_click(cx.listener(|this, _, window, cx| this.send_prompt(window, cx)));
        (el, "send", th.c("bg.elevated"), th.c("accent.primary"))
    } else {
        (button.child(icon("arrow-up", px(16.), th.c("text.disabled"))), "idle", th.c("accent.primary"), th.c("bg.elevated"))
    };
    // Send ↔ abort: the fill interpolates and the glyph fades in (`dot_color`).
    let button = anim::press(button, th, None, reduce).with_animation(ElementId::Name(format!("send-{state}").into()), Animation::new(th.ms("dot_color")).with_easing(th.ease("standard")), move |d, t| d.bg(anim::mix(from, to, t)));
    let focused = composer.read(cx).focus_handle(cx).contains_focused(window, cx);
    let border = th.c(if dead {
        "border.subtle"
    } else if focused {
        "border.focus"
    } else {
        "border.default"
    });
    div().w_full().max_w(th.px("chat.max_width")).mx_auto().px(th.px("chat.padding_x")).pb(th.sp(4)).child(
        text_font(th, div(), "body")
            .id("composer")
            .min_h(th.px("composer.min_height"))
            .max_h(th.px("composer.max_height"))
            .flex()
            .items_end()
            .gap(th.sp(2))
            .px(th.sp(3))
            .py(px(8.))
            .rounded(th.r("lg"))
            .bg(th.c(if dead { "bg.elevated" } else { "bg.surface" }))
            .border(px(if focused { 1.5 } else { 1. }))
            .border_color(border)
            .when(focused, |d| d.shadow(vec![ring(th)]))
            .when(!focused, |d| d.hover(move |s| s.border_color(th.c("border.strong"))))
            .child(div().flex_1().min_w_0().py(px(2.)).child(Textarea::new(composer).appearance(false).disabled(dead)))
            .child(button),
    )
}
