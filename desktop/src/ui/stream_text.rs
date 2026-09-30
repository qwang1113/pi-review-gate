//! Streamed words fading in (§5.1): the view side of `motion::StreamFade`.
//! Settled lines render as markdown; the line still arriving renders as
//! styled text whose fresh words carry their alpha on the run colour (GPUI
//! has no blur and no per-glyph opacity in markdown, so this is the seam).

use super::chat::markdown_style;
use super::chat_model::{Block, Item};
use super::motion::{self, StreamFade};
use super::theme::Th;
use crate::app::Shell;
use gpui_kit::component::text::TextView;
use gpui_kit::*;

impl Shell {
    /// Register streamed text before painting: new bytes of the running message
    /// get fade times; text that was there when the session was selected never fades.
    pub fn observe_stream(&mut self, sid: &str) {
        let th = self.th;
        let now = crate::hub::now_ms();
        let base = self.enter_from.get(sid).copied().unwrap_or(0);
        let st = self.hub.lock();
        let Some(chat) = st.chats.get(sid) else { return };
        let last = chat.items.len().saturating_sub(1);
        let Some(Item::Assistant { blocks, streaming: true, .. }) = chat.items.last() else { return };
        let (stagger, cap) = (th.ms("word_stagger").as_millis() as u64, th.n("limit.stream.word_stagger_cap") as u64);
        for (j, b) in blocks.iter().enumerate() {
            let text = match b {
                Block::Text { text, .. } | Block::Thinking { text, .. } => text,
                Block::Tool(_) => continue,
            };
            let key = format!("{sid}/{last}/{j}");
            let first = !self.fades.contains_key(&key) && last < base;
            self.fades.entry(key).or_default().observe(text, now, stagger, cap, first);
        }
        drop(st);
        let fade = th.ms("word_fade").as_millis() as u64;
        self.fades.retain(|k, f| f.prune(now, fade) || k.starts_with(&format!("{sid}/{last}/")));
    }
}

/// Plain streamed text (the thinking body): the whole block as styled text,
/// fresh words fading in over `color`.
pub fn plain(th: Th, text: &str, fade: Option<&StreamFade>, color: Hsla, reduce: bool, window: &mut Window) -> AnyElement {
    let Some(fade) = fade.filter(|f| !reduce && !f.words.is_empty()) else {
        return div().child(text.to_string()).into_any_element();
    };
    window.request_animation_frame();
    let ease = th.curve("smooth");
    let runs = motion::fade_runs(&fade.words, 0, text.len(), crate::hub::now_ms(), th.ms("word_fade").as_millis() as u64).into_iter().map(|(r, p)| {
        let mut c = color;
        c.a *= ease.at(p);
        (r, HighlightStyle { color: Some(c), ..Default::default() })
    });
    div().child(StyledText::new(text.to_string()).with_highlights(runs)).into_any_element()
}

/// One text block of an assistant message; `fade` is set while it streams.
pub fn render(th: Th, key: &str, text: &str, fade: Option<&StreamFade>, cursor: bool, reduce: bool, window: &mut Window) -> AnyElement {
    let md = |src: String| TextView::markdown(ElementId::Name(key.to_string().into()), src).style(markdown_style(th)).selectable(true).text_color(th.c("text.primary"));
    let with_cursor = |s: &str| if cursor { format!("{s}▍") } else { s.to_string() };
    let Some((fade, at)) = fade.filter(|_| !reduce).and_then(|f| f.fresh_from().map(|at| (f, at))) else {
        return md(with_cursor(text)).into_any_element();
    };
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    // Inside an open code fence the markdown owns the layout: no fade there.
    if text[..line_start].matches("```").count() % 2 == 1 {
        return md(with_cursor(text)).into_any_element();
    }
    window.request_animation_frame();
    let base = th.c("text.primary");
    let ease = th.curve("smooth");
    let runs = motion::fade_runs(&fade.words, line_start, text.len(), crate::hub::now_ms(), th.ms("word_fade").as_millis() as u64)
        .into_iter()
        .map(|(r, p)| {
            let mut c = base;
            c.a *= ease.at(p);
            (r.start - line_start..r.end - line_start, HighlightStyle { color: Some(c), ..Default::default() })
        })
        .collect::<Vec<_>>();
    let tail = div().text_color(base).child(StyledText::new(with_cursor(&text[line_start..])).with_highlights(runs));
    if line_start == 0 {
        return tail.into_any_element();
    }
    div().flex().flex_col().child(md(text[..line_start].to_string())).child(tail).into_any_element()
}
