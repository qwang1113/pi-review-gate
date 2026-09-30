//! The session list's structure (§4 of `docs/desktop/ui-design.md`): fixed groups
//! (会话 → JUDGES → WORKERS → 子任务), a child task's own judges/workers nested
//! under it, per-row role icon, status and unread mark. Pure over the session
//! tree so grouping and ordering are unit tests.

use crate::protocol::{PaneState, Role};
use crate::sessions::Session;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Working,
    WaitingInput,
    WaitingJudge,
    Idle,
    Done,
    Dead,
}

impl Status {
    pub fn active(self) -> bool {
        matches!(self, Status::Working | Status::WaitingInput | Status::WaitingJudge)
    }
    pub fn token(self) -> &'static str {
        match self {
            Status::Working => "status.working",
            Status::WaitingInput => "status.waiting_input",
            Status::WaitingJudge => "status.waiting_judge",
            Status::Idle => "status.idle",
            Status::Done => "status.done",
            Status::Dead => "status.dead",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Status::Working => "working",
            Status::WaitingInput => "waiting-input",
            Status::WaitingJudge => "waiting-judge",
            Status::Idle => "idle",
            Status::Done => "done",
            Status::Dead => "dead",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Group {
    Sessions,
    Judges,
    Workers,
    Children,
}

impl Group {
    pub const ALL: [Group; 4] = [Group::Sessions, Group::Judges, Group::Workers, Group::Children];
    pub fn title(self) -> &'static str {
        match self {
            Group::Sessions => "会话",
            Group::Judges => "JUDGES",
            Group::Workers => "WORKERS",
            Group::Children => "子任务",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub icon: &'static str,
    pub status: Status,
    pub depth: usize,
    pub unread: bool,
    /// Epoch seconds the current state began (hover card for waiting-judge).
    pub state_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRows {
    pub group: Group,
    pub rows: Vec<Row>,
    pub active: usize,
    pub waiting_input: bool,
}

/// Which judge a session is: the role name appears in prg's title / label.
const JUDGE_ICONS: [(&str, &str); 5] = [
    ("quality-auditor", "shield-alert"),
    ("goal-auditor", "target"),
    ("acceptance", "badge-check"),
    ("adviser", "sparkles"),
    ("reviewer", "file-check-corner"),
];

pub fn icon_of(s: &Session) -> &'static str {
    let hay = format!("{} {} {}", s.title, s.decoration.label.as_deref().unwrap_or(""), s.decoration.session_name.as_deref().unwrap_or(""));
    match s.role {
        Role::Judge => JUDGE_ICONS.iter().find(|(k, _)| hay.contains(k)).map_or("file-check-corner", |(_, i)| i),
        Role::Worker => "wrench",
        Role::OrchestrationChild => "git-branch",
        Role::Root | Role::Successor if s.decoration.kind.as_deref() == Some("orchestrator") => "crown",
        Role::Root | Role::Successor => "bot",
    }
}

pub fn status_of(s: &Session, running: bool) -> Status {
    if !s.alive {
        return Status::Dead;
    }
    match s.decoration.state {
        Some(PaneState::Working | PaneState::ModeChanged) => Status::Working,
        Some(PaneState::WaitingInput) => Status::WaitingInput,
        Some(PaneState::WaitingJudge) => Status::WaitingJudge,
        Some(PaneState::Done) => Status::Done,
        Some(PaneState::Dead) => Status::Dead,
        Some(PaneState::Idle | PaneState::Stalled) => Status::Idle,
        None if running => Status::Working,
        None => Status::Idle,
    }
}

pub fn name_of(s: &Session) -> String {
    if let Some(n) = &s.decoration.session_name {
        return n.clone();
    }
    match s.role {
        Role::Root => {
            let repo = s.decoration.repo.as_deref().unwrap_or(&s.cwd);
            let base = repo.rsplit('/').find(|p| !p.is_empty()).unwrap_or(repo);
            format!("主会话 · {base}")
        }
        _ => s.title.clone(),
    }
}

pub struct Inputs<'a> {
    pub sessions: &'a [Session],
    pub unread: &'a HashSet<String>,
    pub running: &'a dyn Fn(&str) -> bool,
    /// A pending gate dialog forces waiting-input even before prg decorates it.
    pub asking: &'a dyn Fn(&str) -> bool,
}

pub fn build(inp: &Inputs) -> Vec<GroupRows> {
    let by_id = |id: &str| inp.sessions.iter().find(|s| s.id == id);
    let row = |s: &Session, depth: usize| {
        let status = match status_of(s, (inp.running)(&s.id)) {
            st if st != Status::Dead && (inp.asking)(&s.id) => Status::WaitingInput,
            st => st,
        };
        Row {
            id: s.id.clone(),
            name: name_of(s),
            icon: icon_of(s),
            status,
            depth,
            unread: inp.unread.contains(&s.id),
            state_at: s.decoration.state_at,
        }
    };
    // A child task owns everything below it, nested (§4.1).
    fn nest<'a>(all: &'a [Session], parent: &str, depth: usize, out: &mut Vec<(&'a Session, usize)>) {
        for s in all.iter().filter(|s| s.parent.as_deref() == Some(parent)) {
            out.push((s, depth));
            nest(all, &s.id, depth + 1, out);
        }
    }
    let mut groups: Vec<GroupRows> = Group::ALL.iter().map(|&g| GroupRows { group: g, rows: vec![], active: 0, waiting_input: false }).collect();
    let mut push = |g: Group, r: Row| {
        let gr = groups.iter_mut().find(|x| x.group == g).expect("fixed groups");
        gr.active += usize::from(r.status.active());
        gr.waiting_input |= r.status == Status::WaitingInput;
        gr.rows.push(r);
    };
    for s in inp.sessions {
        // Top-level placement: roots/successors, and whatever hangs directly off a
        // session that is itself top-level (not inside a child task).
        let parent = s.parent.as_deref().and_then(by_id);
        let under_child = std::iter::successors(parent, |p| p.parent.as_deref().and_then(by_id)).any(|p| p.role == Role::OrchestrationChild);
        if under_child {
            continue;
        }
        let group = match s.role {
            Role::Root | Role::Successor => Group::Sessions,
            Role::Judge => Group::Judges,
            Role::Worker => Group::Workers,
            Role::OrchestrationChild => Group::Children,
        };
        push(group, row(s, 0));
        if s.role == Role::OrchestrationChild {
            let mut nested = vec![];
            nest(inp.sessions, &s.id, 1, &mut nested);
            for (n, d) in nested {
                push(Group::Children, row(n, d));
            }
        }
    }
    groups.retain(|g| !g.rows.is_empty());
    groups
}

/// Rows in on-screen order, skipping collapsed groups (⌘1–9, ⌘[ ⌘]).
pub fn visible_ids(groups: &[GroupRows], collapsed: &HashSet<Group>) -> Vec<String> {
    groups.iter().filter(|g| !collapsed.contains(&g.group)).flat_map(|g| g.rows.iter().map(|r| r.id.clone())).collect()
}

/// ⌘⇧A: the next waiting-input session after `current`, wrapping.
pub fn next_waiting(groups: &[GroupRows], current: Option<&str>) -> Option<String> {
    let rows: Vec<&Row> = groups.iter().flat_map(|g| &g.rows).collect();
    let start = current.and_then(|c| rows.iter().position(|r| r.id == c)).map_or(0, |i| i + 1);
    (0..rows.len()).map(|k| rows[(start + k) % rows.len()]).find(|r| r.status == Status::WaitingInput).map(|r| r.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::SessionTree;

    fn tree() -> SessionTree {
        let mut t = SessionTree::default();
        let root = t.insert(None, Role::Root, None, "main", "/w/pi-review-gate");
        let rev = t.insert(Some(&root), Role::Judge, None, "reviewer", "/w");
        t.insert(Some(&root), Role::Worker, None, "worker-1", "/w");
        let child = t.insert(Some(&root), Role::OrchestrationChild, None, "t1-ui-design", "/w");
        t.insert(Some(&child), Role::Judge, None, "quality-auditor", "/w");
        let dead = t.insert(Some(&root), Role::OrchestrationChild, None, "t2-host-protocol", "/w");
        t.mark_dead(&dead);
        let _ = rev;
        t
    }

    #[test]
    fn groups_in_fixed_order_with_child_owned_sessions_nested() {
        let t = tree();
        let unread: HashSet<String> = ["s3-worker".to_string()].into();
        let g = build(&Inputs { sessions: t.all(), unread: &unread, running: &|id| id == "s2-judge", asking: &|_| false });
        let titles: Vec<&str> = g.iter().map(|g| g.group.title()).collect();
        assert_eq!(titles, vec!["会话", "JUDGES", "WORKERS", "子任务"]);
        assert_eq!(g[0].rows[0].name, "主会话 · pi-review-gate");
        assert_eq!(g[1].rows.len(), 1, "the child's judge is not a top-level judge");
        assert_eq!((g[1].rows[0].icon, g[1].rows[0].status), ("file-check-corner", Status::Working));
        assert!(g[2].rows[0].unread);
        let kids: Vec<(&str, usize, Status)> = g[3].rows.iter().map(|r| (r.name.as_str(), r.depth, r.status)).collect();
        assert_eq!(kids, vec![("t1-ui-design", 0, Status::Idle), ("quality-auditor", 1, Status::Idle), ("t2-host-protocol", 0, Status::Dead)]);
        assert_eq!(g[3].rows[1].icon, "shield-alert");
        assert_eq!((g[1].active, g[3].active), (1, 0));
    }

    #[test]
    fn decorated_state_wins_and_dialogs_force_waiting_input() {
        let mut t = tree();
        t.decorate(&crate::protocol::DecorateParams { host_session_id: "s4-child".into(), state: Some(PaneState::WaitingJudge), ..Default::default() });
        t.decorate(&crate::protocol::DecorateParams { host_session_id: "s1-root".into(), kind: Some("orchestrator".into()), ..Default::default() });
        let none = HashSet::new();
        let g = build(&Inputs { sessions: t.all(), unread: &none, running: &|_| false, asking: &|id| id == "s3-worker" || id == "s6-child" });
        assert_eq!(g[0].rows[0].icon, "crown");
        assert_eq!(g[3].rows[0].status, Status::WaitingJudge);
        assert_eq!(g[2].rows[0].status, Status::WaitingInput);
        assert!(g[2].waiting_input);
        assert_eq!(g[3].rows[2].status, Status::Dead, "a dead session never shows as asking");
        assert_eq!(next_waiting(&g, None).as_deref(), Some("s3-worker"));
        assert_eq!(next_waiting(&g, Some("s3-worker")).as_deref(), Some("s3-worker"), "wraps to itself when alone");
        let collapsed: HashSet<Group> = [Group::Judges].into();
        assert_eq!(visible_ids(&g, &collapsed), vec!["s1-root", "s3-worker", "s4-child", "s5-judge", "s6-child"]);
    }
}
