//! The config page (§7): its state and behaviour — which file is open, the
//! drafts, the form's text boxes, the JSON editor, saving through
//! `crate::config_store` off the UI thread, and the leave / conflict prompts.
//! What it looks like is `settings_view.rs`; the draft maths is
//! `settings_model.rs`. The shell hears about it only through `SettingsEvent`.

use super::motion::{Curve, Tween};
use super::settings_model::{Draft, View};
use super::theme::Th;
use crate::config_store::{self, ConfigFile, SaveError, Validator};
use gpui_kit::component::input::{EditorState, InputEvent, InputState, Position};
use gpui_kit::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::{Instant, SystemTime};

impl crate::app::Shell {
    /// ⌘, and the title bar's `settings` button: open the page, or leave it (§7).
    pub fn toggle_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(page) = self.settings.clone() {
            page.update(cx, |p, cx| p.request_leave(Leave::Close, cx));
            return;
        }
        // The demo edits its own fixture files, never the real ~/.pi.
        let (home, repo, validator) = if self.demo {
            let h = crate::demo::config_home();
            (h.clone(), Some(h.join("proj")), Validator { home: Some(h), ..Validator::from_env() })
        } else {
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
            let cwd = self.selected().and_then(|s| self.hub.lock().tree.get(&s).map(|s| s.cwd.clone()));
            let repo = cwd.as_deref().and_then(|c| std::path::Path::new(c).ancestors().find(|a| a.join(".git").exists()).map(|p| p.to_path_buf()));
            (home, repo, Validator::from_env())
        };
        let files = config_store::files(&home, repo.as_deref());
        let th = self.th;
        let page = cx.new(|cx| SettingsPage::new(th, files, validator, cx));
        self.settings_sub = Some(cx.subscribe_in(&page, window, |this, _, ev: &SettingsEvent, window, cx| match ev {
            SettingsEvent::Left(to) => {
                this.settings = None;
                this.settings_sub = None;
                match to {
                    Leave::Select(id) => this.select(id.clone(), window, cx),
                    Leave::Quit => cx.quit(),
                    Leave::Close => {}
                }
                this.focus_composer(window, cx);
                cx.notify();
            }
            SettingsEvent::Toast { glyph, title, body } => {
                this.toast(super::chrome::Toast::new(None, glyph, title.clone(), body.clone()));
                cx.notify();
            }
        }));
        let focus = page.read(cx).focus.clone();
        window.focus(&focus, cx);
        self.settings = Some(page);
        cx.notify();
    }
}

/// Where the user goes when the page closes.
#[derive(Clone, Debug, PartialEq)]
pub enum Leave {
    Close,
    Select(Option<String>),
    /// The window was being closed.
    Quit,
}

pub enum SettingsEvent {
    Left(Leave),
    Toast { glyph: &'static str, title: String, body: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptKind {
    /// 「保存并离开 / 放弃修改并离开 / 继续编辑」 (§7.4).
    Leave,
    /// The file changed on disk since it was opened (§7.4).
    Conflict,
}

pub struct Prompt {
    pub kind: PromptKind,
    /// Where to go once it is settled (a conflict met on the way out keeps it).
    pub then: Option<Leave>,
    pub focus: usize,
}

impl Prompt {
    pub fn options(&self) -> &'static [&'static str] {
        match self.kind {
            PromptKind::Leave => &["保存并离开", "放弃修改并离开", "继续编辑"],
            PromptKind::Conflict => &["用我的版本覆盖（磁盘版本会先备份）", "放弃我的修改，重新载入"],
        }
    }
}

#[cfg(feature = "shots")]
#[derive(Clone, Copy, Debug)]
pub enum DemoState {
    Form,
    Dirty,
    Json,
    JsonSyntax,
    Invalid,
    Saved,
    Leave,
    Conflict,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SaveUi {
    Idle,
    Saving,
    Saved(Instant),
    Failed(String),
}

pub struct FileState {
    pub draft: Draft,
    pub mtime: Option<SystemTime>,
}

pub struct SettingsPage {
    pub th: Th,
    pub reduce: bool,
    pub files: Vec<ConfigFile>,
    pub current: usize,
    pub states: HashMap<usize, FileState>,
    /// Form text boxes by field path (list items: `path.N`); dropped when the structure changes.
    pub inputs: HashMap<String, Entity<InputState>>,
    input_subs: HashMap<String, Subscription>,
    pub json: Option<Entity<EditorState>>,
    json_sub: Option<Subscription>,
    pub folded: HashSet<String>,
    pub revealed: HashSet<String>,
    pub save_ui: SaveUi,
    /// The save bar's rise: 0 = sunk, 1 = up.
    pub bar: Tween,
    /// The segmented control's selection: 0 = 表单, 1 = JSON.
    pub seg: Tween,
    /// The nav selection block's y.
    pub nav_y: Tween,
    /// Bumped to replay a shake (segmented control / save bar).
    pub seg_shake: u64,
    pub bar_shake: u64,
    pub prompt: Option<Prompt>,
    pub scroll: ScrollHandle,
    pub copied: Option<Instant>,
    pub focus: FocusHandle,
    validator: Validator,
}

impl EventEmitter<SettingsEvent> for SettingsPage {}

impl SettingsPage {
    pub fn new(th: Th, files: Vec<ConfigFile>, validator: Validator, cx: &mut Context<Self>) -> Self {
        let y0 = super::settings_view::nav_y(th, &files, 0);
        let mut p = SettingsPage {
            th,
            reduce: false,
            files,
            current: 0,
            states: HashMap::new(),
            inputs: HashMap::new(),
            input_subs: HashMap::new(),
            json: None,
            json_sub: None,
            folded: HashSet::new(),
            revealed: HashSet::new(),
            save_ui: SaveUi::Idle,
            bar: Tween::at_rest(0.),
            seg: Tween::at_rest(0.),
            nav_y: Tween::at_rest(y0),
            seg_shake: 0,
            bar_shake: 0,
            prompt: None,
            scroll: ScrollHandle::new(),
            copied: None,
            focus: cx.focus_handle(),
            validator,
        };
        p.ensure_loaded(0);
        p
    }

    fn ensure_loaded(&mut self, i: usize) {
        if self.states.contains_key(&i) {
            return;
        }
        let st = match config_store::load(&self.files[i].path) {
            Ok(l) => FileState { draft: Draft::load(l.text), mtime: l.mtime },
            // An unreadable file opens as its error in the JSON view; saving is refused by the validator.
            Err(e) => {
                let mut d = Draft::load(None);
                d.to_json_view();
                d.text = format!("// 读取失败：{e}\n");
                FileState { draft: d, mtime: None }
            }
        };
        self.states.insert(i, st);
    }

    pub fn state(&self) -> &FileState {
        &self.states[&self.current]
    }

    fn state_mut(&mut self) -> &mut FileState {
        self.states.get_mut(&self.current).expect("current file is loaded")
    }

    pub fn any_dirty(&self) -> bool {
        self.states.values().any(|s| s.draft.dirty())
    }

    fn spring(&self) -> (std::time::Duration, Curve) {
        let s = self.th.spring("gentle");
        if self.reduce { (std::time::Duration::ZERO, Curve::Linear) } else { (s.duration(), Curve::Spring(s)) }
    }

    /// Drop every text box: the next paint builds them from the draft again.
    fn rebuild_inputs(&mut self) {
        self.inputs.clear();
        self.input_subs.clear();
        self.json = None;
        self.json_sub = None;
    }

    pub fn open_file(&mut self, i: usize, cx: &mut Context<Self>) {
        if i == self.current || i >= self.files.len() {
            return;
        }
        self.ensure_loaded(i);
        self.current = i;
        self.save_ui = SaveUi::Idle;
        self.rebuild_inputs();
        let (d, c) = self.spring();
        self.nav_y.retarget(super::settings_view::nav_y(self.th, &self.files, i), Instant::now(), d, c);
        let json = self.state().draft.view == View::Json;
        self.seg = Tween::at_rest(if json { 1. } else { 0. });
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    /// 「表单 | JSON」 (§7.3): JSON → form is refused while the text does not parse.
    pub fn set_view(&mut self, view: View, cx: &mut Context<Self>) {
        let st = self.state_mut();
        let ok = match view {
            View::Json => {
                st.draft.to_json_view();
                true
            }
            View::Form => st.draft.to_form_view().is_ok(),
        };
        if ok {
            self.rebuild_inputs();
            let (d, c) = self.spring();
            self.seg.retarget(if view == View::Json { 1. } else { 0. }, Instant::now(), d, c);
        } else {
            self.seg_shake += 1;
        }
        cx.notify();
    }

    pub fn edit(&mut self, f: impl FnOnce(&mut Draft), structural: bool, cx: &mut Context<Self>) {
        let d = &mut self.state_mut().draft;
        f(d);
        // A finding is about the text that was checked; an edit makes it stale.
        d.issues.clear();
        if structural {
            self.rebuild_inputs();
        }
        if matches!(self.save_ui, SaveUi::Failed(_)) {
            self.save_ui = SaveUi::Idle;
        }
        cx.notify();
    }

    /// The text box for a string / number field (or a list item), built on first paint.
    pub fn input(&mut self, path: &str, number: bool, masked: bool, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(e) = self.inputs.get(path) {
            e.update(cx, |e, cx| e.set_masked(masked, window, cx));
            return e.clone();
        }
        let value = match self.state().draft.get(path) {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => String::new(),
        };
        let e = cx.new(|cx| {
            let mut s = InputState::new(window, cx).masked(masked);
            s.set_value(value, window, cx);
            s
        });
        let p = path.to_string();
        let sub = cx.subscribe_in(&e, window, move |this, e, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let v = e.read(cx).value().to_string();
                let p = p.clone();
                this.edit(move |d| if number { d.edit_number(&p, &v) } else { d.set(&p, Value::String(v)) }, false, cx);
            }
        });
        self.inputs.insert(path.to_string(), e.clone());
        self.input_subs.insert(path.to_string(), sub);
        e
    }

    /// The JSON view's editor, built on first paint.
    pub fn json_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<EditorState> {
        if let Some(e) = &self.json {
            return e.clone();
        }
        let text = self.state().draft.text.clone();
        let e = cx.new(|cx| {
            let mut s = EditorState::new(window, cx).line_number(true);
            s.set_value(text, window, cx);
            s
        });
        self.json_sub = Some(cx.subscribe_in(&e, window, |this, e, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let t = e.read(cx).value().to_string();
                this.edit(move |d| d.text = t, false, cx);
            }
        }));
        self.json = Some(e.clone());
        e
    }

    /// The error bar's click: put the cursor on the broken line.
    pub fn jump_to_syntax_error(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(err), Some(e)) = (self.state().draft.syntax_error(), self.json.clone()) else { return };
        let pos = Position { line: err.line.saturating_sub(1) as u32, character: err.column.saturating_sub(1) as u32 };
        e.update(cx, |e, cx| {
            e.set_cursor_position(pos, window, cx);
            e.focus(window, cx);
        });
    }

    /// Ask to leave: straight away when nothing is unsaved, else the prompt (§7.4).
    pub fn request_leave(&mut self, to: Leave, cx: &mut Context<Self>) {
        if self.any_dirty() {
            self.prompt = Some(Prompt { kind: PromptKind::Leave, then: Some(to), focus: 0 });
            cx.notify();
        } else {
            cx.emit(SettingsEvent::Left(to));
        }
    }

    pub fn discard(&mut self, cx: &mut Context<Self>) {
        for (i, st) in self.states.iter_mut() {
            if st.draft.dirty() {
                let l = config_store::load(&self.files[*i].path).unwrap_or(config_store::Loaded { text: None, mtime: None });
                st.draft.reset(l.text);
                st.mtime = l.mtime;
            }
        }
        self.save_ui = SaveUi::Idle;
        self.rebuild_inputs();
        cx.notify();
    }

    pub fn answer(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.prompt.take() else { return };
        match (p.kind, i) {
            (PromptKind::Leave, 0) => self.save(false, p.then, window, cx),
            (PromptKind::Leave, 1) => {
                self.discard(cx);
                if let Some(to) = p.then {
                    cx.emit(SettingsEvent::Left(to));
                }
            }
            (PromptKind::Conflict, 0) => self.save(true, p.then, window, cx),
            (PromptKind::Conflict, _) => {
                let l = config_store::load(&self.files[self.current].path).unwrap_or(config_store::Loaded { text: None, mtime: None });
                let st = self.state_mut();
                st.draft.reset(l.text);
                st.mtime = l.mtime;
                self.save_ui = SaveUi::Idle;
                self.rebuild_inputs();
            }
            _ => {}
        }
        cx.notify();
    }

    /// Save the current file off the UI thread (the checker is a node process).
    /// `then`: leave afterwards — after every other unsaved file is saved too.
    pub fn save(&mut self, force: bool, then: Option<Leave>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.state().draft.dirty() {
            if let Some(next) = self.states.iter().find(|(_, s)| s.draft.dirty()).map(|(i, _)| *i) {
                self.open_file(next, cx);
            } else {
                if let Some(to) = then {
                    cx.emit(SettingsEvent::Left(to));
                }
                return;
            }
        }
        if self.save_ui == SaveUi::Saving {
            return;
        }
        if self.state().draft.error_count() > 0 {
            self.bar_shake += 1;
            cx.notify();
            return;
        }
        let file = self.files[self.current].clone();
        let text = self.state().draft.save_text();
        let seen = self.state().mtime;
        let v = self.validator.clone();
        let idx = self.current;
        self.save_ui = SaveUi::Saving;
        cx.spawn_in(window, async move |this, cx| {
            let r = cx.background_executor().spawn(async move { config_store::save(&file.path, &text, file.kind, seen, force, &v, &config_store::stamp_now()) }).await;
            let _ = this.update_in(cx, |p, window, cx| p.saved(idx, r, then, window, cx));
        })
        .detach();
        cx.notify();
    }

    fn saved(&mut self, idx: usize, r: Result<config_store::Saved, SaveError>, then: Option<Leave>, window: &mut Window, cx: &mut Context<Self>) {
        if idx != self.current {
            self.open_file(idx, cx);
        }
        match r {
            Ok(s) => {
                let st = self.state_mut();
                st.draft.reset(s.loaded.text);
                st.mtime = s.loaded.mtime;
                self.save_ui = SaveUi::Saved(Instant::now());
                self.rebuild_inputs();
                let body = match s.backup {
                    Some(b) => format!("原文件备份在 {}", b.display()),
                    None => "新建了这个文件".into(),
                };
                cx.emit(SettingsEvent::Toast { glyph: "check", title: "已保存 · 已通过 prg 校验".into(), body });
                if then.is_some() {
                    // Other unsaved files go next, then the page closes.
                    self.save(false, then, window, cx);
                }
            }
            Err(SaveError::Conflict) => {
                self.save_ui = SaveUi::Idle;
                self.prompt = Some(Prompt { kind: PromptKind::Conflict, then, focus: 0 });
            }
            Err(SaveError::Invalid(issues)) => {
                self.save_ui = SaveUi::Failed(format!("校验未通过：{} 处（见标红的字段）", issues.len()));
                self.state_mut().draft.issues = issues;
                self.bar_shake += 1;
            }
            Err(SaveError::Validator(m) | SaveError::Io(m)) => {
                self.save_ui = SaveUi::Failed(m);
                self.bar_shake += 1;
            }
        }
        cx.notify();
    }

    /// `--shots`: put the page into one demo state (synchronous saves, so the shot shows the outcome).
    #[cfg(feature = "shots")]
    pub fn demo(&mut self, state: DemoState, window: &mut Window, cx: &mut Context<Self>) {
        let find = |p: &Self, group: &str, label: &str| p.files.iter().position(|f| f.group == group && f.label == label).unwrap_or(0);
        let (gate_global, gate_project, pi) = (find(self, "门禁", "全局"), find(self, "门禁", "项目"), find(self, "pi", "models.json"));
        self.prompt = None;
        self.discard(cx);
        let sync_save = |p: &mut Self, force: bool, window: &mut Window, cx: &mut Context<Self>| {
            let f = p.files[p.current].clone();
            let r = config_store::save(&f.path, &p.state().draft.save_text(), f.kind, p.state().mtime, force, &p.validator, &config_store::stamp_now());
            let idx = p.current;
            p.saved(idx, r, None, window, cx);
        };
        match state {
            DemoState::Form => self.open_file(gate_global, cx),
            DemoState::Dirty => {
                self.open_file(gate_project, cx);
                self.edit(|d| d.edit_number("maxRounds", "8x"), false, cx);
                self.edit(|d| d.set("precommit.lint", Value::String("lint".into())), true, cx);
            }
            DemoState::Json => {
                self.open_file(pi, cx);
                self.set_view(View::Json, cx);
            }
            DemoState::JsonSyntax => {
                self.open_file(pi, cx);
                self.set_view(View::Json, cx);
                let broken = self.state().draft.text.replacen("\"models\": [", "\"models\": [,", 1);
                self.state_mut().draft.text = broken.clone();
                if let Some(e) = self.json.clone() {
                    e.update(cx, |e, cx| e.set_value(broken, window, cx));
                }
                self.set_view(View::Form, cx);
            }
            DemoState::Invalid => {
                self.open_file(gate_global, cx);
                self.edit(|d| d.set("agents.reviewer.slots.0", Value::String("anthropic/claude-ghost-9:max".into())), true, cx);
                sync_save(self, false, window, cx);
            }
            DemoState::Saved => {
                self.open_file(gate_global, cx);
                self.edit(|d| d.set("copilotReview.enabled", Value::Bool(false)), false, cx);
                sync_save(self, false, window, cx);
                // Hold the 「已保存」 bar through the shot's settle time.
                self.save_ui = SaveUi::Saved(Instant::now() + std::time::Duration::from_secs(3));
            }
            DemoState::Leave => {
                self.open_file(gate_project, cx);
                self.edit(|d| d.set("maxRounds", Value::from(12)), true, cx);
                self.request_leave(Leave::Close, cx);
            }
            DemoState::Conflict => {
                self.open_file(gate_project, cx);
                self.edit(|d| d.set("maxRounds", Value::from(10)), true, cx);
                self.prompt = Some(Prompt { kind: PromptKind::Conflict, then: None, focus: 0 });
            }
        }
        cx.notify();
    }

    /// Keys while the page is shown (§12): ⌘S saves, Esc closes the prompt or leaves.
    /// True when the key was used.
    pub fn key(&mut self, ks: &Keystroke, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let m = ks.modifiers;
        if let Some(p) = self.prompt.as_mut() {
            let n = p.options().len();
            match ks.key.as_str() {
                "escape" => {
                    // Esc = 继续编辑 on the way out; on a conflict it keeps the draft and the prompt goes.
                    self.prompt = None;
                }
                "up" => p.focus = (p.focus + n - 1) % n,
                "down" | "tab" => p.focus = (p.focus + 1) % n,
                "enter" => {
                    let f = p.focus;
                    self.answer(f, window, cx);
                }
                _ => return false,
            }
            cx.notify();
            return true;
        }
        match (m.platform, ks.key.as_str()) {
            (true, "s") => {
                self.save(false, None, window, cx);
                true
            }
            (false, "escape") if self.focus.is_focused(window) || window.focused(cx).is_none() => {
                self.request_leave(Leave::Close, cx);
                true
            }
            _ => false,
        }
    }

    /// Per-frame bookkeeping: the save bar follows dirtiness, a finished save sinks it after `save_hold`.
    pub fn tick(&mut self, now: Instant) -> bool {
        if let SaveUi::Saved(at) = self.save_ui {
            if now.saturating_duration_since(at) > self.th.ms("save_hold") {
                self.save_ui = SaveUi::Idle;
            }
        }
        let up = self.state().draft.dirty() || !matches!(self.save_ui, SaveUi::Idle);
        let target = if up { 1. } else { 0. };
        if self.bar.to != target {
            let d = if self.reduce { self.th.ms("reduced_motion_fade") } else { self.th.ms("save_bar") };
            self.bar.retarget(target, now, d, self.th.curve("smooth"));
        }
        self.bar.running(now) || self.seg.running(now) || self.nav_y.running(now) || matches!(self.save_ui, SaveUi::Saved(_))
    }
}
