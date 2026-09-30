//! The window shell: title bar, session list, chat, composer, the right
//! drawer, status strip, popover and toasts, assembled from `crate::ui`. Owns
//! the view-only state (focus, folds, drafts, scroll, motion); session state
//! is the hub's.

use crate::hub::Hub;
use crate::protocol::DialogParams;
use crate::rpc::UiRequest;
use crate::ui::anim::Stamps;
use crate::ui::chrome::{self, Toast};
use crate::ui::dialog_state::DialogUi;
use crate::ui::drawer::{self, DrawerView};
use crate::ui::motion::{StreamFade, Tween};
use crate::ui::scroll::ScrollAnim;
use crate::ui::sidebar::SelSlide;
use crate::ui::sidebar_model::{self, Group, Inputs, Status};
use crate::ui::sidebar_state::{self, SidebarState};
use crate::ui::status::Unmet;
use crate::ui::theme::Th;
use crate::ui::{self, chat, chat::text_font, composer, controls, sidebar, status};
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub enum ActiveDialog {
    Gate(DialogParams),
    Native(UiRequest),
}

pub struct Shell {
    pub hub: Arc<Hub>,
    cwd: String,
    pub(crate) demo: bool,
    pub th: Th,
    composer: Entity<TextareaState>,
    pub reason_editors: HashMap<String, Entity<TextareaState>>,
    pub(crate) editor_subs: HashMap<String, Subscription>,
    pub dialog_uis: HashMap<String, DialogUi>,
    /// What each session's drawer shows (§6.1).
    pub drawers: HashMap<String, DrawerView>,
    /// Sessions whose last answer was 「返回上一题」 (the next question enters from the left).
    pub(crate) back_answered: HashSet<String>,
    /// Fold keys flipped away from their default (§5.2–5.4).
    toggled: HashSet<String>,
    pub chat_scroll: ScrollHandle,
    /// Auto-follow: the chat sticks to the bottom until the user scrolls up (§5.1).
    pub follow: bool,
    followed_rev: u64,
    /// Per dialog: the drawer body keeps its reading position across session switches.
    pub doc_scrolls: HashMap<String, ScrollHandle>,
    pub collapsed_groups: HashSet<Group>,
    pub sidebar: SidebarState,
    pub sel: SelSlide,
    pub dragging: bool,
    pub dialog_focus: FocusHandle,
    pub copied: Option<(String, Instant)>,
    pub switch_seq: usize,
    /// Per session: how many chat items existed when it was selected (only newer ones play their entrance).
    pub enter_from: HashMap<String, usize>,
    /// Per streaming text block: which words are still fading in (§5.1).
    pub fades: HashMap<String, StreamFade>,
    pub stamps: Stamps,
    pub hovered: Option<String>,
    pub unmet: Unmet,
    pub toasts: Vec<Toast>,
    pub(crate) toast_seq: u64,
    pub scroll_anim: Option<ScrollAnim>,
    pub(crate) reduce_motion: bool,
    /// Last clock phase painted (cursor blink half-period / whole seconds of a running tool).
    clock_phase: u64,
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
                // «减少动态效果» is re-read every second; a change applies at once (§11.3).
                let reduce = (ticks % 10 == 1).then(ui::system_reduce_motion);
                if this.update_in(cx, |this, window, cx| this.poll(reduce, window, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let remembered = if demo { None } else { sidebar_state::state_file().and_then(|p| std::fs::read_to_string(p).ok()) };
        let sidebar = match remembered {
            Some(s) => SidebarState::from_json(&s, th.n("sidebar.width_default"), th.n("sidebar.width_min"), th.n("sidebar.width_max")),
            None => SidebarState::new(true, th.n("sidebar.width_default")),
        };
        Shell {
            hub,
            cwd,
            demo,
            th,
            composer,
            reason_editors: HashMap::new(),
            editor_subs: HashMap::new(),
            dialog_uis: HashMap::new(),
            drawers: HashMap::new(),
            back_answered: HashSet::new(),
            toggled: HashSet::new(),
            chat_scroll: ScrollHandle::new(),
            follow: true,
            followed_rev: 0,
            doc_scrolls: HashMap::new(),
            collapsed_groups: HashSet::new(),
            sidebar,
            sel: SelSlide::default(),
            dragging: false,
            dialog_focus: cx.focus_handle(),
            copied: None,
            switch_seq: 0,
            enter_from: HashMap::new(),
            fades: HashMap::new(),
            stamps: Stamps::default(),
            hovered: None,
            unmet: Unmet::default(),
            toasts: vec![],
            toast_seq: 0,
            scroll_anim: None,
            reduce_motion: false,
            clock_phase: 0,
            error: None,
            seen: u64::MAX,
            _subs: subs,
        }
    }

    fn poll(&mut self, reduce: Option<bool>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(r) = reduce.filter(|r| *r != self.reduce_motion) {
            cx.set_reduce_motion(r);
            self.reduce_motion = r;
            cx.notify();
        }
        if self.hub.take_activate_request() {
            cx.activate(true);
            window.activate_window();
            self.focus_dialog_if_any(window, cx);
        }
        let banner = self.hub.lock().banner.take();
        if let Some(n) = banner {
            self.toast(Toast::new(n.focus_host_session_id, "bell", n.title, n.body));
            cx.notify();
        }
        let v = self.hub.version();
        let ticking_drawer = self.expire_native();
        // Drawers run their own clocks (exit grace, switch hand-over): reconcile each tick while any exists.
        if v != self.seen || !self.drawers.is_empty() {
            let changed = v != self.seen;
            self.seen = v;
            self.sync_dialogs(window, cx);
            let rev = self.selected().and_then(|s| self.hub.lock().chats.get(&s).map(|c| c.rev)).unwrap_or(0);
            if self.follow && rev != self.followed_rev {
                self.followed_rev = rev;
                self.chat_scroll.scroll_to_bottom();
            }
            if changed || ticking_drawer {
                cx.notify();
            }
        }
        // A closed drawer hands the keys back to the composer (§6.1).
        let has_dialog = self.selected().is_some_and(|s| self.active_dialog(&s).is_some());
        if !has_dialog && self.dialog_focus.is_focused(window) {
            self.composer.update(cx, |c, cx| c.focus(window, cx));
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
        if self.tick_toasts() {
            cx.notify();
        }
    }

    pub fn selected(&self) -> Option<String> {
        self.hub.lock().focused.clone()
    }

    pub fn chat_at_bottom(&self) -> bool {
        -self.chat_scroll.offset().y >= self.chat_scroll.max_offset().y - px(8.)
    }

    pub fn is_open(&self, key: &str, default: bool) -> bool {
        default ^ self.toggled.contains(key)
    }

    pub fn toggle(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.toggled.remove(key) {
            self.toggled.insert(key.to_string());
        }
        self.stamps.mark(&format!("fold-{key}"));
        cx.notify();
    }

    pub fn select(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.close_sidebar_overlay(cx);
        if id == self.selected() {
            return;
        }
        if let Some(s) = &id {
            let n = self.hub.lock().chats.get(s).map_or(0, |c| c.items.len());
            self.enter_from.insert(s.clone(), n);
            // Text already streamed before the switch never replays its fade (§5.1).
            self.fades.retain(|k, _| !k.starts_with(&format!("{s}/")));
        }
        self.hub.set_focused(id);
        self.switch_seq += 1;
        self.follow = true;
        self.scroll_anim = None;
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
        let chat = self.chat_scroll.clone();
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
                self.toggle_sidebar(cx);
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
                self.follow = false;
                self.scroll_to(chat, Some(0.), cx);
                true
            }
            (true, false, false, "down") if !composer_focused => {
                self.follow = true;
                self.scroll_to(chat, None, cx);
                true
            }
            (false, false, false, "pageup" | "pagedown") if !composer_focused && dialog.is_none() => {
                let page = f32::from(window.viewport_size().height) * 0.8;
                let now = -f32::from(chat.offset().y);
                self.follow = false;
                self.scroll_to(chat, Some(if ks.key == "pageup" { now - page } else { now + page }), cx);
                true
            }
            (false, false, false, "escape") if self.unmet.is_open() => {
                self.unmet.set(false, self.th, self.reduce_motion);
                true
            }
            (false, false, false, "escape") if self.sidebar.overlay => {
                self.close_sidebar_overlay(cx);
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

    pub(crate) fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
    pub fn demo_state(&mut self, shot: &crate::demo::Shot, window: &mut Window, cx: &mut Context<Self>) {
        self.th = Th { dark: shot.dark };
        ui::apply_theme(self.th, cx);
        let t = self.sidebar_timing();
        let now = Instant::now();
        self.sidebar.open = !shot.collapsed;
        self.sidebar.push = Tween::at_rest(if shot.collapsed { 0.0 } else { self.sidebar.width });
        self.sidebar.overlay = false;
        self.sidebar.yielded = false;
        self.sidebar.slide = Tween::at_rest(0.0);
        self.toggled = shot.open.iter().map(|s| s.to_string()).collect();
        self.select(Some(shot.select.clone()), window, cx);
        // After selecting: picking a session closes the overlay.
        if shot.overlay {
            self.sidebar.narrow = true;
            self.sidebar.toggle(now, &t);
        }
        if !shot.open.is_empty() {
            // Show the expanded blocks, which sit above the fold.
            self.follow = false;
            self.chat_scroll.set_offset(point(px(0.), px(0.)));
        }
        if let Some((key, _)) = self.active_dialog(&shot.select) {
            // pi's input / editor boxes are text-only: nothing to go back to.
            let open = self.dialog_uis.get(&key).is_some_and(|u| u.reason_open && !u.options.is_empty());
            match shot.reason {
                Some(text) => {
                    self.dialog_activate(&key, crate::ui::dialog_state::Row::Decline, window, cx);
                    if let Some(e) = self.reason_editors.get(&key) {
                        e.update(cx, |e, cx| e.set_value(text.to_string(), window, cx));
                    }
                }
                // Back to the list (the draft stays, §6.3).
                None if open => self.dialog_key(&key, crate::ui::dialog_state::Key::Esc, window, cx),
                None => {}
            }
        }
        self.unmet.set(shot.popover, self.th, true);
        cx.notify();
    }

    fn empty_state(&self, cx: &mut Context<Self>) -> AnyElement {
        let th = self.th;
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(th.sp(3))
            .text_color(th.c("text.muted"))
            .child(text_font(th, div(), "body").child("没有选中的会话"))
            .child(controls::button(th, "new-session", controls::Btn::Primary, false, "新建会话", self.reduce_motion).on_click(cx.listener(|this, _, window, cx| {
                match this.hub.open_root(&this.cwd) {
                    Ok(id) => this.select(Some(id), window, cx),
                    Err(e) => this.error = Some(e.message),
                }
                cx.notify();
            })))
            .into_any_element()
    }

    /// The chat column (stream + composer) with the session's drawer to its right.
    fn session_view(&mut self, sid: &str, name: &str, main_w: f32, window: &mut Window, cx: &mut Context<Self>) -> (AnyElement, f32) {
        let th = self.th;
        self.observe_stream(sid);
        let drawer = drawer::render(self, sid, name, main_w, window, cx);
        let (drawer_el, scrim, drawer_w) = match drawer {
            Some((el, s)) => {
                let w = self.drawers.get(sid).map_or(0., |v| drawer::width(th, v.wide, main_w) * v.open.value(Instant::now()).clamp(0., 1.));
                (Some(el), Some(drawer::scrim(th, s)), w)
            }
            None => (None, None, 0.),
        };
        let stream = chat::render_chat(self, sid, window, cx);
        let reduce = cx.reduce_motion();
        let column = div()
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
                    .child(ui::anim::appear(div().size_full().child(stream), format!("switch-{}", self.switch_seq), th.ms("tab_switch"), th.ease("smooth"), 0., if reduce { 0. } else { th.n("space.2") }))
                    .children(scrim),
            )
            .child(composer::render(self, &self.composer, sid, window, cx));
        (div().size_full().flex().child(column).children(drawer_el).into_any_element(), drawer_w)
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
        let now = Instant::now();
        let win = window.viewport_size();
        let win_w = f32::from(win.width);
        let t = self.sidebar_timing();
        self.sidebar.set_narrow(win_w < th.n("breakpoint.sidebar_overlay"), now, &t);
        self.step_scroll(window);
        if self.stamps.sweep(Duration::from_millis(600)) {
            window.request_animation_frame();
        }
        let groups = self.groups();
        let selected = self.selected();
        // The selection block follows the selected row (§4.3).
        let slots = sidebar_model::row_slots(&groups, &self.collapsed_groups, th.n("space.2"), th.n("sidebar.group_header_height"), th.n("sidebar.item_height"));
        let slot = selected.as_deref().and_then(|s| slots.iter().find(|r| r.id == s));
        self.sel.follow(slot, th.n("sidebar.child_indent"), th, self.reduce_motion);
        // A drawer that needs the room borrows it from the sidebar (§6.1).
        let open_w = if self.sidebar.narrow || !self.sidebar.open { 0. } else { self.sidebar.width };
        let need = selected.as_deref().and_then(|s| self.drawers.get(s)).is_some_and(|v| !v.closing() && drawer::needs_room(th, v.wide, win_w - open_w));
        self.sidebar.yield_to_drawer(need, now, &t);
        let name = selected.as_deref().and_then(|s| self.hub.lock().tree.get(s).map(sidebar_model::name_of)).unwrap_or_else(|| "pi".into());
        let waiting = groups.iter().flat_map(|g| &g.rows).filter(|r| r.status == Status::WaitingInput).count();
        let hidden = self.sidebar.hidden(now);
        let titlebar = chrome::titlebar(self, &name, waiting, hidden, cx);
        let side = sidebar::render_sidebar(self, &groups, window, cx);
        let overlay = sidebar::render_overlay(self, &groups, window, cx);
        let main_w = win_w - self.sidebar.push.value(now).max(0.);
        let (main, drawer_w) = match selected.clone() {
            None => (self.empty_state(cx), 0.),
            Some(sid) => self.session_view(&sid, &name, main_w, window, cx),
        };
        let status = status::render_status(self, selected.as_deref(), win_w, cx);
        let popover = status::render_popover(self, selected.as_deref(), win, window, cx);
        let toasts = chrome::toasts(self, px(drawer_w), window, cx);
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
                    this.sidebar.drag(f32::from(ev.position.x), th.n("sidebar.width_min"), th.n("sidebar.width_max"));
                    cx.notify();
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(move |this, ev: &MouseUpEvent, _, cx| {
                if this.dragging {
                    this.dragging = false;
                    let t = this.sidebar_timing();
                    this.sidebar.release(f32::from(ev.position.x), th.n("sidebar.width_min"), Instant::now(), &t);
                    this.save_sidebar();
                    cx.notify();
                }
            }))
            .child(titlebar)
            .when_some(self.error.clone(), |d, e| {
                d.child(text_font(th, div(), "small").px(th.sp(3)).py(th.sp(1)).bg(th.c("button.danger.bg")).text_color(th.c("button.danger.text")).child(e))
            })
            .child(div().relative().flex_1().min_h_0().flex().children(side).child(div().flex_1().min_w_0().h_full().child(main)).children(overlay))
            .child(status)
            .children(popover)
            .children(toasts)
    }
}
