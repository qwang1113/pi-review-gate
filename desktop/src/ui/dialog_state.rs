//! The gate dialog's interaction model (§6, §7, §12 of `docs/desktop/ui-design.md`;
//! wire shape `docs/desktop/host-protocol.md` §7.2): which row has focus, what is
//! selected or checked, the reason editor and its draft, and which key produces
//! which answer. Pure — the view feeds it keys and paints its fields.

use crate::protocol::{DialogOutcome, DialogParams};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    Option(usize),
    Decline,
    Back,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    /// A–D (index 0–3).
    Letter(usize),
    Space,
    Enter,
    Tab,
    ShiftTab,
    /// ⌘← — back to the previous question.
    CmdLeft,
    Esc,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    None,
    /// The view should move focus into the reason editor.
    OpenReason,
    /// The view should return focus to the rows (draft kept).
    CloseReason,
    /// The long-text box scrolls instead of moving focus.
    Scroll(i32),
    Submit(DialogOutcome),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Choice { recommended: Option<usize> },
    Multi,
}

/// What kind of long document a confirm box carries (§7 type badge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Restatement,
    Goal,
    Plan,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DialogUi {
    pub options: Vec<String>,
    pub kind: Kind,
    pub decline: Option<String>,
    pub back: bool,
    /// A choice question with a body renders as the long-text confirm box (§7).
    pub long: bool,
    pub focus: Row,
    pub selected: Option<usize>,
    pub checked: Vec<bool>,
    pub reason_open: bool,
    /// Bumped each time the reason editor opens or closes (replays its transition, §6.3).
    pub reason_flips: u32,
    /// The reason editor's text, kept across Esc (§6.1).
    pub draft: String,
    /// Answer sent, waiting for the card to go (rows render disabled).
    pub answered: bool,
}

/// "问题 3 / 5\n…" (the interview's title, `lib/ask-user-interview.ts`) ⇒ (3, 5).
pub fn progress_of(title: &str) -> Option<(usize, usize)> {
    let rest = title.trim_start().strip_prefix("问题 ")?;
    let (n, rest) = rest.split_once(" / ")?;
    let m: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let (n, m) = (n.trim().parse().ok()?, m.parse().ok()?);
    (n >= 1 && n <= m).then_some((n, m))
}

/// The title without its "问题 N / M" line (the header shows progress on its own).
pub fn question_of(title: &str) -> &str {
    match progress_of(title) {
        Some(_) => title.split_once('\n').map_or("", |(_, q)| q.trim_start()),
        None => title,
    }
}

pub fn doc_kind(title: &str) -> DocKind {
    let t = title.to_lowercase();
    if t.contains("反述") {
        DocKind::Restatement
    } else if t.contains("plan") || t.contains("计划") {
        DocKind::Plan
    } else if t.contains("goal") || t.contains("目标") {
        DocKind::Goal
    } else {
        DocKind::Other
    }
}

impl DialogUi {
    pub fn new(p: &DialogParams) -> DialogUi {
        match p {
            DialogParams::Choice { options, decline_row, back, recommended, body, .. } => {
                let rec = recommended.as_ref().and_then(|r| options.iter().position(|o| o == r));
                DialogUi {
                    options: options.clone(),
                    kind: Kind::Choice { recommended: rec },
                    decline: Some(decline_row.clone()),
                    back: *back,
                    long: body.as_deref().is_some_and(|b| !b.trim().is_empty()),
                    focus: Row::Option(rec.unwrap_or(0)),
                    selected: None,
                    checked: vec![],
                    reason_open: false,
                    reason_flips: 0,
                    draft: String::new(),
                    answered: false,
                }
            }
            DialogParams::Multi { options, decline_row, back, default_checked, .. } => DialogUi {
                checked: options.iter().map(|o| default_checked.contains(o)).collect(),
                options: options.clone(),
                kind: Kind::Multi,
                decline: Some(decline_row.clone()),
                back: *back,
                long: false,
                focus: Row::Option(0),
                selected: None,
                reason_open: false,
                reason_flips: 0,
                draft: String::new(),
                answered: false,
            },
        }
    }

    /// A pi-native `select` (no decline row, no back, no recommendation).
    pub fn plain(options: Vec<String>) -> DialogUi {
        DialogUi {
            options,
            kind: Kind::Choice { recommended: None },
            decline: None,
            back: false,
            long: false,
            focus: Row::Option(0),
            selected: None,
            checked: vec![],
            reason_open: false,
            reason_flips: 0,
            draft: String::new(),
            answered: false,
        }
    }

    pub fn recommended(&self) -> Option<usize> {
        match self.kind {
            Kind::Choice { recommended } => recommended,
            Kind::Multi => None,
        }
    }

    /// Focus order: options → ✎ row → back row (§12).
    pub fn rows(&self) -> Vec<Row> {
        let mut r: Vec<Row> = (0..self.options.len()).map(Row::Option).collect();
        if self.decline.is_some() {
            r.push(Row::Decline);
        }
        if self.back {
            r.push(Row::Back);
        }
        r
    }

    fn step(&mut self, by: isize) {
        let rows = self.rows();
        let at = rows.iter().position(|r| *r == self.focus).unwrap_or(0) as isize;
        let n = rows.len() as isize;
        self.focus = rows[((at + by) % n + n) as usize % rows.len()];
    }

    pub fn checked_options(&self) -> Vec<String> {
        self.options.iter().zip(&self.checked).filter(|(_, c)| **c).map(|(o, _)| o.clone()).collect()
    }

    fn submit(&mut self, o: DialogOutcome) -> Effect {
        self.answered = true;
        Effect::Submit(o)
    }

    /// Activate a row (Enter on it, or a click).
    pub fn activate(&mut self, row: Row) -> Effect {
        if self.answered {
            return Effect::None;
        }
        self.focus = row;
        match (row, &self.kind) {
            (Row::Decline, _) => {
                self.reason_open = true;
                self.reason_flips += 1;
                Effect::OpenReason
            }
            (Row::Back, _) => self.submit(DialogOutcome::Back),
            (Row::Option(i), Kind::Choice { .. }) => {
                self.selected = Some(i);
                let option = self.options[i].clone();
                self.submit(DialogOutcome::Picked { option })
            }
            (Row::Option(_), Kind::Multi) => {
                let options = self.checked_options();
                self.submit(DialogOutcome::Checked { options })
            }
        }
    }

    pub fn toggle(&mut self, i: usize) {
        if let Some(c) = self.checked.get_mut(i) {
            *c = !*c;
            self.focus = Row::Option(i);
        }
    }

    pub fn key(&mut self, key: Key) -> Effect {
        if self.answered {
            return Effect::None;
        }
        if self.reason_open {
            // Only Esc reaches the machine from the editor; ⌘Enter goes through `submit_reason`.
            if key == Key::Esc {
                self.reason_open = false;
                self.reason_flips += 1;
                return Effect::CloseReason;
            }
            return Effect::None;
        }
        let multi = self.kind == Kind::Multi;
        match key {
            Key::Up if self.long => Effect::Scroll(-1),
            Key::Down if self.long => Effect::Scroll(1),
            Key::Up | Key::ShiftTab => {
                self.step(-1);
                Effect::None
            }
            Key::Down | Key::Tab => {
                self.step(1);
                Effect::None
            }
            Key::Space if self.long => Effect::Scroll(1),
            Key::Letter(i) if i < self.options.len() => {
                if multi {
                    self.toggle(i);
                } else {
                    self.focus = Row::Option(i);
                    self.selected = Some(i);
                }
                Effect::None
            }
            Key::Space if multi => {
                if let Row::Option(i) = self.focus {
                    self.toggle(i);
                }
                Effect::None
            }
            Key::Enter => {
                // Multi: Enter submits the checklist unless focus is on ✎ / back (§12).
                let row = match (multi, self.focus) {
                    (true, Row::Option(_)) => Row::Option(0),
                    _ => self.focus,
                };
                self.activate(row)
            }
            Key::CmdLeft if self.back => self.submit(DialogOutcome::Back),
            Key::Esc => self.submit(DialogOutcome::Dismissed),
            _ => Effect::None,
        }
    }

    /// ⌘Enter in the reason editor. An empty reason is a valid answer (§7.2).
    pub fn submit_reason(&mut self, reason: String) -> Effect {
        if self.answered || !self.reason_open {
            return Effect::None;
        }
        self.draft = reason.clone();
        self.submit(DialogOutcome::Decline { reason })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(back: bool, rec: Option<&str>, body: Option<&str>) -> DialogParams {
        DialogParams::Choice {
            dialog_id: "d".into(),
            title: "问题 2 / 5\n选哪个？".into(),
            body: body.map(str::to_string),
            options: vec!["甲".into(), "乙".into(), "丙".into()],
            decline_row: "✎ 不选，我说明原因".into(),
            back,
            recommended: rec.map(str::to_string),
        }
    }

    fn multi(default_checked: &[&str]) -> DialogParams {
        DialogParams::Multi {
            dialog_id: "m".into(),
            title: "勾选".into(),
            body: None,
            options: vec!["a".into(), "b".into(), "c".into()],
            decline_row: "✎".into(),
            back: false,
            default_checked: default_checked.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn focus_opens_on_the_recommendation_and_letters_select_without_submitting() {
        let mut d = DialogUi::new(&choice(false, Some("乙"), None));
        assert_eq!(d.focus, Row::Option(1));
        assert_eq!(d.key(Key::Letter(2)), Effect::None);
        assert_eq!((d.focus, d.selected), (Row::Option(2), Some(2)));
        assert_eq!(d.key(Key::Enter), Effect::Submit(DialogOutcome::Picked { option: "丙".into() }));
        assert_eq!(d.key(Key::Enter), Effect::None, "answered once");
    }

    #[test]
    fn rows_cycle_through_decline_and_back_only_when_offered() {
        let d = DialogUi::new(&choice(false, None, None));
        assert_eq!(d.rows(), vec![Row::Option(0), Row::Option(1), Row::Option(2), Row::Decline]);
        let mut d = DialogUi::new(&choice(true, None, None));
        d.key(Key::Up);
        assert_eq!(d.focus, Row::Back, "wraps from the first row to the last");
        assert_eq!(d.key(Key::Enter), Effect::Submit(DialogOutcome::Back));
        let mut d = DialogUi::new(&choice(false, None, None));
        assert_eq!(d.key(Key::CmdLeft), Effect::None, "no back row on question 1");
        let mut d = DialogUi::new(&choice(true, None, None));
        assert_eq!(d.key(Key::CmdLeft), Effect::Submit(DialogOutcome::Back));
    }

    #[test]
    fn reason_editor_keeps_its_draft_across_esc() {
        let mut d = DialogUi::new(&choice(false, None, None));
        assert_eq!(d.activate(Row::Decline), Effect::OpenReason);
        d.draft = "因为".into();
        assert_eq!(d.key(Key::Esc), Effect::CloseReason, "Esc in the editor goes back, not closes");
        assert!(!d.reason_open && !d.answered);
        assert_eq!(d.draft, "因为");
        assert_eq!(d.submit_reason("x".into()), Effect::None, "editor is closed");
        d.activate(Row::Decline);
        assert_eq!(d.submit_reason("因为太慢".into()), Effect::Submit(DialogOutcome::Decline { reason: "因为太慢".into() }));
    }

    #[test]
    fn esc_on_the_list_dismisses() {
        let mut d = DialogUi::new(&choice(false, None, None));
        assert_eq!(d.key(Key::Esc), Effect::Submit(DialogOutcome::Dismissed));
    }

    #[test]
    fn multi_starts_checked_and_accepts_an_empty_list() {
        let mut d = DialogUi::new(&multi(&["a", "c"]));
        assert_eq!(d.checked, vec![true, false, true]);
        d.key(Key::Space);
        d.key(Key::Letter(2));
        assert_eq!(d.checked, vec![false, false, false]);
        assert_eq!(d.key(Key::Enter), Effect::Submit(DialogOutcome::Checked { options: vec![] }));
        let mut d = DialogUi::new(&multi(&["b"]));
        d.key(Key::Down);
        d.key(Key::Down);
        d.key(Key::Down);
        assert_eq!(d.focus, Row::Decline);
        assert_eq!(d.key(Key::Enter), Effect::OpenReason, "Enter on ✎ opens the editor");
    }

    #[test]
    fn long_box_scrolls_with_arrows_and_tabs_between_buttons() {
        let mut d = DialogUi::new(&choice(false, Some("甲"), Some("全文")));
        assert!(d.long);
        assert_eq!(d.key(Key::Down), Effect::Scroll(1));
        d.key(Key::Tab);
        assert_eq!(d.focus, Row::Option(1));
    }

    #[test]
    fn titles() {
        assert_eq!(progress_of("问题 2 / 5\n选哪个？"), Some((2, 5)));
        assert_eq!(question_of("问题 2 / 5\n选哪个？"), "选哪个？");
        assert_eq!(progress_of("review-gate: 批准？"), None);
        assert_eq!(progress_of("问题 6 / 5"), None);
        assert_eq!(doc_kind("review-gate: 这是 AI 对需求的反述——理解对了吗？"), DocKind::Restatement);
        assert_eq!(doc_kind("review-gate: 批准项目经理的任务计划（plan）？"), DocKind::Plan);
        assert_eq!(doc_kind("review-gate: AI 提交了本次任务的目标（退出条约）——是否认可？"), DocKind::Goal);
    }
}
