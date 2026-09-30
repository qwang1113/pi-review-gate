//! The window shell: title bar, session list, chat, composer, gate dialogs,
//! status strip and the in-app banner, assembled from `crate::ui`. Owns the
//! view-only state (focus, folds, drafts, scroll); session state is the hub's.

use crate::hub::Hub;
use crate::protocol::DialogParams;
use crate::rpc::UiRequest;
#[cfg(feature = "shots")]
use crate::ui::dialog_state::Row;
use crate::ui::dialog_state::DialogUi;
use crate::ui::sidebar_model::{self, Group, Inputs};
use crate::ui::theme::Th;
use crate::ui::{self, assets::icon, chat, chat::text_font, dialogs, sidebar, status};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub enum ActiveDialog {
    Gate(DialogParams),
    Native(UiRequest),
}

pub(crate) struct Banner {
    pub session: Option<String>,
    pub title: String,
    pub body: String,
    pub at: Instant,
}

const BANNER_TTL: Duration = Duration::from_secs(4);

pub struct Shell {
    pub hub: Arc<Hub>,
    cwd: String,
    pub(crate) demo: bool,
    pub th: Th,
    composer: Entity<TextareaState>,
    pub reason_editors: HashMap<String, Entity<TextareaState>>,
    pub dialog_uis: HashMap<String, DialogUi>,
    /// Fold keys flipped away from their default (§5.2–5.4).
    toggled: HashSet<String>,
    pub chat_scroll: ScrollHandle,
    /// Auto-follow: the chat sticks to the bottom until the user scrolls up (§5.1).
    pub follow: bool,
    followed_rev: u64,
    /// Per dialog: the long box keeps its reading position across session switches.
    pub doc_scrolls: HashMap<String, ScrollHandle>,
    pub collapsed_groups: HashSet<Group>,
    rail_manual: bool,
    pub sidebar_w: f32,
    pub dragging: bool,
    pub dialog_focus: FocusHandle,
    pub copied: Option<(String, Instant)>,
    pub switch_seq: usize,
    /// Last clock phase painted (cursor blink half-period / whole seconds of a running tool).
    clock_phase: u64,
    /// The long box's (offset, max) last painted: its layout (markdown parses off-thread)
    /// lands after the render that read it, so the progress bar needs a follow-up paint.
    doc_seen: (Pixels, Pixels),
    pub(crate) banner: Option<Banner>,
    pub(crate) error: Option<String>,
    seen: u64,
    _subs: Vec<Subscription>,
}

impl Shell {
    pub fn new(hub: Arc<Hub>, cwd: String, demo: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let th = Th { dark: appearance_is_dark(window) };
        ui::apply_theme(th, cx);
        let composer = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 7).submit_on_enter(true).placeholder("向 pi 发送消息（Enter 发送，Shift+Enter 换行）"));
        let weak = cx.entity().downgrade();
        let subs = vec![
            cx.subscribe_in(&composer, window, |this, _, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = ev {
                    this.send_prompt(window, cx);
                }
            }),
            cx.observe_window_activation(window, |this, window, _| this.hub.set_frontmost(window.is_window_active())),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.th = Th { dark: appearance_is_dark(window) };
                ui::apply_theme(this.th, cx);
                cx.notify();
            }),
            // Global shortcuts and ⌘Enter in the reason editor run before any text input sees the key.
            cx.intercept_keystrokes(move |ev, window, cx| {
                let _ = weak.update(cx, |this, cx| this.intercept(&ev.keystroke, window, cx));
            }),
        ];
        cx.spawn_in(window, async move |this, cx| {
            let mut ticks = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                ticks += 1;
                let reduce = ticks % 20 == 1 && ui::system_reduce_motion();
                let check = ticks % 20 == 1;
                if this.update_in(cx, |this, window, cx| this.poll(check.then_some(reduce), window, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Shell {
            hub,
            cwd,
            demo,
            th,
            composer,
            reason_editors: HashMap::new(),
            dialog_uis: HashMap::new(),
            toggled: HashSet::new(),
            chat_scroll: ScrollHandle::new(),
            follow: true,
            followed_rev: 0,
            doc_scrolls: HashMap::new(),
            collapsed_groups: HashSet::new(),
            rail_manual: false,
            sidebar_w: th.n("sidebar.width_default"),
            dragging: false,
            dialog_focus: cx.focus_handle(),
            copied: None,
            switch_seq: 0,
            clock_phase: 0,
            doc_seen: (px(0.), px(0.)),
            banner: None,
            error: None,
            seen: u64::MAX,
            _subs: subs,
        }
    }

    fn poll(&mut self, reduce: Option<bool>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(r) = reduce {
            cx.set_reduce_motion(r);
        }
        if self.hub.take_activate_request() {
            cx.activate(true);
            window.activate_window();
            self.focus_dialog_if_any(window, cx);
        }
        if let Some(n) = self.hub.lock().banner.take() {
            self.banner = Some(Banner { session: n.focus_host_session_id, title: n.title, body: n.body, at: Instant::now() });
        }
        let v = self.hub.version();
        if v != self.seen {
            self.seen = v;
            self.sync_dialogs(window, cx);
            let rev = self.selected().and_then(|s| self.hub.lock().chats.get(&s).map(|c| c.rev)).unwrap_or(0);
            if self.follow && rev != self.followed_rev {
                self.followed_rev = rev;
                self.chat_scroll.scroll_to_bottom();
            }
            cx.notify();
        }
        if let Some(s) = self.selected().and_then(|s| self.active_dialog(&s)).and_then(|(k, _)| self.doc_scrolls.get(&k)) {
            let now = (s.offset().y, s.max_offset().y);
            if now != self.doc_seen {
                self.doc_seen = now;
                cx.notify();
            }
        }
        // The streaming cursor and running-tool timers are clock-driven: repaint on
        // each blink half-period instead of every frame.
        let ticking = self.selected().is_some_and(|s| {
            let st = self.hub.lock();
            st.chats.get(&s).is_some_and(|c| c.running || c.tools.values().any(|t| t.status == crate::ui::chat_model::ToolStatus::Running))
        });
        if ticking {
            let phase = crate::hub::now_ms() / (self.th.ms("cursor_blink").as_millis() as u64 / 2).max(1);
            if phase != self.clock_phase {
                self.clock_phase = phase;
                cx.notify();
            }
        }
        if self.banner.as_ref().is_some_and(|b| b.at.elapsed() > BANNER_TTL) {
            self.banner = None;
            cx.notify();
        }
    }

    pub fn selected(&self) -> Option<String> {
        self.hub.lock().focused.clone()
    }

    pub fn chat_at_bottom(&self) -> bool {
        -self.chat_scroll.offset().y >= self.chat_scroll.max_offset().y - px(8.)
    }

    fn is_rail(&self, width: Pixels) -> bool {
        self.rail_manual || width < self.th.px("breakpoint.rail")
    }

    pub fn chat_width(&self, width: Pixels) -> Pixels {
        width - if self.is_rail(width) { self.th.px("sidebar.rail_width") } else { px(self.sidebar_w) }
    }

    pub fn is_open(&self, key: &str, default: bool) -> bool {
        default ^ self.toggled.contains(key)
    }

    pub fn toggle(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.toggled.remove(key) {
            self.toggled.insert(key.to_string());
        }
        cx.notify();
    }

    pub fn select(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if id == self.selected() {
            return;
        }
        self.hub.set_focused(id);
        self.switch_seq += 1;
        self.follow = true;
        self.chat_scroll.scroll_to_bottom();
        self.focus_dialog_if_any(window, cx);
        cx.notify();
    }

    pub(crate) fn focus_dialog_if_any(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((key, _)) = self.selected().and_then(|s| self.active_dialog(&s)) {
            match self.reason_editors.get(&key).filter(|_| self.dialog_uis.get(&key).is_some_and(|u| u.reason_open)) {
                Some(e) => e.update(cx, |e, cx| e.focus(window, cx)),
                None => window.focus(&self.dialog_focus, cx),
            }
        }
    }

    fn visible_order(&self) -> Vec<String> {
        sidebar_model::visible_ids(&self.groups(), &self.collapsed_groups)
    }

    fn groups(&self) -> Vec<sidebar_model::GroupRows> {
        let st = self.hub.lock();
        let running = |id: &str| st.chats.get(id).is_some_and(|c| c.running);
        let asking = |id: &str| st.dialogs.iter().any(|d| d.owner == id) || st.ui_requests.iter().any(|u| u.session == id);
        sidebar_model::build(&Inputs { sessions: st.tree.all(), unread: &st.unread, running: &running, asking: &asking })
    }

    /// Global keys (§12), seen before any focused text input.
    fn intercept(&mut self, ks: &Keystroke, window: &mut Window, cx: &mut Context<Self>) {
        let m = ks.modifiers;
        let sel = self.selected();
        let dialog = sel.as_deref().and_then(|s| self.active_dialog(s)).map(|(k, _)| k);
        let composer_focused = self.composer.read(cx).focus_handle(cx).contains_focused(window, cx);
        let handled = match (m.platform, m.shift, m.alt, ks.key.as_str()) {
            (true, false, false, "enter") => match dialog.clone().filter(|k| self.reason_focused(k, window, cx)) {
                Some(k) => {
                    self.submit_reason(&k, window, cx);
                    true
                }
                None => false,
            },
            (true, false, false, d) if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() && d != "0" => {
                let n = (d.as_bytes()[0] - b'1') as usize;
                if let Some(id) = self.visible_order().get(n).cloned() {
                    self.select(Some(id), window, cx);
                }
                true
            }
            (true, false, false, "[" | "]") => {
                let order = self.visible_order();
                if !order.is_empty() {
                    let at = sel.as_ref().and_then(|s| order.iter().position(|o| o == s)).unwrap_or(0);
                    let next = if ks.key == "]" { (at + 1) % order.len() } else { (at + order.len() - 1) % order.len() };
                    self.select(Some(order[next].clone()), window, cx);
                }
                true
            }
            (true, true, false, "a") => {
                if let Some(id) = sidebar_model::next_waiting(&self.groups(), sel.as_deref()) {
                    self.select(Some(id), window, cx);
                }
                true
            }
            (true, false, false, "b") => {
                self.rail_manual = !self.rail_manual;
                true
            }
            (true, false, false, "l") => {
                self.composer.update(cx, |c, cx| c.focus(window, cx));
                true
            }
            (true, false, false, "j") if dialog.is_some() => {
                self.focus_dialog_if_any(window, cx);
                true
            }
            (true, false, false, "up") if !composer_focused => {
                self.chat_scroll.scroll_to_top_of_item(0);
                self.follow = false;
                true
            }
            (true, false, false, "down") if !composer_focused => {
                self.chat_scroll.scroll_to_bottom();
                self.follow = true;
                true
            }
            (false, false, false, "pageup" | "pagedown") if !composer_focused && dialog.is_none() => {
                let mut off = self.chat_scroll.offset();
                let page = window.viewport_size().height * 0.8;
                off.y += if ks.key == "pageup" { page } else { -page };
                self.chat_scroll.set_offset(off);
                self.follow = self.chat_at_bottom();
                true
            }
            (false, false, false, "escape") if composer_focused => {
                match sel.filter(|s| self.hub.lock().chats.get(s).is_some_and(|c| c.running)) {
                    Some(s) => drop(self.hub.abort(&s)),
                    None => window.blur(cx),
                }
                true
            }
            _ => false,
        };
        if handled {
            cx.stop_propagation();
            cx.notify();
        }
    }

    fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        let Some(id) = self.selected() else { return };
        if text.trim().is_empty() {
            return;
        }
        let sent = if self.demo {
            let ev = serde_json::json!({"type": "message_start", "message": {"role": "user", "content": text}});
            self.hub.on_output(&id, crate::rpc::Output::Record(crate::rpc::Record::Event { kind: "message_start".into(), raw: ev }));
            Ok(())
        } else {
            self.hub.prompt(&id, &text)
        };
        match sent {
            Ok(()) => {
                self.composer.update(cx, |s, cx| s.set_value("", window, cx));
                self.follow = true;
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    /// `--shots`: put the window into one demo state.
    #[cfg(feature = "shots")]
    pub fn demo_state(&mut self, dark: bool, rail: bool, select: &str, open: &[&str], reason: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        self.th = Th { dark };
        ui::apply_theme(self.th, cx);
        self.rail_manual = rail;
        self.toggled = open.iter().map(|s| s.to_string()).collect();
        self.select(Some(select.to_string()), window, cx);
        if !open.is_empty() {
            // Show the expanded blocks, which sit above the fold.
            self.follow = false;
            self.chat_scroll.set_offset(point(px(0.), px(0.)));
        }
        if let Some(text) = reason
            && let Some((key, _)) = self.active_dialog(select)
        {
            self.dialog_activate(&key, Row::Decline, window, cx);
            if let Some(e) = self.reason_editors.get(&key) {
                e.update(cx, |e, cx| e.set_value(text.to_string(), window, cx));
            }
        }
        cx.notify();
    }

    fn composer_view(&self, sid: &str, window: &Window, cx: &mut Context<Self>) -> Div {
        let th = self.th;
        let running = self.hub.lock().chats.get(sid).is_some_and(|c| c.running);
        let dead = !self.hub.lock().tree.is_alive(sid);
        let has_text = !self.composer.read(cx).value().trim().is_empty();
        let b = th.px("composer.button");
        let button = div().id("composer-send").size(b).flex_none().rounded(th.r("md")).flex().items_center().justify_center();
        let button = if running {
            button.bg(th.c("semantic.danger")).cursor_pointer().child(div().size(px(10.)).rounded(th.r("xs")).bg(th.c("text.on_accent"))).on_click(cx.listener(|this, _, _, cx| {
                if let Some(s) = this.selected() {
                    drop(this.hub.abort(&s));
                }
                cx.notify();
            }))
        } else if has_text {
            button
                .bg(th.c("accent.primary"))
                .hover(move |s| s.bg(th.c("accent.hover")))
                .cursor_pointer()
                .child(icon("arrow-up", px(16.), th.c("text.on_accent")))
                .on_click(cx.listener(|this, _, window, cx| this.send_prompt(window, cx)))
        } else {
            button.bg(th.c("bg.elevated")).child(icon("arrow-up", px(16.), th.c("text.disabled")))
        };
        let focused = self.composer.read(cx).focus_handle(cx).contains_focused(window, cx);
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
                .when(focused, |d| d.shadow(vec![dialogs::ring(th)]))
                .when(!focused, |d| d.hover(move |s| s.border_color(th.c("border.strong"))))
                .child(div().flex_1().min_w_0().py(px(2.)).child(Textarea::new(&self.composer).appearance(false).disabled(dead)))
                .child(button),
        )
    }

    fn titlebar(&self, name: &str) -> Div {
        let th = self.th;
        div()
            .h(th.px("titlebar.height"))
            .flex_none()
            .flex()
            .items_center()
            .pl(th.px("titlebar.title_x"))
            .bg(th.c("bg.surface"))
            .border_b_1()
            .border_color(th.c("border.subtle"))
            .window_control_area(WindowControlArea::Drag)
            .child(text_font(th, div(), "body_strong").text_color(th.c("text.primary")).child(name.to_string()))
    }

    fn banner_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let th = self.th;
        let b = self.banner.as_ref()?;
        let target = b.session.clone();
        let body = b.body.lines().next().unwrap_or("").to_string();
        Some(
            div()
                .id("banner")
                .absolute()
                .top(th.px("titlebar.height") + th.sp(3))
                .right(th.sp(4))
                .w(px(320.))
                .p(th.sp(3))
                .flex()
                .gap(th.sp(3))
                .rounded(th.r("lg"))
                .bg(th.c("bg.overlay"))
                .border_1()
                .border_color(th.c("border.default"))
                .shadow(th.shadow("low"))
                .cursor_pointer()
                .child(icon("bell", px(16.), th.c("accent.primary")))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(text_font(th, div(), "body_strong").text_color(th.c("text.primary")).truncate().child(b.title.clone()))
                        .child(text_font(th, div(), "small").text_color(th.c("text.secondary")).truncate().child(body)),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.banner = None;
                    if target.is_some() {
                        this.select(target.clone(), window, cx);
                    }
                    cx.notify();
                }))
                .with_animation(ElementId::Name(format!("banner-{:?}", b.at).into()), Animation::new(th.ms("toast")).with_easing(th.ease("emphasized")), |d, t| {
                    d.opacity(t).mt(px(-8. * (1. - t)))
                })
                .into_any_element(),
        )
    }
}

fn appearance_is_dark(window: &Window) -> bool {
    match std::env::var("PI_DESKTOP_APPEARANCE").as_deref() {
        Ok("light") => false,
        Ok("dark") => true,
        _ => matches!(window.appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark),
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = self.th;
        let win = window.viewport_size();
        let rail = self.is_rail(win.width);
        let groups = self.groups();
        let selected = self.selected();
        let name = selected.as_deref().and_then(|s| self.hub.lock().tree.get(s).map(sidebar_model::name_of)).unwrap_or_else(|| "pi".into());
        let side = sidebar::render_sidebar(self, &groups, rail, cx);
        let main = match selected.clone() {
            None => div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(th.sp(3))
                .text_color(th.c("text.muted"))
                .child(text_font(th, div(), "body").child("没有选中的会话"))
                .child(dialogs::button(th, "new-session", dialogs::Btn::Primary, false, "新建会话").on_click(cx.listener(|this, _, window, cx| {
                    match this.hub.open_root(&this.cwd) {
                        Ok(id) => this.select(Some(id), window, cx),
                        Err(e) => this.error = Some(e.message),
                    }
                    cx.notify();
                })))
                .into_any_element(),
            Some(sid) => {
                let overlay = dialogs::render_overlay(self, &sid, &name, window, cx);
                let stream = chat::render_chat(self, &sid, window, cx);
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_h_0()
                            .child(div().size_full().child(stream).with_animation(
                                ElementId::Name(format!("switch-{}", self.switch_seq).into()),
                                Animation::new(th.ms("tab_switch")).with_easing(th.ease("emphasized")),
                                |d, t| d.opacity(0.85 + 0.15 * t).mt(px(4. * (1. - t))),
                            ))
                            .children(overlay),
                    )
                    .child(self.composer_view(&sid, window, cx))
                    .into_any_element()
            }
        };
        let status = status::render_status(self, selected.as_deref(), f32::from(win.width), cx);
        let banner = self.banner_view(cx);
        let fonts = cx.global::<ui::Fonts>().ui.clone();
        div()
            .id("shell")
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .font_family(fonts)
            .bg(th.c("bg.app"))
            .text_color(th.c("text.primary"))
            .on_mouse_move(cx.listener(move |this, ev: &MouseMoveEvent, _, cx| {
                if this.dragging {
                    let x = f32::from(ev.position.x);
                    this.sidebar_w = x.clamp(th.n("sidebar.width_min"), th.n("sidebar.width_max"));
                    cx.notify();
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| {
                this.dragging = false;
                cx.notify();
            }))
            .child(self.titlebar(&name))
            .when_some(self.error.clone(), |d, e| {
                d.child(text_font(th, div(), "small").px(th.sp(3)).py(th.sp(1)).bg(th.c("button.danger.bg")).text_color(th.c("button.danger.text")).child(e))
            })
            .child(div().flex_1().min_h_0().flex().child(side).child(main))
            .child(status)
            .children(banner)
    }
}
