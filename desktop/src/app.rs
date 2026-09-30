//! The minimal window: session tree on the left, the selected session's raw RPC
//! event stream in the middle, a prompt line at the bottom. Visual design and the
//! real dialog renderer are t5's; pending dialogs get a bare fallback here so a
//! session is never stuck waiting on a box nobody can see.

use crate::hub::Hub;
use crate::protocol::{DialogOutcome, DialogParams};
use crate::rpc::{UiAnswer, UiRequest};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::sync::Arc;
use std::time::Duration;

/// Lines of the raw stream rendered at once (the hub keeps more).
const VISIBLE_LINES: usize = 400;

pub struct Shell {
    hub: Arc<Hub>,
    cwd: String,
    input: Entity<InputState>,
    seen: u64,
    error: Option<String>,
    _subs: Vec<Subscription>,
}

impl Shell {
    pub fn new(hub: Arc<Hub>, cwd: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Prompt the selected session, Enter to send"));
        let subs = vec![
            cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = ev {
                    this.send_prompt(window, cx);
                }
            }),
            cx.observe_window_activation(window, |this, window, _| this.hub.set_frontmost(window.is_window_active())),
        ];
        // The hub changes on socket and reader threads; repaint when its version moves.
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                if this.update_in(cx, |this, window, cx| this.poll(window, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        Shell { hub, cwd, input, seen: u64::MAX, error: None, _subs: subs }
    }

    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.hub.take_activate_request() {
            cx.activate(true);
            window.activate_window();
        }
        let v = self.hub.version();
        if v != self.seen {
            self.seen = v;
            cx.notify();
        }
    }

    fn selected(&self) -> Option<String> {
        self.hub.lock().focused.clone()
    }

    fn new_session(&mut self, cx: &mut Context<Self>) {
        match self.hub.open_root(&self.cwd) {
            Ok(id) => {
                self.hub.set_focused(Some(id));
                self.error = None;
            }
            Err(e) => self.error = Some(e.message),
        }
        cx.notify();
    }

    fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().to_string();
        let Some(id) = self.selected() else { return };
        if text.trim().is_empty() {
            return;
        }
        match self.hub.prompt(&id, &text) {
            Ok(()) => self.input.update(cx, |s, cx| s.set_value("", window, cx)),
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    fn session_list(&self, cx: &mut Context<Self>) -> Div {
        let st = self.hub.lock();
        let mut col = v_flex().gap_1();
        for s in st.tree.all() {
            let id = s.id.clone();
            let name = s.decoration.session_name.clone().or(s.decoration.label.clone()).unwrap_or(s.title.clone());
            let state = match (s.alive, s.decoration.state) {
                (false, _) => "dead".to_string(),
                (true, Some(st)) => serde_json::to_value(st).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
                (true, None) => "alive".to_string(),
            };
            let selected = st.focused.as_deref() == Some(s.id.as_str());
            let hub = self.hub.clone();
            col = col.child(
                div()
                    .id(SharedString::from(format!("row-{id}")))
                    .pl(px(8.0 + 14.0 * st.tree.depth(&s.id) as f32))
                    .py_1()
                    .rounded_md()
                    .when(selected, |d| d.bg(cx.theme().accent))
                    .when(!s.alive, |d| d.opacity(0.5))
                    .cursor_pointer()
                    .on_click(move |_, _, _| hub.set_focused(Some(id.clone())))
                    .child(div().text_sm().child(name))
                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(format!("{} · {:?} · {state}", s.id, s.role))),
            );
        }
        col
    }

    fn dialogs(&self, id: &str) -> Div {
        let st = self.hub.lock();
        let mut col = v_flex().gap_2();
        for d in st.dialogs.iter().filter(|d| d.owner == id) {
            let did = d.params.dialog_id().to_string();
            let mut row = h_flex().gap_2().flex_wrap().child(div().text_sm().child(d.params.title().to_string()));
            if let DialogParams::Choice { options, .. } = &d.params {
                for (i, opt) in options.iter().enumerate() {
                    let (hub, owner, did, opt) = (self.hub.clone(), id.to_string(), did.clone(), opt.clone());
                    row = row.child(Button::new(SharedString::from(format!("dlg-{did}-{i}"))).label(opt.clone()).on_click(
                        move |_, _, _| hub.dialog_answer(&owner, &did, DialogOutcome::Picked { option: opt.clone() }),
                    ));
                }
            }
            let (hub, owner) = (self.hub.clone(), id.to_string());
            row = row.child(
                Button::new(SharedString::from(format!("dlg-{did}-x")))
                    .ghost()
                    .label("Dismiss")
                    .on_click(move |_, _, _| hub.dialog_answer(&owner, &did, DialogOutcome::Dismissed)),
            );
            col = col.child(row);
        }
        for u in st.ui_requests.iter().filter(|u| u.session == id) {
            let (hub, sid, uid) = (self.hub.clone(), id.to_string(), u.id.clone());
            let mut row = h_flex().gap_2().child(div().text_sm().child(format!("{:?}", u.request)));
            if let UiRequest::Select { options, .. } = &u.request {
                for (i, opt) in options.iter().enumerate() {
                    let (hub, sid, uid, opt) = (hub.clone(), sid.clone(), uid.clone(), opt.clone());
                    row = row.child(
                        Button::new(SharedString::from(format!("ui-{uid}-{i}")))
                            .label(opt.clone())
                            .on_click(move |_, _, _| drop(hub.answer_ui(&sid, &uid, UiAnswer::Value(opt.clone())))),
                    );
                }
            }
            row = row.child(
                Button::new(SharedString::from(format!("ui-{uid}-x")))
                    .ghost()
                    .label("Cancel")
                    .on_click(move |_, _, _| drop(hub.answer_ui(&sid, &uid, UiAnswer::Cancelled))),
            );
            col = col.child(row);
        }
        col
    }

    fn event_log(&self, id: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        let st = self.hub.lock();
        let lines = st.logs.get(id).map(|l| l.iter().skip(l.len().saturating_sub(VISIBLE_LINES)).cloned().collect::<Vec<_>>());
        div()
            .id("event-log")
            .flex_1()
            .overflow_y_scroll()
            .p_2()
            .font_family("Menlo")
            .text_xs()
            .text_color(cx.theme().foreground)
            .children(lines.unwrap_or_default().into_iter().map(|l| div().child(l)))
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.selected();
        let sidebar = v_flex()
            .w(px(280.0))
            .h_full()
            .p_2()
            .gap_2()
            .border_r_1()
            .border_color(cx.theme().border)
            .child(Button::new("new-session").primary().label("New session").on_click(cx.listener(|this, _, _, cx| this.new_session(cx))))
            .child(div().id("sessions").flex_1().overflow_y_scroll().child(self.session_list(cx)));
        let main = match selected {
            None => v_flex().flex_1().p_4().child("No session selected. Start one with “New session”."),
            Some(id) => v_flex()
                .flex_1()
                .h_full()
                .child(div().p_2().text_sm().border_b_1().border_color(cx.theme().border).child(id.clone()))
                .child(self.dialogs(&id))
                .child(self.event_log(&id, cx))
                .child(
                    h_flex()
                        .p_2()
                        .gap_2()
                        .border_t_1()
                        .border_color(cx.theme().border)
                        .child(div().flex_1().child(Input::new(&self.input)))
                        .child(Button::new("send").label("Send").on_click(cx.listener(|this, _, window, cx| this.send_prompt(window, cx))))
                        .child(Button::new("abort").ghost().label("Abort").on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(e) = this.hub.abort(&id) {
                                this.error = Some(e.to_string());
                            }
                            cx.notify();
                        }))),
                ),
        };
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .when_some(self.error.clone(), |d, e| d.child(div().p_2().bg(cx.theme().danger).child(e)))
            .child(h_flex().flex_1().size_full().child(sidebar).child(main))
    }
}
