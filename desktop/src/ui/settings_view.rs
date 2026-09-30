//! What the config page looks like (§7): the file nav with its sliding
//! selection, the header with the path and 「表单 | JSON」, the form generated
//! from the value's types, the JSON editor with its syntax bar, the save bar
//! and the leave / conflict prompt. Behaviour is `settings.rs`.

use super::anim;
use super::assets::icon;
use super::chat::{chevron, mono, text_font};
use super::controls::{Btn, button, icon_button, letter, rec_badge};
use super::settings::{PromptKind, SaveUi, SettingsPage};
use super::settings_model::{Control, Field, GENERAL, View, sections};
use super::theme::Th;
use crate::config_store::ConfigFile;
use gpui_kit::component::input::{Editor, Input};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::Value;
use std::time::Instant;

const SEG_W: f32 = 72.0;

/// The nav selection block's y for file `i` (only the open file lists its sections, so rows above `i` are plain).
pub fn nav_y(th: Th, files: &[ConfigFile], i: usize) -> f32 {
    let h = th.n("settings.nav_item_height");
    let mut y = th.n("space.2");
    let mut group = "";
    for f in files.iter().take(i + 1) {
        if f.group != group {
            group = f.group;
            y += h;
        }
        y += h;
    }
    y - h
}

/// A left-right shake that decays over three swings (§7.3, §7.4); none with reduced motion.
fn shake<E: Styled + IntoElement + 'static>(el: E, key: String, th: Th, reduce: bool) -> AnyElement {
    if reduce || key.ends_with("-0") {
        return el.into_any_element();
    }
    let amp = th.n("shake.amplitude");
    el.with_animation(ElementId::Name(key.into()), Animation::new(th.ms("shake")), move |el, t| {
        el.relative().left(px(amp * (t * 6.0 * std::f32::consts::PI).sin() * (1.0 - t)))
    })
    .into_any_element()
}

fn error_line(th: Th, key: &str, text: &str, reduce: bool) -> AnyElement {
    let el = text_font(th, div(), "small")
        .w_full()
        .flex()
        .items_start()
        .gap(th.sp(1))
        .pt(th.sp(1))
        .text_color(th.c("semantic.danger"))
        .child(div().pt(px(3.)).child(icon("circle-alert", px(12.), th.c("semantic.danger"))))
        .child(div().flex_1().min_w_0().child(text.to_string()));
    anim::appear(el, format!("ferr-{key}-{text}"), th.ms("field_error"), th.ease("smooth"), 0., if reduce { 0. } else { -4. }).into_any_element()
}

impl SettingsPage {
    fn nav(&mut self, now: Instant, cx: &mut Context<Self>) -> Div {
        let th = self.th;
        let h = th.px("settings.nav_item_height");
        let mut col = div().relative().w(th.px("settings.nav_width")).h_full().flex_none().flex().flex_col().px(th.sp(2)).bg(th.c("bg.surface")).border_r_1().border_color(th.c("border.subtle"));
        col = col.child(
            div().absolute().left(th.sp(2)).right(th.sp(2)).top(px(self.nav_y.value(now))).h(h).rounded(th.r("lg")).bg(th.c("bg.elevated")).child(div().absolute().left_0().top(px(6.)).bottom(px(6.)).w(px(2.)).rounded(th.r("full")).bg(th.c("accent.primary"))),
        );
        col = col.child(div().h(th.sp(2)).flex_none());
        let mut group = "";
        let titles: Vec<String> = sections(&self.state().draft.value).into_iter().map(|s| s.title).collect();
        for (i, f) in self.files.clone().into_iter().enumerate() {
            if f.group != group {
                group = f.group;
                col = col.child(text_font(th, div(), "caption").h(h).flex().items_end().pb(px(4.)).px(th.sp(2)).text_color(th.c("text.muted")).child(group));
            }
            let dirty = self.states.get(&i).is_some_and(|s| s.draft.dirty());
            let on = i == self.current;
            col = col.child(
                text_font(th, div(), "small")
                    .id(("cfg-nav", i))
                    .relative()
                    .h(h)
                    .px(th.sp(3))
                    .flex()
                    .items_center()
                    .justify_between()
                    .rounded(th.r("lg"))
                    .cursor_pointer()
                    .text_color(th.c(if on { "text.primary" } else { "text.secondary" }))
                    .when(!on, |d| d.hover(move |s| s.bg(th.ca("bg.elevated", 0.5))))
                    .child(f.label)
                    .when(dirty, |d| d.child(div().size(th.px("unread_dot")).rounded(th.r("full")).bg(th.c("semantic.warning"))))
                    .on_click(cx.listener(move |this, _, _, cx| this.open_file(i, cx))),
            );
            if on {
                for (si, t) in titles.iter().enumerate() {
                    col = col.child(
                        text_font(th, div(), "caption")
                            .id(("cfg-sec", si))
                            .h(px(22.))
                            .pl(th.sp(6))
                            .flex()
                            .items_center()
                            .cursor_pointer()
                            .text_color(th.c("text.muted"))
                            .hover(move |s| s.text_color(th.c("text.primary")))
                            .child(t.clone())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.scroll.scroll_to_top_of_item(si);
                                cx.notify();
                            })),
                    );
                }
            }
        }
        col
    }

    fn header(&mut self, cx: &mut Context<Self>) -> Div {
        let th = self.th;
        let f = &self.files[self.current];
        let path = f.path.display().to_string();
        let copied = self.copied.is_some_and(|at| at.elapsed() < th.ms("copy_hold"));
        let copy = icon_button(th, "cfg-copy", if copied { "check" } else { "copy" }, self.reduce).on_click(cx.listener(move |this, _, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
            this.copied = Some(Instant::now());
            cx.notify();
        }));
        div()
            .h(th.px("drawer.header_height"))
            .flex_none()
            .flex()
            .items_center()
            .gap(th.sp(2))
            .px(th.sp(4))
            .border_b_1()
            .border_color(th.c("border.subtle"))
            .child(text_font(th, div(), "body_strong").flex_none().child(format!("{} · {}", if f.group == "pi" { "pi 配置" } else { "门禁配置" }, f.label)))
            .child(mono(th, div(), "code_small", cx).min_w_0().truncate().text_color(th.c("text.muted")).child(f.path.display().to_string()))
            .child(copy)
            .child(div().flex_1())
            .child(self.segmented(cx))
    }

    fn segmented(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let now = Instant::now();
        let view = self.state().draft.view;
        let seg = |i: usize, glyph: &'static str, label: &'static str, on: bool, cx: &mut Context<Self>| {
            text_font(th, div(), "small")
                .id(("cfg-seg", i))
                .w(px(SEG_W))
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .gap(th.sp(1))
                .cursor_pointer()
                .text_color(th.c(if on { "text.primary" } else { "text.secondary" }))
                .child(icon(glyph, px(14.), th.c(if on { "text.primary" } else { "text.muted" })))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| this.set_view(if i == 0 { View::Form } else { View::Json }, cx)))
        };
        let el = div()
            .relative()
            .h(th.px("segmented.height"))
            .p(px(2.))
            .flex()
            .rounded(th.r("md"))
            .bg(th.c("bg.elevated"))
            .child(div().absolute().top(px(2.)).bottom(px(2.)).left(px(2. + SEG_W * self.seg.value(now))).w(px(SEG_W)).rounded(th.r("sm")).bg(th.c("bg.surface")).shadow(th.shadow("low")))
            .child(seg(0, "list", "表单", view == View::Form, cx))
            .child(seg(1, "braces", "JSON", view == View::Json, cx));
        shake(el, format!("seg-shake-{}", self.seg_shake), th, self.reduce)
    }

    /// Findings the form cannot pin to a row it shows.
    fn loose_issues(&self, fields: &[Field]) -> Vec<String> {
        let d = &self.state().draft;
        d.issues.iter().filter(|i| row_of(fields, &i.path).is_none()).map(|i| if i.path.is_empty() { i.message.clone() } else { format!("{}：{}", i.path, i.message) }).collect()
    }

    fn form(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let secs = sections(&self.state().draft.value);
        let all: Vec<Field> = secs.iter().flat_map(|s| s.fields.clone()).collect();
        let loose = self.loose_issues(&all);
        if secs.is_empty() {
            let msg = if self.state().draft.disk.is_none() { "还没有这个文件，保存后创建 —— 在 JSON 视图里写入内容" } else { "这个文件是空对象 —— 在 JSON 视图里添加字段" };
            return text_font(th, div(), "body").size_full().flex().items_center().justify_center().text_color(th.c("text.muted")).child(msg).into_any_element();
        }
        let mut list = div().id("cfg-scroll").size_full().overflow_y_scroll().track_scroll(&self.scroll).pb(th.px("settings.save_bar_height"));
        for s in &secs {
            let mut card = div().flex().flex_col().px(th.px("settings.group_padding_x")).rounded(th.r("xl")).bg(th.c("bg.surface")).border_1().border_color(th.c("border.subtle"));
            let shown: Vec<&Field> = s.fields.iter().filter(|f| !self.folded.iter().any(|g| f.path.starts_with(&format!("{g}.")))).collect();
            for (n, f) in shown.into_iter().enumerate() {
                let row = self.row(f, &all, window, cx);
                card = card.child(div().when(n > 0, |d| d.border_t_1().border_dashed().border_color(th.c("border.subtle"))).child(row));
            }
            list = list.child(
                div()
                    .w_full()
                    .max_w(th.px("settings.content_max_width"))
                    .mx_auto()
                    .px(th.sp(4))
                    .child(text_font(th, div(), "title").h(th.px("settings.section_header_height")).flex().items_end().pb(th.sp(2)).child(if s.title == GENERAL { GENERAL.to_string() } else { s.title.clone() }))
                    .child(card),
            );
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .when(!loose.is_empty(), |d| d.child(banner(th, "circle-alert", &loose.join("\n"), "tool.error.header_bg", "tool.error.text")))
            .child(div().flex_1().min_h_0().relative().child(list).children(anim::scroll_fades(th, &self.scroll, th.c("bg.app"))))
            .into_any_element()
    }

    fn row(&mut self, f: &Field, all: &[Field], window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let d = &self.state().draft;
        let error = d.field_errors.get(&f.path).cloned().or_else(|| d.issues.iter().find(|i| row_of(all, &i.path).map(|r| r.path.as_str()) == Some(f.path.as_str())).map(|i| i.message.clone()));
        let path = f.path.clone();
        let label = div().flex().items_center().gap(th.sp(1)).min_w(px(140.)).child(text_font(th, div(), "body_strong").child(f.key.clone()));
        let control: AnyElement = match &f.control {
            Control::Bool(b) => {
                let b = *b;
                switch(th, &f.path, b, self.reduce).on_click(cx.listener(move |this, _, _, cx| this.edit(|d| d.set(&path, Value::Bool(!b)), false, cx))).into_any_element()
            }
            Control::Number(_) | Control::Text(_) => {
                let masked = f.sensitive && !self.revealed.contains(&f.path);
                let e = self.input(&f.path, matches!(f.control, Control::Number(_)), masked, window, cx);
                let eye = f.sensitive.then(|| {
                    let p = path.clone();
                    icon_button(th, SharedString::from(format!("eye-{p}")), "eye", self.reduce).on_click(cx.listener(move |this, _, _, cx| {
                        if !this.revealed.remove(&p) {
                            this.revealed.insert(p.clone());
                        }
                        cx.notify();
                    }))
                });
                div().flex().items_center().gap(th.sp(1)).child(text_box(th, &e, error.is_some()).w(px(300.))).children(eye).into_any_element()
            }
            Control::List(items) => self.list(&f.path, items.len(), window, cx),
            Control::Group => {
                let open = !self.folded.contains(&f.path);
                let p = path.clone();
                return div()
                    .id(SharedString::from(format!("grp-{p}")))
                    .pl(th.sp(4) * f.depth as f32)
                    .py(th.px("settings.row_padding_y"))
                    .flex()
                    .items_center()
                    .gap(th.sp(1))
                    .cursor_pointer()
                    .flex_col()
                    .items_start()
                    .child(div().flex().items_center().gap(th.sp(1)).child(chevron(th, SharedString::from(format!("cfg-{p}")), open, px(14.), th.c("text.muted"))).child(text_font(th, div(), "body_strong").child(f.key.clone())))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.folded.remove(&p) {
                            this.folded.insert(p.clone());
                        }
                        cx.notify();
                    }))
                    .when_some(error, |d, e| d.child(error_line(th, &f.path, &e, self.reduce)))
                    .into_any_element();
            }
            Control::ReadOnly(v) => div()
                .flex()
                .flex_col()
                .items_end()
                .child(mono(th, div(), "code_small", cx).max_w(px(300.)).truncate().text_color(th.c("text.secondary")).child(v.clone()))
                .child(text_font(th, div(), "caption").text_color(th.c("text.muted")).child("在 JSON 视图里编辑"))
                .into_any_element(),
        };
        div()
            .pl(th.sp(4) * f.depth as f32)
            .py(th.px("settings.row_padding_y"))
            .flex()
            .flex_col()
            .child(div().flex().items_start().justify_between().gap(th.sp(4)).child(label).child(control))
            .when_some(error, |d, e| d.child(error_line(th, &f.path, &e, self.reduce)))
            .into_any_element()
    }

    /// A string array as an ordered list: ↑ ↓ 删除 per item, 「+ 添加」 at the end (§7.2).
    fn list(&mut self, path: &str, n: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let mut col = div().w(px(360.)).flex().flex_col().gap(th.sp(1));
        for i in 0..n {
            let e = self.input(&format!("{path}.{i}"), false, false, window, cx);
            let btn = |glyph: &'static str, cx: &mut Context<Self>, op: fn(&mut super::settings_model::Draft, &str, usize)| {
                let p = path.to_string();
                icon_button(th, SharedString::from(format!("{glyph}-{path}-{i}")), glyph, self.reduce).on_click(cx.listener(move |this, _, _, cx| this.edit(|d| op(d, &p, i), true, cx)))
            };
            // Fixed button slots, so the text boxes line up whatever moves are possible.
            let slot = || div().size(th.px("titlebar.button")).flex_none();
            let up = if i > 0 { btn("arrow-up", cx, |d, p, i| d.list_move(p, i, true)).into_any_element() } else { slot().into_any_element() };
            let down = if i + 1 < n { btn("arrow-down", cx, |d, p, i| d.list_move(p, i, false)).into_any_element() } else { slot().into_any_element() };
            let item = div().flex().items_center().gap(px(2.)).child(text_box(th, &e, false).flex_1()).child(up).child(down).child(btn("trash-2", cx, |d, p, i| d.list_remove(p, i)));
            col = col.child(anim::appear(item, format!("li-{path}-{i}-{n}"), th.ms("collapse"), th.ease("smooth"), 0., 0.));
        }
        let p = path.to_string();
        let add = button(th, SharedString::from(format!("add-{path}")), Btn::Ghost, false, "添加", self.reduce)
            .child(icon("plus", px(14.), th.c("text.secondary")))
            .on_click(cx.listener(move |this, _, _, cx| this.edit(|d| d.list_push(&p), true, cx)));
        col.child(div().child(add)).into_any_element()
    }

    fn json(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let d = &self.state().draft;
        let secret = super::settings_model::parse(&d.text).is_ok_and(|v| has_secret(&v));
        let err = d.syntax_error();
        let loose: Vec<String> = d.issues.iter().map(|i| if i.path.is_empty() { i.message.clone() } else { format!("{}：{}", i.path, i.message) }).collect();
        let e = self.json_editor(window, cx);
        let bar = err.map(|e| {
            let text = format!("JSON 有语法错误（第 {} 行第 {} 列）：{} · 修好后才能切回表单", e.line, e.column, e.message);
            div().id("cfg-syntax").cursor_pointer().child(banner(th, "circle-alert", &text, "tool.error.header_bg", "tool.error.text")).on_click(cx.listener(|this, _, window, cx| this.jump_to_syntax_error(window, cx)))
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .when(secret, |d| d.child(banner(th, "shield-alert", "JSON 视图会显示明文密钥", "bg.surface", "semantic.warning")))
            .children(bar)
            .when(!loose.is_empty(), |d| d.child(banner(th, "circle-alert", &loose.join("\n"), "tool.error.header_bg", "tool.error.text")))
            .child(mono(th, div(), "code", cx).flex_1().min_h_0().pb(th.px("settings.save_bar_height")).bg(th.c("code.block.bg")).child(Editor::new(&e).appearance(false).h_full()))
            .into_any_element()
    }

    fn save_bar(&mut self, now: Instant, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        let h = th.n("settings.save_bar_height");
        let errors = self.state().draft.error_count();
        let name = self.files[self.current].path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (text, danger) = match &self.save_ui {
            SaveUi::Failed(m) => (m.clone(), true),
            SaveUi::Saving => ("正在用 prg 校验并保存…".into(), false),
            SaveUi::Saved(_) => ("已保存".into(), false),
            SaveUi::Idle => (format!("有未保存的修改 · 保存前会把原文件备份到 {name}.bak-<时间>"), false),
        };
        let saved = matches!(self.save_ui, SaveUi::Saved(_));
        let save = if saved {
            let el = button(th, "cfg-save", Btn::Primary, false, "已保存", self.reduce).child(anim::pop_size(icon("check", px(0.), th.c("text.on_accent")), "cfg-saved-check", th, 10., 14.));
            anim::fade_bg(el, "cfg-saved-bg", th, th.c("accent.primary"), th.c("semantic.success"), "dot_color").into_any_element()
        } else if errors > 0 {
            button(th, "cfg-save", Btn::Secondary, false, format!("{errors} 处错误"), self.reduce).text_color(th.c("text.disabled")).cursor_default().into_any_element()
        } else {
            button(th, "cfg-save", Btn::Primary, false, if self.save_ui == SaveUi::Saving { "保存中…" } else { "保存 ⌘S" }, self.reduce).on_click(cx.listener(|this, _, window, cx| this.save(false, None, window, cx))).into_any_element()
        };
        let bar = div()
            .h(px(h))
            .w_full()
            .px(th.sp(4))
            .flex()
            .items_center()
            .gap(th.sp(2))
            .bg(th.c("bg.surface"))
            .border_t_1()
            .border_color(th.c("border.subtle"))
            .child(text_font(th, div(), "small").flex_1().min_w_0().truncate().text_color(th.c(if danger { "semantic.danger" } else { "text.secondary" })).child(text))
            .when(!saved, |d| d.child(button(th, "cfg-discard", Btn::Secondary, false, "放弃修改", self.reduce).on_click(cx.listener(|this, _, _, cx| this.discard(cx)))))
            .child(save);
        let up = self.bar.value(now);
        let bar = shake(bar, format!("bar-shake-{}", self.bar_shake), th, self.reduce);
        let el = div().absolute().left_0().right_0().bottom(px(-h * (1. - up))).child(bar);
        if self.reduce { el.opacity(up).into_any_element() } else { el.into_any_element() }
    }

    fn prompt(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let th = self.th;
        let p = self.prompt.as_ref()?;
        let title = match p.kind {
            PromptKind::Leave => "有未保存的修改，要离开配置页吗？",
            PromptKind::Conflict => "这个文件在你打开之后被别处改过",
        };
        let mut rows = div().flex().flex_col().gap(th.px("choice.row_gap"));
        for (i, o) in p.options().iter().enumerate() {
            let on = i == p.focus;
            rows = rows.child(
                text_font(th, div(), "body")
                    .id(("cfg-opt", i))
                    .min_h(th.px("choice.row_min_height"))
                    .px(th.sp(3))
                    .flex()
                    .items_center()
                    .gap(th.sp(2))
                    .rounded(th.r("lg"))
                    .border_1()
                    .border_color(th.c(if on { "border.focus" } else { "border.subtle" }))
                    .bg(th.c(if on { "accent.subtle" } else { "bg.surface" }))
                    .cursor_pointer()
                    .child(format!("{}. {o}", letter(i)))
                    .when(i == 0, |d| d.child(rec_badge(th)))
                    .on_click(cx.listener(move |this, _, window, cx| this.answer(i, window, cx))),
            );
        }
        let esc = if p.kind == PromptKind::Leave { "Esc = 继续编辑 · ↑↓ 选择 · Enter 确定" } else { "Esc = 暂不处理 · ↑↓ 选择 · Enter 确定" };
        let shift = if self.reduce { 0. } else { th.n("drawer.content_shift") };
        let panel = div()
            .size_full()
            .p(th.px("drawer.padding"))
            .flex()
            .flex_col()
            .gap(th.sp(4))
            .bg(th.c("bg.surface"))
            .border_l_1()
            .border_color(th.c("border.default"))
            .shadow(th.shadow("high"))
            .child(text_font(th, div(), "title").child(title))
            .child(rows)
            .child(text_font(th, div(), "small").text_color(th.c("text.muted")).child(esc));
        Some(
            div()
                .absolute()
                .inset_0()
                .child(anim::appear(div().absolute().inset_0().bg(th.c("bg.scrim_drawer")), "cfg-scrim", th.ms("scrim_enter"), th.ease("smooth"), 0., 0.))
                .child(div().absolute().top_0().bottom_0().right_0().w(th.px("drawer.choice_width")).child(anim::appear(panel, format!("cfg-prompt-{:?}", p.kind), th.ms("drawer_enter"), th.ease("smooth"), shift, 0.)))
                .into_any_element(),
        )
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = self.th;
        let now = Instant::now();
        if self.tick(now) {
            window.request_animation_frame();
        }
        let nav = self.nav(now, cx);
        let header = self.header(cx);
        let body = match self.state().draft.view {
            View::Form => self.form(window, cx),
            View::Json => self.json(window, cx),
        };
        let fade = anim::appear(div().size_full().child(body), format!("cfg-view-{}-{:?}", self.current, self.state().draft.view), th.ms("page_enter"), th.ease("smooth"), 0., 0.);
        let bar = self.save_bar(now, cx);
        let prompt = self.prompt(cx);
        div()
            .id("settings")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .flex()
            .bg(th.c("bg.app"))
            .child(nav)
            .child(div().relative().flex_1().min_w_0().h_full().flex().flex_col().overflow_hidden().child(header).child(div().flex_1().min_h_0().child(fade)).child(bar))
            .children(prompt)
    }
}

/// The field row a validator finding belongs to: the deepest shown row at or above its path.
fn row_of<'a>(fields: &'a [Field], path: &str) -> Option<&'a Field> {
    fields.iter().filter(|f| path == f.path || path.starts_with(&format!("{}.", f.path))).max_by_key(|f| f.path.len())
}

fn has_secret(v: &Value) -> bool {
    match v {
        Value::Object(m) => m.iter().any(|(k, v)| (super::settings_model::is_sensitive(k) && v.is_string()) || has_secret(v)),
        Value::Array(a) => a.iter().any(has_secret),
        _ => false,
    }
}

fn banner(th: Th, glyph: &'static str, text: &str, bg: &str, fg: &str) -> Div {
    text_font(th, div(), "small").w_full().px(th.sp(4)).py(th.sp(2)).flex().items_start().gap(th.sp(2)).bg(th.c(bg)).text_color(th.c(fg)).child(icon(glyph, px(14.), th.c(fg))).child(div().flex_1().min_w_0().child(text.to_string()))
}

fn text_box(th: Th, e: &Entity<gpui_kit::component::input::InputState>, bad: bool) -> Div {
    text_font(th, div(), "body")
        .h(th.px("button.height"))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(th.r("md"))
        .bg(th.c("bg.app"))
        .border_1()
        .border_color(th.c(if bad { "semantic.danger" } else { "border.default" }))
        .child(div().flex_1().child(Input::new(e).appearance(false)))
}

/// A boolean as a switch; the knob slides when the value flips.
fn switch(th: Th, path: &str, on: bool, reduce: bool) -> Stateful<Div> {
    let (w, k) = (32.0, 14.0);
    let (from, to) = if on { (2.0, w - k - 2.0) } else { (w - k - 2.0, 2.0) };
    let knob = div().absolute().top(px(2.)).size(px(k)).rounded(th.r("full")).bg(th.c("text.on_accent"));
    let knob = if reduce {
        knob.left(px(to)).into_any_element()
    } else {
        let s = th.spring("snappy");
        knob.with_animation(ElementId::Name(format!("sw-{path}-{on}").into()), Animation::new(s.duration()).with_easing(move |t| s.ease(t)), move |el, t| el.left(px(from + (to - from) * t))).into_any_element()
    };
    div()
        .id(SharedString::from(format!("sw-{path}")))
        .relative()
        .w(px(w))
        .h(px(k + 4.))
        .flex_none()
        .rounded(th.r("full"))
        .cursor_pointer()
        .bg(th.c(if on { "accent.primary" } else { "border.strong" }))
        .child(knob)
}
