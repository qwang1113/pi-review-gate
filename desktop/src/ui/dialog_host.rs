//! The window's side of every dialog: view state per pending dialog (created
//! and dropped as the hub's list changes), keys and clicks fed through
//! `DialogUi`, and the answer sent back — `dialog.open`'s outcome for a gate
//! dialog, an `extension_ui_response` for pi's own box. Also keeps each
//! session's drawer (`drawer::DrawerView`) in step with the hub's requests.

use super::chrome::Toast;
use super::dialog_state::{DialogUi, Effect, Key, Row};
use super::drawer::{self, DrawerView, Switch};
use super::motion::Tween;
use super::sidebar_model;
use crate::app::{ActiveDialog, Shell};
use crate::protocol::DialogOutcome;
use crate::rpc::{UiAnswer, UiRequest};
use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::*;
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// `g|owner|id` for a gate dialog, `u|owner|id` for pi's own.
fn dialog_key(owner: &str, gate: bool, id: &str) -> String {
    format!("{}|{owner}|{id}", if gate { "g" } else { "u" })
}

fn native_ui(req: &UiRequest) -> DialogUi {
    match req {
        UiRequest::Select { options, .. } => DialogUi::plain(options.clone()),
        // Focus starts on 「确定」 (§6.6); Enter triggers the focused button.
        UiRequest::Confirm { .. } => DialogUi::plain(vec!["确定".into(), "取消".into()]),
        // input / editor: only the text box, starting from the text pi handed over.
        UiRequest::Editor { prefill, .. } => DialogUi { reason_open: true, draft: prefill.clone().unwrap_or_default(), ..DialogUi::plain(vec![]) },
        _ => DialogUi { reason_open: true, ..DialogUi::plain(vec![]) },
    }
}

impl Shell {
    /// The dialog shown for `sid`: the first gate dialog, else pi's own box.
    pub fn active_dialog(&self, sid: &str) -> Option<(String, ActiveDialog)> {
        let st = self.hub.lock();
        if let Some(d) = st.dialogs.iter().find(|d| d.owner == sid) {
            return Some((dialog_key(sid, true, d.params.dialog_id()), ActiveDialog::Gate(d.params.clone())));
        }
        st.ui_requests.iter().find(|u| u.session == sid).map(|u| (dialog_key(sid, false, &u.id), ActiveDialog::Native(u.request.clone())))
    }

    /// Creates view state for new dialogs, focuses or announces arrivals, then
    /// moves every session's drawer toward what the hub asks for (open, switch
    /// question, close) and drops view state nothing shows any more.
    pub(crate) fn sync_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let live: Vec<(String, String, DialogUi)> = {
            let st = self.hub.lock();
            let gate = st.dialogs.iter().map(|d| (d.owner.clone(), dialog_key(&d.owner, true, d.params.dialog_id()), DialogUi::new(&d.params)));
            let native = st.ui_requests.iter().map(|u| (u.session.clone(), dialog_key(&u.session, false, &u.id), native_ui(&u.request)));
            gate.chain(native).collect()
        };
        let selected = self.selected();
        for (owner, key, ui) in live {
            if self.dialog_uis.contains_key(&key) {
                continue;
            }
            let text_box = ui.reason_open;
            self.dialog_uis.insert(key.clone(), ui);
            self.doc_scrolls.insert(key.clone(), ScrollHandle::new());
            if text_box {
                self.ensure_editor(&key, window, cx);
            }
            if selected.as_deref() != Some(owner.as_str()) {
                let name = self.hub.lock().tree.get(&owner).map(sidebar_model::name_of).unwrap_or_default();
                self.toast(Toast::new(Some(owner), "bell", format!("等你回答 · {name}"), "有一个门禁问题在等你"));
            }
        }
        let arrived = self.reconcile_drawers(cx.reduce_motion());
        let shown: HashSet<String> = self.drawers.values().flat_map(|v| std::iter::once(v.key.clone()).chain(v.switch.as_ref().map(|s| s.old_key.clone()))).collect();
        let live: HashSet<String> = self.dialog_uis.keys().filter(|k| self.is_pending(k)).cloned().collect();
        let keep = |k: &String| shown.contains(k) || live.contains(k);
        self.dialog_uis.retain(|k, _| keep(k));
        self.reason_editors.retain(|k, _| keep(k));
        self.doc_scrolls.retain(|k, _| keep(k));
        if arrived {
            self.focus_dialog_if_any(window, cx);
        }
    }

    fn is_pending(&self, key: &str) -> bool {
        let mut parts = key.splitn(3, '|');
        let (kind, owner, id) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let st = self.hub.lock();
        if kind == "g" { st.dialogs.iter().any(|d| d.owner == owner && d.params.dialog_id() == id) } else { st.ui_requests.iter().any(|u| u.session == owner && u.id == id) }
    }

    /// One pass of §6.1: the hub's request per session against what is shown.
    /// True when a new question landed in the selected session's drawer.
    fn reconcile_drawers(&mut self, reduce: bool) -> bool {
        let mut arrived = false;
        let th = self.th;
        let now = Instant::now();
        let selected = self.selected();
        let mut sids: Vec<String> = self.drawers.keys().cloned().collect();
        {
            let st = self.hub.lock();
            sids.extend(st.dialogs.iter().map(|d| d.owner.clone()).chain(st.ui_requests.iter().map(|u| u.session.clone())));
        }
        sids.sort();
        sids.dedup();
        for sid in sids {
            let on_screen = selected.as_deref() == Some(sid.as_str());
            let (enter, enter_c) = drawer::timing(th, reduce, true);
            let (exit, exit_c) = drawer::timing(th, reduce, false);
            match (self.active_dialog(&sid), self.drawers.remove(&sid)) {
                (Some((key, active)), None) => {
                    let wide = super::dialogs::is_wide(&active, self.dialog_uis.get(&key));
                    let mut open = Tween::at_rest(if on_screen { 0.0 } else { 1.0 });
                    open.retarget(1.0, now, enter, enter_c);
                    arrived |= on_screen;
                    self.drawers.insert(sid, DrawerView { key, active, open, wide, opened_at: now, switch: None, leaving: None });
                }
                (Some((key, active)), Some(mut v)) => {
                    if v.key != key {
                        let back = self.back_answered.remove(&sid);
                        let old_key = std::mem::replace(&mut v.key, key);
                        let old = std::mem::replace(&mut v.active, active);
                        v.switch = on_screen.then_some(Switch { old_key, old, at: now, back });
                        v.wide = super::dialogs::is_wide(&v.active, self.dialog_uis.get(&v.key));
                        v.opened_at = now;
                        if let Some(s) = self.doc_scrolls.get(&v.key) {
                            s.set_offset(point(px(0.), px(0.)));
                        }
                        arrived |= on_screen;
                    } else {
                        v.active = active;
                        // The switch has played out: stop holding the old question.
                        if v.switch.as_ref().is_some_and(|s| s.at.elapsed() > th.ms("question_out") + th.ms("question_in")) {
                            v.switch = None;
                        }
                    }
                    v.leaving = None;
                    v.open.retarget(1.0, now, enter, enter_c);
                    self.drawers.insert(sid, v);
                }
                (None, Some(mut v)) => {
                    if !v.closing() {
                        // An answered question waits `question_out` before leaving: the
                        // interview's next one usually lands by then and switches in place.
                        let answered = self.dialog_uis.get(&v.key).is_some_and(|u| u.answered);
                        let since = *v.leaving.get_or_insert(now);
                        if on_screen && answered && now.duration_since(since) < th.ms("question_out") {
                            self.drawers.insert(sid, v);
                            continue;
                        }
                        self.announce_close(&v.key);
                        v.open.retarget(0.0, now, exit, exit_c);
                    }
                    // Off screen, or done leaving: gone.
                    if on_screen && v.open.running(now) {
                        self.drawers.insert(sid, v);
                    }
                }
                (None, None) => {}
            }
        }
        arrived
    }

    /// A request left without this window answering it (§6.1): someone else did.
    fn announce_close(&mut self, key: &str) {
        if self.dialog_uis.get(key).is_some_and(|u| u.answered) {
            return;
        }
        if key.starts_with("g|") {
            self.toast(Toast::new(None, "circle-alert", "这道题已由另一方作答", "项目经理或代答先回答了，你的输入没有发出"));
        }
    }

    /// pi dialogs that carry a `timeout` close themselves when it runs out (§6.6).
    pub(crate) fn expire_native(&mut self) -> bool {
        let due: Vec<String> = self
            .drawers
            .values()
            .filter(|v| !v.closing())
            .filter(|v| match &v.active {
                ActiveDialog::Native(UiRequest::Select { timeout: Some(t), .. } | UiRequest::Confirm { timeout: Some(t), .. }) => v.opened_at.elapsed() >= Duration::from_millis(*t),
                _ => false,
            })
            .map(|v| v.key.clone())
            .collect();
        let ticking = self.drawers.values().any(|v| matches!(&v.active, ActiveDialog::Native(UiRequest::Select { timeout: Some(_), .. } | UiRequest::Confirm { timeout: Some(_), .. })));
        for key in due {
            if let Some(ui) = self.dialog_uis.get_mut(&key) {
                ui.answered = true;
            }
            self.answer(&key, DialogOutcome::Dismissed);
            self.toast(Toast::new(None, "circle-alert", "已超时", "pi 的对话框到点自动取消了"));
        }
        ticking
    }

    pub fn set_hovered(&mut self, id: &str, on: bool, cx: &mut Context<Self>) {
        self.stamps.mark(&format!("hover-{id}"));
        if on {
            self.hovered = Some(id.to_string());
        } else if self.hovered.as_deref() == Some(id) {
            self.hovered = None;
        }
        cx.notify();
    }

    pub fn scroll_doc_to_end(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(s) = self.doc_scrolls.get(key).cloned() {
            self.scroll_to(s, None, cx);
        }
    }

    pub(crate) fn ensure_editor(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some(e) = self.reason_editors.get(key) {
            return e.clone();
        }
        let draft = self.dialog_uis.get(key).map(|u| u.draft.clone()).unwrap_or_default();
        // pi's `input` brings its own placeholder; the gate's reason box uses ours.
        let placeholder = match self.active_native(key) {
            Some(UiRequest::Input { placeholder, .. }) => placeholder.unwrap_or_default(),
            Some(_) => String::new(),
            None => "写下原因（可留空）".to_string(),
        };
        let single = matches!(self.active_native(key), Some(UiRequest::Input { .. }));
        let e = cx.new(|cx| {
            let s = TextareaState::new(window, cx).placeholder(placeholder);
            let mut s = if single { s.auto_grow(1, 1).submit_on_enter(true) } else { s.auto_grow(3, 8) };
            s.set_value(draft, window, cx);
            s
        });
        if single {
            // pi `input`: Enter confirms (§6.6).
            let k = key.to_string();
            let sub = cx.subscribe_in(&e, window, move |this, _, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = ev {
                    this.submit_reason(&k, window, cx);
                }
            });
            self.editor_subs.insert(key.to_string(), sub);
        }
        self.reason_editors.insert(key.to_string(), e.clone());
        e
    }

    fn active_native(&self, key: &str) -> Option<UiRequest> {
        let rest = key.strip_prefix("u|")?;
        let (owner, id) = rest.split_once('|')?;
        self.hub.lock().ui_requests.iter().find(|u| u.session == owner && u.id == id).map(|u| u.request.clone())
    }

    pub fn reason_focused(&self, key: &str, window: &Window, cx: &App) -> bool {
        self.reason_editors.get(key).is_some_and(|e| e.read(cx).focus_handle(cx).contains_focused(window, cx))
    }

    fn apply(&mut self, key: &str, effect: Effect, window: &mut Window, cx: &mut Context<Self>) {
        match effect {
            Effect::None => {}
            Effect::OpenReason => {
                let e = self.ensure_editor(key, window, cx);
                e.update(cx, |e, cx| e.focus(window, cx));
            }
            Effect::CloseReason => {
                if let (Some(e), Some(ui)) = (self.reason_editors.get(key), self.dialog_uis.get_mut(key)) {
                    ui.draft = e.read(cx).value().to_string();
                }
                window.focus(&self.dialog_focus, cx);
            }
            Effect::Scroll(n) => {
                if let Some(s) = self.doc_scrolls.get(key) {
                    let mut off = s.offset();
                    off.y -= px(n as f32 * 3.0 * self.th.font("body").line_height);
                    s.set_offset(off);
                }
            }
            Effect::Submit(outcome) => self.answer(key, outcome),
        }
        cx.notify();
    }

    fn answer(&mut self, key: &str, outcome: DialogOutcome) {
        let mut parts = key.splitn(3, '|');
        let (kind, owner, id) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        // The next question of the interview enters from the left after a 「返回」 (§6.2).
        if outcome == DialogOutcome::Back {
            self.back_answered.insert(owner.to_string());
        } else {
            self.back_answered.remove(owner);
        }
        if kind == "g" {
            if self.demo {
                eprintln!("demo answer {id}: {outcome:?}");
            }
            self.hub.dialog_answer(owner, id, outcome);
            return;
        }
        let req = self.hub.lock().ui_requests.iter().find(|u| u.session == owner && u.id == id).map(|u| u.request.clone());
        let answer = match (req, outcome) {
            (Some(UiRequest::Confirm { .. }), DialogOutcome::Picked { option }) => UiAnswer::Confirmed(option == "确定"),
            (_, DialogOutcome::Picked { option }) => UiAnswer::Value(option),
            (_, DialogOutcome::Decline { reason }) => UiAnswer::Value(reason),
            _ => UiAnswer::Cancelled,
        };
        if let Err(e) = self.hub.answer_ui(owner, id, answer) {
            self.error = Some(e.to_string());
        }
    }

    pub fn dialog_key(&mut self, key: &str, k: Key, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.dialog_uis.get_mut(key) else { return };
        let before = ui.checked.clone();
        let focus_before = ui.focus;
        // pi's input/editor box: Esc cancels outright (there is no list to return to).
        let effect = if k == Key::Esc && ui.options.is_empty() { Effect::Submit(DialogOutcome::Dismissed) } else { ui.key(k) };
        let flipped: Vec<usize> = ui.checked.iter().zip(&before).enumerate().filter(|(_, (a, b))| a != b).map(|(i, _)| i).collect();
        let moved = ui.focus != focus_before;
        for i in flipped {
            self.stamps.mark(&format!("chk-{key}-{i}"));
        }
        if moved {
            self.stamps.mark(&format!("focus-{key}"));
        }
        self.apply(key, effect, window, cx);
    }

    pub fn dialog_activate(&mut self, key: &str, row: Row, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.dialog_uis.get_mut(key) else { return };
        let effect = ui.activate(row);
        self.apply(key, effect, window, cx);
    }

    pub fn dialog_toggle(&mut self, key: &str, i: usize, cx: &mut Context<Self>) {
        if let Some(ui) = self.dialog_uis.get_mut(key) {
            ui.toggle(i);
            self.stamps.mark(&format!("chk-{key}-{i}"));
            cx.notify();
        }
    }

    pub fn submit_reason(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.reason_editors.get(key).map(|e| e.read(cx).value().to_string()).unwrap_or_default();
        let Some(ui) = self.dialog_uis.get_mut(key) else { return };
        let effect = ui.submit_reason(text);
        self.apply(key, effect, window, cx);
    }

    /// Keys on the focused dialog (§12).
    pub fn dialog_keystroke(&mut self, key: &str, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ks = &ev.keystroke;
        let m = ks.modifiers;
        // The reason editor owns every key but Esc: typing must reach the text input.
        if ks.key != "escape" && self.dialog_uis.get(key).is_some_and(|u| u.reason_open) {
            return;
        }
        let k = match ks.key.as_str() {
            "up" => Key::Up,
            "down" => Key::Down,
            "space" => Key::Space,
            "enter" => Key::Enter,
            "tab" if m.shift => Key::ShiftTab,
            "tab" => Key::Tab,
            "left" if m.platform => Key::CmdLeft,
            "escape" => Key::Esc,
            "pageup" => return self.apply(key, Effect::Scroll(-4), window, cx),
            "pagedown" => return self.apply(key, Effect::Scroll(4), window, cx),
            l if l.len() == 1 && !m.platform && !m.control && !m.alt => match l.as_bytes()[0] {
                c @ b'a'..=b'p' => Key::Letter((c - b'a') as usize),
                _ => return,
            },
            _ => return,
        };
        cx.stop_propagation();
        self.dialog_key(key, k, window, cx);
    }
}
