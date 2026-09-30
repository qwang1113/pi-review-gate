//! The window's side of every dialog: view state per pending dialog (created
//! and dropped as the hub's list changes), keys and clicks fed through
//! `DialogUi`, and the answer sent back — `dialog.open`'s outcome for a gate
//! dialog, an `extension_ui_response` for pi's own box.

use super::dialog_state::{DialogUi, Effect, Key, Row};
use super::sidebar_model;
use crate::app::{ActiveDialog, Banner, Shell};
use crate::protocol::DialogOutcome;
use crate::rpc::{UiAnswer, UiRequest};
use gpui_kit::component::input::TextareaState;
use gpui_kit::*;
use std::collections::HashSet;
use std::time::Instant;

/// `g|owner|id` for a gate dialog, `u|owner|id` for pi's own.
fn dialog_key(owner: &str, gate: bool, id: &str) -> String {
    format!("{}|{owner}|{id}", if gate { "g" } else { "u" })
}

fn native_ui(req: &UiRequest) -> DialogUi {
    match req {
        UiRequest::Select { options, .. } => DialogUi::plain(options.clone()),
        UiRequest::Confirm { .. } => DialogUi::plain(vec!["确认".into(), "取消".into()]),
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

    /// Creates view state for new dialogs, drops it for settled ones (a
    /// `dialog.close` takes the card down here), focuses or announces arrivals.
    pub(crate) fn sync_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let live: Vec<(String, String, DialogUi)> = {
            let st = self.hub.lock();
            let gate = st.dialogs.iter().map(|d| (d.owner.clone(), dialog_key(&d.owner, true, d.params.dialog_id()), DialogUi::new(&d.params)));
            let native = st.ui_requests.iter().map(|u| (u.session.clone(), dialog_key(&u.session, false, &u.id), native_ui(&u.request)));
            gate.chain(native).collect()
        };
        let keys: HashSet<&String> = live.iter().map(|(_, k, _)| k).collect();
        self.dialog_uis.retain(|k, _| keys.contains(k));
        self.reason_editors.retain(|k, _| keys.contains(k));
        self.doc_scrolls.retain(|k, _| keys.contains(k));
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
            if selected.as_deref() == Some(owner.as_str()) {
                self.focus_dialog_if_any(window, cx);
            } else {
                let name = self.hub.lock().tree.get(&owner).map(sidebar_model::name_of).unwrap_or_default();
                self.banner = Some(Banner { session: Some(owner), title: format!("等你回答 · {name}"), body: "有一个门禁问题在等你".into(), at: Instant::now() });
            }
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
        let e = cx.new(|cx| {
            let mut s = TextareaState::new(window, cx).auto_grow(3, 8).placeholder(placeholder);
            s.set_value(draft, window, cx);
            s
        });
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
        if kind == "g" {
            if self.demo {
                eprintln!("demo answer {id}: {outcome:?}");
            }
            self.hub.dialog_answer(owner, id, outcome);
            return;
        }
        let req = self.hub.lock().ui_requests.iter().find(|u| u.session == owner && u.id == id).map(|u| u.request.clone());
        let answer = match (req, outcome) {
            (Some(UiRequest::Confirm { .. }), DialogOutcome::Picked { option }) => UiAnswer::Confirmed(option == "确认"),
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
        // pi's input/editor box: Esc cancels outright (there is no list to return to).
        let effect = if k == Key::Esc && ui.options.is_empty() { Effect::Submit(DialogOutcome::Dismissed) } else { ui.key(k) };
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
