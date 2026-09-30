//! Session tree (§5 of `docs/desktop/host-protocol.md`): root sessions the user
//! opens, children prg opens with `session.open`, liveness, group pins and the
//! write-authorization rule. Pure state — no processes, no IO — so every rule
//! is a unit test.

use crate::protocol::{DecorateParams, ListEntry, PaneState, Placement, Role};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Decoration {
    pub label: Option<String>,
    pub color_seed: Option<String>,
    pub state: Option<PaneState>,
    pub state_at: Option<u64>,
    pub kind: Option<String>,
    pub repo: Option<String>,
    pub pi_session_id: Option<String>,
    pub session_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub parent: Option<String>,
    pub role: Role,
    /// `None` for roots.
    pub placement: Option<Placement>,
    pub title: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub alive: bool,
    /// Pin on THIS session's own child group (`session.pin`); survives its exit.
    pub group_pin: Option<String>,
    pub decoration: Decoration,
}

#[derive(Debug, Default)]
pub struct SessionTree {
    /// Creation order; dead sessions stay so parents/pins remain answerable.
    sessions: Vec<Session>,
    next: u64,
}

impl SessionTree {
    pub fn get(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn all(&self) -> &[Session] {
        &self.sessions
    }

    pub fn is_alive(&self, id: &str) -> bool {
        self.get(id).is_some_and(|s| s.alive)
    }

    /// Registers a session (alive, no pid yet). `parent` is `None` only for roots.
    pub fn insert(&mut self, parent: Option<&str>, role: Role, placement: Option<Placement>, title: &str, cwd: &str) -> String {
        self.next += 1;
        let tag = match role {
            Role::Root => "root",
            Role::Judge => "judge",
            Role::Worker => "worker",
            Role::OrchestrationChild => "child",
            Role::Successor => "successor",
        };
        let id = format!("s{}-{tag}", self.next);
        self.sessions.push(Session {
            id: id.clone(),
            parent: parent.map(str::to_string),
            role,
            placement,
            title: title.to_string(),
            cwd: cwd.to_string(),
            pid: None,
            alive: true,
            group_pin: None,
            decoration: Decoration::default(),
        });
        id
    }

    pub fn set_pid(&mut self, id: &str, pid: u32) {
        if let Some(s) = self.get_mut(id) {
            s.pid = Some(pid);
        }
    }

    pub fn mark_dead(&mut self, id: &str) {
        if let Some(s) = self.get_mut(id) {
            s.alive = false;
        }
    }

    /// Only a process we spawned with this exact pid may claim the id in `hello`.
    pub fn owns(&self, id: &str, pid: u32) -> bool {
        self.get(id).is_some_and(|s| s.alive && s.pid == Some(pid))
    }

    /// Ancestors of `id`, nearest first. A parent is always minted before its child,
    /// so the chain is finite.
    fn ancestors<'a>(&'a self, id: &str) -> impl Iterator<Item = &'a str> + 'a {
        let first = self.get(id).and_then(|s| s.parent.as_deref());
        std::iter::successors(first, |p| self.get(p).and_then(|s| s.parent.as_deref()))
    }

    pub fn is_descendant(&self, ancestor: &str, id: &str) -> bool {
        self.ancestors(id).any(|p| p == ancestor)
    }

    /// A child whose parent is no longer alive (roots are never orphans).
    pub fn is_orphan(&self, id: &str) -> bool {
        self.get(id).and_then(|s| s.parent.as_deref()).is_some_and(|p| !self.is_alive(p))
    }

    /// §5: close / decorate may target the requester itself, its descendants, or orphans.
    pub fn may_write(&self, requester: &str, target: &str) -> bool {
        target == requester || self.is_descendant(requester, target) || self.is_orphan(target)
    }

    /// `session.list`: live sessions only; `groupPin` is the pin the parent put on its group.
    pub fn list(&self) -> Vec<ListEntry> {
        self.sessions
            .iter()
            .filter(|s| s.alive)
            .map(|s| ListEntry {
                host_session_id: s.id.clone(),
                parent: s.parent.clone(),
                role: s.role,
                title: s.title.clone(),
                pid: s.pid,
                group_pin: s.parent.as_deref().and_then(|p| self.get(p)).and_then(|p| p.group_pin.clone()),
            })
            .collect()
    }

    pub fn pin(&mut self, requester: &str, reason: &str) {
        if let Some(s) = self.get_mut(requester) {
            s.group_pin = Some(reason.to_string());
        }
    }

    /// Live members of the requester's child group (`session.close {target:"children"}`).
    /// A `beside-opener` successor is not in the group, exactly as the tmux relay pane
    /// lives in the opener's window rather than in the scope session.
    pub fn group_of(&self, requester: &str) -> Vec<String> {
        self.sessions
            .iter()
            .filter(|s| s.alive && s.parent.as_deref() == Some(requester) && s.placement == Some(Placement::OwnGroup))
            .map(|s| s.id.clone())
            .collect()
    }

    /// Patch semantics: only the fields present in the request change.
    pub fn decorate(&mut self, p: &DecorateParams) {
        let Some(s) = self.get_mut(&p.host_session_id) else { return };
        let d = &mut s.decoration;
        let set = |slot: &mut Option<String>, v: &Option<String>| {
            if v.is_some() {
                slot.clone_from(v);
            }
        };
        set(&mut d.label, &p.label);
        set(&mut d.color_seed, &p.color_seed);
        set(&mut d.kind, &p.kind);
        set(&mut d.repo, &p.repo);
        set(&mut d.pi_session_id, &p.pi_session_id);
        if p.state.is_some() {
            d.state = p.state;
        }
        if p.state_at.is_some() {
            d.state_at = p.state_at;
        }
        if let Some(name) = &p.session_name {
            d.session_name.clone_from(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (SessionTree, String, String, String) {
        let mut t = SessionTree::default();
        let root = t.insert(None, Role::Root, None, "main", "/r");
        t.set_pid(&root, 100);
        let judge = t.insert(Some(&root), Role::Judge, Some(Placement::OwnGroup), "review", "/r");
        let grandchild = t.insert(Some(&judge), Role::Worker, Some(Placement::OwnGroup), "w", "/r");
        (t, root, judge, grandchild)
    }

    #[test]
    fn open_list_and_die() {
        let (mut t, root, judge, _) = tree();
        let ids: Vec<_> = t.list().into_iter().map(|e| e.host_session_id).collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(t.list()[1].parent.as_deref(), Some(root.as_str()));
        t.mark_dead(&judge);
        assert!(!t.list().iter().any(|e| e.host_session_id == judge));
        assert!(t.get(&judge).is_some(), "dead sessions keep their record");
    }

    #[test]
    fn hello_identity_is_bound_to_the_spawned_pid() {
        let (mut t, root, _, _) = tree();
        assert!(t.owns(&root, 100));
        assert!(!t.owns(&root, 101));
        assert!(!t.owns("s99-root", 100));
        t.mark_dead(&root);
        assert!(!t.owns(&root, 100));
    }

    #[test]
    fn write_authorization_self_descendant_orphan() {
        let (mut t, root, judge, grandchild) = tree();
        let other = t.insert(None, Role::Root, None, "other", "/o");
        assert!(t.may_write(&root, &root));
        assert!(t.may_write(&root, &grandchild));
        assert!(!t.may_write(&judge, &root), "a child may not touch its parent");
        assert!(!t.may_write(&other, &judge));
        t.mark_dead(&root);
        assert!(t.is_orphan(&judge));
        assert!(t.may_write(&other, &judge), "orphans are writable by anyone");
        assert!(!t.is_orphan(&other), "roots are never orphans");
    }

    #[test]
    fn group_pin_is_reported_on_children_and_survives_the_parent() {
        let (mut t, root, judge, _) = tree();
        assert_eq!(t.list()[1].group_pin, None);
        t.pin(&root, "orchestration-child");
        let pin_of = |t: &SessionTree, id: &str| t.list().into_iter().find(|e| e.host_session_id == id).unwrap().group_pin;
        assert_eq!(pin_of(&t, &judge).as_deref(), Some("orchestration-child"));
        assert_eq!(pin_of(&t, &root), None);
        t.mark_dead(&root);
        assert_eq!(pin_of(&t, &judge).as_deref(), Some("orchestration-child"));
    }

    #[test]
    fn child_group_excludes_successors_grandchildren_and_the_dead() {
        let (mut t, root, judge, _) = tree();
        let worker = t.insert(Some(&root), Role::Worker, Some(Placement::OwnGroup), "w", "/r");
        t.insert(Some(&root), Role::Successor, Some(Placement::BesideOpener), "next", "/r");
        t.mark_dead(&worker);
        assert_eq!(t.group_of(&root), vec![judge]);
    }

    #[test]
    fn decorate_is_a_patch() {
        let (mut t, root, _, _) = tree();
        let patch = |p: DecorateParams| DecorateParams { host_session_id: root.clone(), ..p };
        t.decorate(&patch(DecorateParams { label: Some("l".into()), session_name: Some(Some("nm".into())), ..Default::default() }));
        t.decorate(&patch(DecorateParams { state: Some(PaneState::Working), ..Default::default() }));
        let d = &t.get(&root).unwrap().decoration;
        assert_eq!((d.label.as_deref(), d.session_name.as_deref(), d.state), (Some("l"), Some("nm"), Some(PaneState::Working)));
        t.decorate(&patch(DecorateParams { session_name: Some(None), ..Default::default() }));
        let d = &t.get(&root).unwrap().decoration;
        assert_eq!((d.label.as_deref(), d.session_name.as_deref()), (Some("l"), None));
    }
}
