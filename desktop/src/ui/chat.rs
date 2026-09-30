//! The streaming chat column (§5): user bubbles, assistant markdown with the
//! streaming cursor, thinking blocks, tool cards and diffs. Paints a `Chat`
//! (`chat_model`); folding state lives in `Shell::toggled`. New messages rise
//! in, streamed words fade in (§5.1), folds animate their height (§5.2).

use super::anim;
use super::assets::icon;
use super::chat_model::{Block, Chat, Item, ToolCall, ToolStatus};
use super::diff::{self, DiffFile, Kind};
use super::motion;
use super::theme::Th;
use crate::app::Shell;
use gpui_kit::component::text::TextViewStyle;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::time::Instant;

const DIFF_PREVIEW_LINES: usize = 20;

pub fn clock(ms: u64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    // SAFETY: localtime_r writes only into the struct we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

pub fn elapsed(ms: u64) -> String {
    if ms < 1000 { format!("{ms}ms") } else if ms < 60_000 { format!("{:.1}s", ms as f64 / 1000.0) } else { format!("{}m{}s", ms / 60_000, ms / 1000 % 60) }
}

pub fn tool_icon(name: &str) -> &'static str {
    match name {
        "bash" => "terminal",
        "read" => "file-text",
        "edit" | "write" => "file-pen",
        _ => "plug",
    }
}

pub fn text_font(th: Th, el: Div, name: &str) -> Div {
    let f = th.font(name);
    el.text_size(px(f.size)).line_height(px(f.line_height)).font_weight(FontWeight(f.weight))
}

pub fn mono(th: Th, el: Div, name: &str, cx: &App) -> Div {
    text_font(th, el, name).font_family(cx.global::<super::Fonts>().mono.clone())
}

/// A chevron that turns 90° over `collapse` when `open` flips.
pub fn chevron(th: Th, key: SharedString, open: bool, size: Pixels, color: Hsla) -> impl IntoElement {
    let from = if open { 0.0 } else { 1.0 };
    icon("chevron-right", size, color).with_animation(
        ElementId::Name(format!("{key}-chev-{open}").into()),
        Animation::new(th.ms("collapse")).with_easing(th.ease("smooth")),
        move |svg, t| {
            let turn = if open { from + t } else { from - t };
            svg.with_transformation(Transformation::rotate(radians(turn * std::f32::consts::FRAC_PI_2)))
        },
    )
}

/// A fold's body (§5.2, §5.3): while the fold animates, its height is clipped
/// between 0 and `est` px and its opacity follows; it stays rendered while it
/// closes. None when closed and settled.
pub fn fold_body(shell: &Shell, key: &str, open: bool, est: f32, el: impl IntoElement, window: &mut Window) -> Option<AnyElement> {
    let th = shell.th;
    let stamp = format!("fold-{key}");
    let dur = if shell.reduce_motion { std::time::Duration::ZERO } else { th.ms("collapse") };
    let running = shell.stamps.running(&stamp, dur);
    if !open && !running {
        return None;
    }
    if !running {
        return Some(div().child(el).into_any_element());
    }
    window.request_animation_frame();
    let p = shell.stamps.progress(&stamp, dur, th.curve("smooth"));
    let f = if open { p } else { 1. - p };
    Some(div().overflow_hidden().max_h(px(est * f)).opacity(f).child(el).into_any_element())
}

/// A rough rendered height for a block of text (the fold's clip target).
fn text_height(text: &str, line_h: f32, chars_per_line: f32) -> f32 {
    text.lines().map(|l| (l.chars().count() as f32 / chars_per_line).ceil().max(1.)).sum::<f32>() * line_h
}

pub fn render_chat(shell: &Shell, sid: &str, window: &mut Window, cx: &mut Context<Shell>) -> AnyElement {
    let th = shell.th;
    let chat: Chat = shell.hub.lock().chats.get(sid).cloned().unwrap_or_default();
    let now = crate::hub::now_ms();
    let blink_on = cx.reduce_motion() || (now / (th.ms("cursor_blink").as_millis() as u64 / 2)) % 2 == 0;
    let mut col = div()
        .flex()
        .flex_col()
        .w_full()
        .max_w(th.px("chat.max_width"))
        .mx_auto()
        .px(th.px("chat.padding_x"))
        .pt(th.px("chat.padding_top"))
        .pb(th.px("chat.padding_bottom"))
        .gap(th.px("chat.message_gap"));
    let last = chat.items.len().saturating_sub(1);
    // Only items that arrived after the session was selected play their entrance (§5.1).
    let fresh_from = shell.enter_from.get(sid).copied().unwrap_or(usize::MAX);
    let reduce = cx.reduce_motion();
    for (i, item) in chat.items.iter().enumerate() {
        let key = format!("{sid}/{i}");
        if matches!(item, Item::Assistant { blocks, .. } if blocks.is_empty() && i != last) {
            continue;
        }
        let el = match item {
            Item::User { text, ts_ms } => user_bubble(th, text, *ts_ms).into_any_element(),
            Item::Assistant { blocks, ts_ms, streaming } => {
                let cursor = *streaming && i == last;
                assistant(shell, th, &key, blocks, &chat, *ts_ms, cursor && blink_on, cursor, now, window, cx).into_any_element()
            }
            Item::Notice { text, error } => notice(th, text, *error).into_any_element(),
        };
        col = col.child(if i >= fresh_from {
            anim::appear(div().child(el), format!("msg-{key}"), th.ms("message_enter"), th.ease("smooth"), 0., if reduce { 0. } else { th.n("message.enter_shift") }).into_any_element()
        } else {
            el
        });
    }
    let at_bottom = shell.follow;
    let arrow = icon("arrow-down", px(12.), th.c("text.primary"));
    // While the session still generates, the arrow breathes (`pulse_working`).
    let arrow = if chat.running {
        arrow.with_animation("jump-breathe", Animation::new(th.ms("pulse_working")).repeat().with_max_fps(super::LOOP_FPS).with_easing(th.ease("pulse")), |a, t| a.opacity(0.5 + 0.5 * motion::triangle(t))).into_any_element()
    } else {
        arrow.into_any_element()
    };
    div()
        .relative()
        .size_full()
        .child(
            div()
                .id("chat-scroll")
                .size_full()
                .overflow_y_scroll()
                .track_scroll(&shell.chat_scroll)
                .on_scroll_wheel(cx.listener(|this, _, _, cx| {
                    this.stop_programmatic_scroll();
                    this.follow = this.chat_at_bottom();
                    cx.notify();
                }))
                .child(col),
        )
        .children(anim::scroll_fades(th, &shell.chat_scroll, th.c("bg.app")))
        .when(!at_bottom, |d| {
            let pill = div()
                .id("jump-latest")
                .h(px(28.))
                .px(th.sp(3))
                .flex()
                .items_center()
                .gap(th.sp(1))
                .rounded(th.r("full"))
                .bg(th.c("bg.overlay"))
                .border_1()
                .border_color(th.c("border.default"))
                .shadow(th.shadow("low"))
                .text_color(th.c("text.primary"))
                .cursor_pointer()
                .child(arrow)
                .child(text_font(th, div(), "small").child("回到最新"))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.follow = true;
                    let h = this.chat_scroll.clone();
                    this.scroll_to(h, None, cx);
                }));
            let pill = anim::press(pill, th, Some("bg.elevated"), reduce);
            d.child(div().absolute().bottom(th.sp(4)).right(th.sp(6)).child(anim::appear(pill, "jump-in", th.ms("popover_enter"), th.ease("smooth"), 0., th.n("popover.offset"))))
        })
        .into_any_element()
}

fn user_bubble(th: Th, text: &str, ts: u64) -> Div {
    div().flex().flex_col().items_end().child(text_font(th, div(), "small").text_color(th.c("text.muted")).mb(th.sp(1)).child(clock(ts))).child(
        text_font(th, div(), "body")
            .max_w(relative(th.n("ratio.chat.user_max_width")))
            .px(px(14.))
            .py(px(10.))
            .bg(th.c("chat.user.bg"))
            .text_color(th.c("text.primary"))
            .rounded_tl(th.r("xl"))
            .rounded_tr(th.r("xl"))
            .rounded_br(th.r("sm"))
            .rounded_bl(th.r("xl"))
            .child(text.to_string()),
    )
}

fn notice(th: Th, text: &str, error: bool) -> Div {
    let color = if error { th.c("semantic.danger") } else { th.c("text.muted") };
    text_font(th, div(), "small").flex().items_center().gap(th.sp(2)).text_color(color).child(icon("circle-alert", px(14.), color)).child(text.to_string())
}

pub fn markdown_style(th: Th) -> TextViewStyle {
    let mut code = StyleRefinement::default();
    code.background = Some(th.c("code.block.bg").into());
    let mut block = div().border_1().border_color(th.c("border.subtle")).rounded(th.r("lg")).px(th.sp(4)).py(th.sp(3));
    code.refine(&block.style().clone());
    TextViewStyle::default()
        .paragraph_gap(rems(th.n("chat.paragraph_gap") / 16.0))
        .heading_font_size(move |level, _| match level {
            1 => px(th.font("display").size),
            2 => px(th.font("h2").size),
            _ => px(th.font("body_strong").size),
        })
        .code_block(code)
        .inline_code(HighlightStyle { color: Some(th.c("code.inline.text")), background_color: Some(th.c("code.inline.bg")), ..Default::default() })
}

#[allow(clippy::too_many_arguments)]
fn assistant(
    shell: &Shell,
    th: Th,
    key: &str,
    blocks: &[Block],
    chat: &Chat,
    ts: u64,
    cursor_visible: bool,
    streaming: bool,
    now: u64,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Div {
    let header = div()
        .flex()
        .items_center()
        .gap(th.sp(2))
        .mb(th.sp(2))
        .child(
            div()
                .size(th.px("chat.avatar"))
                .rounded(th.r("md"))
                .bg(th.c("chat.avatar.bg"))
                .flex()
                .items_center()
                .justify_center()
                .child(icon("bot", px(14.), th.c("chat.avatar.fg"))),
        )
        .child(text_font(th, div(), "small").font_weight(FontWeight(600.)).text_color(th.c("text.primary")).child("pi"))
        .child(text_font(th, div(), "small").text_color(th.c("text.muted")).child(clock(ts)));
    let mut body = div().flex().flex_col().gap(th.px("chat.paragraph_gap"));
    let last_text = blocks.iter().rposition(|b| matches!(b, Block::Text { .. }));
    for (j, b) in blocks.iter().enumerate() {
        let bkey = format!("{key}/{j}");
        if let Block::Tool(id) = b
            && !chat.tools.contains_key(id)
        {
            continue;
        }
        body = body.child(match b {
            Block::Text { text, .. } => {
                // The cursor rides on the last text block; toggling a trailing glyph keeps it inline.
                let cursor = streaming && Some(j) == last_text && cursor_visible;
                super::stream_text::render(th, &bkey, text, shell.fades.get(&bkey).filter(|_| streaming), cursor, cx.reduce_motion(), window)
            }
            Block::Thinking { text, streaming, secs, .. } => thinking(shell, th, bkey, text, *streaming, *secs, window, cx).into_any_element(),
            Block::Tool(id) => tool_card(shell, th, &chat.tools[id], now, window, cx).into_any_element(),
        });
    }
    if streaming && last_text.is_none() && cursor_visible {
        body = body.child(div().w(px(2.)).h(px(16.)).bg(th.c("accent.primary")));
    }
    div().flex().flex_col().child(header).child(body)
}

#[allow(clippy::too_many_arguments)]
fn thinking(shell: &Shell, th: Th, key: String, text: &str, streaming: bool, secs: Option<u64>, window: &mut Window, cx: &mut Context<Shell>) -> Div {
    let open = shell.is_open(&key, false);
    let label = match (streaming, secs) {
        (true, _) | (false, None) => "思考中…".to_string(),
        (false, Some(s)) => format!("已思考 {s}s"),
    };
    let k = key.clone();
    let brain = icon("brain", px(14.), th.c("text.muted"));
    // Generating: the brain breathes (opacity only); the label cross-fades when it changes.
    let brain = if streaming {
        brain.with_animation(ElementId::Name(format!("{key}-brain").into()), Animation::new(th.ms("pulse_working")).repeat().with_max_fps(super::LOOP_FPS).with_easing(th.ease("pulse")), |b, t| b.opacity(0.5 + 0.5 * motion::triangle(t))).into_any_element()
    } else {
        brain.into_any_element()
    };
    let bar = div()
        .id(SharedString::from(format!("{key}-head")))
        .h(th.px("thinking.collapsed_height"))
        .px(th.sp(3))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .cursor_pointer()
        .child(brain)
        .child(anim::appear(text_font(th, div(), "small").flex_1().text_color(th.c("text.muted")).child(label.clone()), format!("{key}-label-{label}"), th.ms("hover"), th.ease("standard"), 0., 0.))
        .child(chevron(th, key.clone().into(), open, px(12.), th.c("text.muted")))
        .on_click(cx.listener(move |this, _, _, cx| this.toggle(&k, cx)));
    let bar = anim::press(bar, th, None, cx.reduce_motion());
    let el = div()
        .flex()
        .flex_col()
        .border_l(px(2.))
        .border_color(th.c("thinking.border"))
        .rounded_tr(th.r("md"))
        .rounded_br(th.r("md"))
        .bg(th.c(if open { "thinking.bg.expanded" } else { "thinking.bg.collapsed" }))
        .child(bar);
    let body = text_font(th, div(), "code")
        .font_weight(FontWeight(400.))
        .pt(th.sp(1))
        .pb(th.sp(2))
        .pl(px(14.))
        .pr(th.sp(3))
        .text_color(th.c("thinking.text"))
        .whitespace_normal()
        .child(super::stream_text::plain(th, text, shell.fades.get(&key).filter(|_| streaming), th.c("thinking.text"), cx.reduce_motion(), window));
    let est = text_height(text, th.font("code").line_height, 90.) + th.n("space.3");
    el.children(fold_body(shell, &key, open, est, body, window))
}

fn status_icon(th: Th, id: &str, s: ToolStatus, reduce: bool) -> AnyElement {
    match s {
        // Finishing: the icon lands with a snappy 10 → 14 (§5.3), once per card on screen.
        ToolStatus::Ok if !reduce => anim::pop_size(icon("circle-check", px(10.), th.c("status.done")), format!("done-{id}"), th, 10., 14.).into_any_element(),
        ToolStatus::Error if !reduce => anim::pop_size(icon("circle-alert", px(10.), th.c("status.dead")), format!("err-{id}"), th, 10., 14.).into_any_element(),
        ToolStatus::Ok => icon("circle-check", px(14.), th.c("status.done")).into_any_element(),
        ToolStatus::Error => icon("circle-alert", px(14.), th.c("status.dead")).into_any_element(),
        ToolStatus::Pending | ToolStatus::Running if reduce => icon("loader-circle", px(14.), th.c("status.working")).into_any_element(),
        ToolStatus::Pending | ToolStatus::Running => icon("loader-circle", px(14.), th.c("status.working"))
            .with_animation(
                ElementId::Name(format!("spin-{id}").into()),
                Animation::new(th.ms("spinner_rotation")).repeat().with_max_fps(super::LOOP_FPS),
                |svg, t| svg.with_transformation(Transformation::rotate(percentage(t))),
            )
            .into_any_element(),
    }
}

fn tool_card(shell: &Shell, th: Th, t: &ToolCall, now: u64, window: &mut Window, cx: &mut Context<Shell>) -> Div {
    let key = format!("tool/{}", t.id);
    let error = t.status == ToolStatus::Error;
    let open = shell.is_open(&key, error);
    let took = match (t.started_ms, t.ended_ms) {
        (Some(s), Some(e)) => elapsed(e.saturating_sub(s)),
        (Some(s), None) => format!("{}s", now.saturating_sub(s) / 1000),
        _ => String::new(),
    };
    let k = key.clone();
    let muted = th.c("text.muted");
    let header = mono(th, div(), "code", cx)
        .id(SharedString::from(format!("{key}-head")))
        .h(th.px("tool.header_height"))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .cursor_pointer()
        .when(error, |d| d.bg(th.c("tool.error.header_bg")))
        .child(icon(tool_icon(&t.name), px(14.), th.c("text.secondary")))
        .child(div().font_weight(FontWeight(600.)).text_color(th.c("text.primary")).child(t.name.clone()))
        .child(div().max_w(th.px("tool.args_max_width")).min_w_0().truncate().text_color(muted).child(t.summary()))
        .child(div().flex_1())
        .child(mono(th, div(), "code_small", cx).text_color(muted).child(took))
        .child(status_icon(th, &t.id, t.status, cx.reduce_motion()))
        .child(chevron(th, key.clone().into(), open, px(12.), muted))
        .on_click(cx.listener(move |this, _, _, cx| this.toggle(&k, cx)));
    let header = anim::press(header, th, None, cx.reduce_motion()).hover(move |s| s.bg(th.c("border.subtle")));
    let mut card = div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .border_1()
        .border_color(th.c(if error { "tool.error.border" } else { "border.subtle" }))
        .rounded(th.r("lg"))
        .bg(th.c("bg.elevated"))
        .child(header);
    let result = if t.result.is_empty() && t.status == ToolStatus::Running { "…".to_string() } else { t.result.clone() };
    let est = (text_height(&result, th.font("code_small").line_height, 110.) + 20.).min(th.n("tool.result_max_height"));
    let body = mono(th, div(), "code_small", cx)
        .id(SharedString::from(format!("{key}-result")))
        .max_h(th.px("tool.result_max_height"))
        .overflow_y_scroll()
        .px(th.sp(3))
        .py(px(10.))
        .bg(th.c("tool.result.bg"))
        .border_t_1()
        .border_color(th.c("border.subtle"))
        .text_color(th.c(if error { "tool.error.text" } else { "text.secondary" }))
        .child(result);
    card = card.children(fold_body(shell, &key, open, est, body, window));
    let diff = t.patch.as_deref().and_then(diff::parse);
    let mut out = div().flex().flex_col().gap(th.sp(2)).child(card);
    if let Some(d) = diff {
        out = out.child(diff_block(shell, th, &key, &d, window, cx));
    }
    out
}

fn gutter(th: Th, n: Option<u32>, bg: Option<Hsla>, cx: &App) -> Div {
    mono(th, div(), "code_small", cx)
        .w(th.px("diff.gutter_column"))
        .flex_none()
        .pr(th.sp(2))
        .text_right()
        .text_color(th.c("text.muted"))
        .when_some(bg, |d, bg| d.bg(bg))
        .child(n.map(|n| n.to_string()).unwrap_or_default())
}

pub fn diff_block(shell: &Shell, th: Th, key: &str, d: &DiffFile, _window: &mut Window, cx: &mut Context<Shell>) -> Div {
    let dkey = format!("{key}/diff");
    let big = d.lines.len() > th.n("limit.diff.collapse_lines") as usize;
    let expanded = !big || shell.is_open(&dkey, false);
    let pill = |text: String, bg: &str, fg: &str| {
        text_font(th, div(), "caption").px(px(6.)).py(px(1.)).rounded(th.r("full")).bg(th.c(bg)).text_color(th.c(fg)).child(text)
    };
    let path = d.path.clone();
    let header = mono(th, div(), "code", cx)
        .h(th.px("diff.header_height"))
        .px(th.sp(3))
        .flex()
        .items_center()
        .gap(th.sp(2))
        .bg(th.c("diff.header.bg"))
        .border_b_1()
        .border_color(th.c("border.subtle"))
        .child(div().flex_1().min_w_0().text_ellipsis_start().whitespace_nowrap().overflow_hidden().font_weight(FontWeight(600.)).text_color(th.c("text.primary")).child(d.path.clone()))
        .child(pill(format!("+{}", d.adds), "diff.add.bg", "diff.add.text"))
        .child(pill(format!("-{}", d.dels), "diff.del.bg", "diff.del.text"))
        .child(copy_button(shell, th, &format!("{dkey}-path"), path, cx));
    let shown = if expanded { d.lines.len() } else { DIFF_PREVIEW_LINES };
    let mut rows = div().flex().flex_col();
    for l in d.lines.iter().take(shown) {
        if l.kind == Kind::Hunk {
            rows = rows.child(
                mono(th, div(), "code_small", cx)
                    .h(th.px("diff.hunk_height"))
                    .px(th.sp(3))
                    .flex()
                    .items_center()
                    .bg(th.c("diff.hunk.bg"))
                    .text_color(th.c("diff.hunk.text"))
                    .child(l.text.clone()),
            );
            continue;
        }
        let (bg, fg, gut, word) = match l.kind {
            Kind::Add => (Some(th.c("diff.add.bg")), th.c("diff.add.text"), Some(th.c("diff.add.gutter")), th.c("diff.add.word")),
            Kind::Del => (Some(th.c("diff.del.bg")), th.c("diff.del.text"), Some(th.c("diff.del.gutter")), th.c("diff.del.word")),
            _ => (None, th.c("text.secondary"), None, th.c("diff.add.word")),
        };
        let sign = match l.kind {
            Kind::Add => "+",
            Kind::Del => "-",
            _ => " ",
        };
        let text = SharedString::from(format!("{sign}{}", l.text));
        let styled = match &l.word {
            Some(r) => StyledText::new(text).with_highlights([(r.start + 1..r.end + 1, HighlightStyle { background_color: Some(word), ..Default::default() })]),
            None => StyledText::new(text),
        };
        rows = rows.child(
            div()
                .flex()
                .when_some(bg, |d, bg| d.bg(bg))
                .child(gutter(th, l.old, gut, cx))
                .child(gutter(th, l.new, gut, cx))
                .child(mono(th, div(), "code", cx).flex_1().pl(th.sp(2)).text_color(fg).whitespace_nowrap().child(styled)),
        );
    }
    let mut block = div().flex().flex_col().overflow_hidden().border_1().border_color(th.c("border.subtle")).rounded(th.r("lg")).child(header).child(rows);
    if !expanded {
        let k = dkey.clone();
        block = block.child(
            div()
                .id(SharedString::from(format!("{dkey}-more")))
                .h(th.px("button.height"))
                .flex()
                .items_center()
                .justify_center()
                .border_t_1()
                .border_color(th.c("border.subtle"))
                .bg(th.c("bg.elevated"))
                .text_color(th.c("text.secondary"))
                .hover(|s| s.text_color(th.c("text.primary")))
                .cursor_pointer()
                .child(text_font(th, div(), "body").child(format!("展开全部 {} 行", d.lines.len())))
                .on_click(cx.listener(move |this, _, _, cx| this.toggle(&k, cx))),
        );
    }
    block
}

pub fn copy_button(shell: &Shell, th: Th, key: &str, text: String, cx: &mut Context<Shell>) -> Stateful<Div> {
    let done = shell.copied.as_ref().is_some_and(|(k, at)| k == key && at.elapsed() < th.ms("copy_hold"));
    let k = key.to_string();
    div()
        .id(SharedString::from(format!("copy-{key}")))
        .size(px(20.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(th.r("sm"))
        .cursor_pointer()
        .hover(move |s| s.bg(th.c("bg.elevated")))
        // copy → check pops in (snappy 10 → 14), holds `copy_hold`, then copy fades back (§8).
        .child(if done {
            anim::pop_size(icon("check", px(10.), th.c("semantic.success")), format!("copied-{key}"), th, 10., 14.).into_any_element()
        } else {
            anim::appear(icon("copy", px(12.), th.c("text.muted")), format!("copy-back-{key}-{}", shell.copied.is_some()), th.ms("hover"), th.ease("standard"), 0., 0.).into_any_element()
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            this.copied = Some((k.clone(), Instant::now()));
            let hold = this.th.ms("copy_hold");
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(hold).await;
                let _ = this.update(cx, |_, cx| cx.notify());
            })
            .detach();
            cx.notify();
        }))
}

#[cfg(test)]
mod tests {
    use super::{clock, elapsed, tool_icon};

    #[test]
    fn formats() {
        assert_eq!(elapsed(142), "142ms");
        assert_eq!(elapsed(1500), "1.5s");
        assert_eq!(elapsed(125_000), "2m5s");
        assert_eq!(tool_icon("bash"), "terminal");
        assert_eq!(tool_icon("mcp"), "plug");
        assert_eq!(clock(0).len(), 5);
    }
}
