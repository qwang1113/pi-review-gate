//! The client's shared state: the session tree, the pi processes behind it, each
//! session's conversation and status widgets, pending gate dialogs, unread marks
//! and focus. The host server and the window both act through `Hub`; neither
//! owns state of its own.

use crate::protocol::{
    self, CloseParams, DecorateParams, DialogOutcome, DialogParams, ErrorCode, NotifyParams, OpenParams, Role, WireError,
};
use crate::rpc::{self, Output, Process, Record, RpcCommand, UiAnswer, UiRequest};
use crate::sessions::SessionTree;
use crate::ui::chat_model::{Chat, Item};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// §6 `session.close`: stdin EOF first, signals after this grace period.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub struct PendingDialog {
    pub owner: String,
    pub conn: u64,
    pub params: DialogParams,
    reply: Sender<DialogOutcome>,
}

/// A pi-native `extension_ui_request` dialog waiting for the user (rendered by t5).
pub struct PendingUi {
    pub session: String,
    pub id: String,
    pub request: rpc::UiRequest,
}

#[derive(Default)]
pub struct State {
    pub tree: SessionTree,
    procs: HashMap<String, Arc<Process>>,
    pub chats: HashMap<String, Chat>,
    /// pi `setWidget` string-array widgets per session, by widget key.
    pub widgets: HashMap<String, BTreeMap<String, Vec<String>>>,
    /// pi `setStatus` texts per session, by status key.
    pub statuses: HashMap<String, BTreeMap<String, String>>,
    /// Sessions with news the user has not looked at (cleared on selection).
    pub unread: HashSet<String>,
    /// The last stderr (or unparsable stdout) line per session, for the exit notice.
    last_stderr: HashMap<String, String>,
    pub dialogs: Vec<PendingDialog>,
    pub ui_requests: Vec<PendingUi>,
    /// The session the user has selected in the window.
    pub focused: Option<String>,
    pub frontmost: bool,
    /// Set by `focus`; the window consumes it and brings itself forward.
    pub activate_requested: bool,
    /// A `notify` that arrived while the app was frontmost: shown as the in-app banner (§10).
    pub banner: Option<NotifyParams>,
}

pub type Notifier = Box<dyn Fn(&NotifyParams) -> bool + Send + Sync>;

pub struct Hub {
    state: Mutex<State>,
    version: AtomicU64,
    /// Ids for the RPC commands this client writes.
    seq: AtomicU64,
    socket: String,
    /// argv that starts a root pi session, before `--mode rpc` is added.
    pi_argv: Vec<String>,
    notifier: Notifier,
    me: Weak<Hub>,
}

impl Hub {
    pub fn new(socket: String, pi_argv: Vec<String>, notifier: Notifier) -> Arc<Hub> {
        Arc::new_cyclic(|me| Hub { state: Mutex::default(), version: AtomicU64::new(0), seq: AtomicU64::new(0), socket, pi_argv, notifier, me: me.clone() })
    }

    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Bumped on every change the window should repaint for.
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    fn changed(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    pub fn open_root(&self, cwd: &str) -> Result<String, WireError> {
        let argv = rpc::rpc_argv(&self.pi_argv);
        self.spawn(None, Role::Root, None, "main", &argv, cwd, &BTreeMap::new()).map(|(id, _)| id)
    }

    pub fn open_child(&self, requester: &str, p: &OpenParams) -> Result<(String, u32), WireError> {
        let argv = rpc::rpc_argv(&p.argv);
        let (id, pid) = self.spawn(Some(requester), p.role, Some(p.placement), &p.title, &argv, &p.cwd, &p.env)?;
        // pi reads stdin only once RPC mode is up, and a message past the pipe's
        // capacity blocks the write until then — so it is written off the connection
        // thread (the open must answer within prg's timeout). A child that cannot take
        // its task is useless: it is closed, and prg's liveness read sees it gone.
        if let Some(message) = p.initial_message.clone() {
            let (me, requester, sid) = (self.me.clone(), requester.to_string(), id.clone());
            std::thread::spawn(move || {
                let Some(hub) = me.upgrade() else { return };
                if hub.prompt(&sid, &message).is_err() {
                    let _ = hub.close(&requester, &CloseParams::Session { host_session_id: sid });
                }
            });
        }
        Ok((id, pid))
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        parent: Option<&str>,
        role: Role,
        placement: Option<protocol::Placement>,
        title: &str,
        argv: &[String],
        cwd: &str,
        env: &BTreeMap<String, String>,
    ) -> Result<(String, u32), WireError> {
        // Held across the spawn so the child's `hello` can never race ahead of its pid.
        let mut st = self.lock();
        let id = st.tree.insert(parent, role, placement, title, cwd);
        let env = protocol::child_env(std::env::vars(), env, &self.socket, &id);
        let me = self.me.clone();
        let sid = id.clone();
        let spawned = Process::spawn(argv, cwd, &env, move |o| {
            if let Some(hub) = me.upgrade() {
                hub.on_output(&sid, o);
            }
        });
        let proc = match spawned {
            Ok(p) => p,
            Err(e) => {
                st.tree.mark_dead(&id);
                drop(st);
                self.changed();
                return Err(WireError::new(ErrorCode::Unavailable, format!("cannot start `{}`: {e}", argv[0])));
            }
        };
        st.tree.set_pid(&id, proc.pid);
        let pid = proc.pid;
        st.procs.insert(id.clone(), proc);
        drop(st);
        self.changed();
        Ok((id, pid))
    }

    /// Everything a session's process reports (also the demo's injection point).
    pub fn on_output(&self, id: &str, o: Output) {
        let mut st = self.lock();
        let st = &mut *st;
        let before = st.chats.get(id).map_or(0, |c| c.rev);
        match o {
            Output::Record(Record::UiRequest { id: ui_id, request }) => match request {
                UiRequest::SetWidget { key, lines, .. } => {
                    let w = st.widgets.entry(id.to_string()).or_default();
                    match lines {
                        Some(l) => w.insert(key, l),
                        None => w.remove(&key),
                    };
                }
                UiRequest::SetStatus { key, text } => {
                    let s = st.statuses.entry(id.to_string()).or_default();
                    match text {
                        Some(t) => s.insert(key, t),
                        None => s.remove(&key),
                    };
                }
                r if r.is_dialog() => st.ui_requests.push(PendingUi { session: id.to_string(), id: ui_id, request: r }),
                _ => {}
            },
            Output::Record(Record::Event { kind, raw }) => st.chats.entry(id.to_string()).or_default().apply(&kind, &raw, now_ms()),
            Output::Record(Record::Response { success: false, error: Some(e), .. }) => {
                let chat = st.chats.entry(id.to_string()).or_default();
                chat.items.push(Item::Notice { text: e, error: true });
                chat.rev += 1;
            }
            Output::Record(Record::Response { .. }) => {}
            Output::Unparsed { line, error } => {
                st.last_stderr.insert(id.to_string(), format!("{error}: {line}"));
            }
            Output::Stderr(line) => {
                st.last_stderr.insert(id.to_string(), line);
            }
            Output::Exited(code) => {
                st.tree.mark_dead(id);
                st.procs.remove(id);
                st.ui_requests.retain(|u| u.session != id);
                let chat = st.chats.entry(id.to_string()).or_default();
                chat.running = false;
                let code = code.map_or("signal".into(), |c| c.to_string());
                let tail = st.last_stderr.remove(id).map(|l| format!("：{l}")).unwrap_or_default();
                chat.items.push(Item::Notice { text: format!("会话已退出（exit {code}）{tail}"), error: true });
                chat.rev += 1;
            }
        }
        if st.chats.get(id).map_or(0, |c| c.rev) != before && st.focused.as_deref() != Some(id) {
            st.unread.insert(id.to_string());
        }
        self.changed();
    }

    /// A session with no process behind it (the `--demo` window).
    pub fn insert_detached(&self, parent: Option<&str>, role: Role, title: &str, cwd: &str) -> String {
        let id = self.lock().tree.insert(parent, role, None, title, cwd);
        self.changed();
        id
    }

    /// Only a process we spawned may claim its id (`hello`).
    pub fn owns(&self, id: &str, pid: u32) -> bool {
        self.lock().tree.owns(id, pid)
    }

    pub fn list(&self) -> Vec<protocol::ListEntry> {
        self.lock().tree.list()
    }

    pub fn pin(&self, requester: &str, reason: &str) {
        self.lock().tree.pin(requester, reason);
        self.changed();
    }

    /// Idempotent: a target that is already gone is `Ok` and absent from the result.
    pub fn close(&self, requester: &str, p: &CloseParams) -> Result<Vec<String>, WireError> {
        let mut st = self.lock();
        let targets = match p {
            CloseParams::Children {} => st.tree.group_of(requester),
            CloseParams::Session { host_session_id: id } if !st.tree.is_alive(id) => vec![],
            CloseParams::Session { host_session_id: id } if st.tree.may_close(requester, id) => vec![id.clone()],
            CloseParams::Session { host_session_id: id } => {
                return Err(WireError::new(ErrorCode::Forbidden, format!("`{id}` is not yours to close")));
            }
        };
        for id in &targets {
            // Gone from `session.list` at once, like a killed tmux window; the process
            // itself gets stdin EOF and the grace period.
            st.tree.mark_dead(id);
            if let Some(p) = st.procs.get(id) {
                p.shutdown(CLOSE_GRACE);
            }
        }
        drop(st);
        self.changed();
        Ok(targets)
    }

    pub fn decorate(&self, requester: &str, p: &DecorateParams) -> Result<(), WireError> {
        let mut st = self.lock();
        let id = &p.host_session_id;
        if st.tree.get(id).is_none() {
            return Err(WireError::new(ErrorCode::NotFound, format!("unknown session `{id}`")));
        }
        if !st.tree.may_write(requester, id) {
            return Err(WireError::new(ErrorCode::Forbidden, format!("`{id}` is not yours to decorate")));
        }
        st.tree.decorate(p);
        drop(st);
        self.changed();
        Ok(())
    }

    pub fn focus(&self, id: &str) -> Result<(), WireError> {
        let mut st = self.lock();
        if st.tree.get(id).is_none() {
            return Err(WireError::new(ErrorCode::NotFound, format!("unknown session `{id}`")));
        }
        st.focused = Some(id.to_string());
        st.unread.remove(id);
        st.activate_requested = true;
        drop(st);
        self.changed();
        Ok(())
    }

    pub fn focus_state(&self) -> (Option<String>, bool) {
        let st = self.lock();
        (st.focused.clone(), st.frontmost)
    }

    /// prg already suppressed the case where the user watches that session; when the
    /// app is frontmost the rest shows as the in-app banner instead of a system one.
    pub fn notify(&self, p: &NotifyParams) -> bool {
        let mut st = self.lock();
        if st.frontmost {
            st.banner = Some(p.clone());
            drop(st);
            self.changed();
            return true;
        }
        drop(st);
        (self.notifier)(p)
    }

    pub fn dialog_open(&self, owner: &str, conn: u64, params: DialogParams) -> Result<Receiver<DialogOutcome>, WireError> {
        let mut st = self.lock();
        if st.dialogs.iter().any(|d| d.owner == owner && d.params.dialog_id() == params.dialog_id()) {
            return Err(WireError::bad(format!("dialog `{}` is already open", params.dialog_id())));
        }
        let (reply, rx) = channel();
        st.dialogs.push(PendingDialog { owner: owner.to_string(), conn, params, reply });
        drop(st);
        self.changed();
        Ok(rx)
    }

    fn settle_dialogs(&self, pick: impl Fn(&PendingDialog) -> bool, outcome: DialogOutcome) {
        let mut st = self.lock();
        let (done, keep) = std::mem::take(&mut st.dialogs).into_iter().partition(|d| pick(d));
        st.dialogs = keep;
        drop(st);
        let done: Vec<PendingDialog> = done;
        for d in &done {
            let _ = d.reply.send(outcome.clone());
        }
        if !done.is_empty() {
            self.changed();
        }
    }

    /// The user answered a gate dialog in the window.
    pub fn dialog_answer(&self, owner: &str, dialog_id: &str, outcome: DialogOutcome) {
        self.settle_dialogs(|d| d.owner == owner && d.params.dialog_id() == dialog_id, outcome);
    }

    /// `dialog.close`: idempotent, the pending `dialog.open` ends as `aborted`.
    pub fn dialog_close(&self, owner: &str, dialog_id: &str) {
        self.settle_dialogs(|d| d.owner == owner && d.params.dialog_id() == dialog_id, DialogOutcome::Aborted);
    }

    /// A connection went away: its dialogs can no longer be answered.
    pub fn drop_connection(&self, conn: u64) {
        self.settle_dialogs(|d| d.conn == conn, DialogOutcome::Unavailable);
    }

    fn proc_of(&self, id: &str) -> Option<Arc<Process>> {
        self.lock().procs.get(id).cloned()
    }

    pub fn prompt(&self, id: &str, message: &str) -> std::io::Result<()> {
        let proc = self.proc_of(id).ok_or_else(|| std::io::Error::other("session is not running"))?;
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        // `followUp` is accepted whether or not pi is streaming; a plain prompt is refused mid-run.
        proc.send(&RpcCommand::Prompt { id: format!("prompt-{n}"), message: message.to_string(), streaming_behavior: Some("followUp") })
    }

    pub fn abort(&self, id: &str) -> std::io::Result<()> {
        let proc = self.proc_of(id).ok_or_else(|| std::io::Error::other("session is not running"))?;
        proc.send(&RpcCommand::Abort { id: format!("abort-{}", self.seq.fetch_add(1, Ordering::SeqCst)) })
    }

    pub fn answer_ui(&self, session: &str, ui_id: &str, answer: UiAnswer) -> std::io::Result<()> {
        self.lock().ui_requests.retain(|u| !(u.session == session && u.id == ui_id));
        self.changed();
        let proc = self.proc_of(session).ok_or_else(|| std::io::Error::other("session is not running"))?;
        proc.send(&RpcCommand::UiResponse { id: ui_id.to_string(), answer })
    }

    pub fn set_focused(&self, id: Option<String>) {
        let mut st = self.lock();
        if let Some(id) = &id {
            st.unread.remove(id);
        }
        st.focused = id;
        drop(st);
        self.changed();
    }

    pub fn set_frontmost(&self, frontmost: bool) {
        self.lock().frontmost = frontmost;
    }

    pub fn take_activate_request(&self) -> bool {
        std::mem::take(&mut self.lock().activate_requested)
    }

    /// App exit: every pi gets stdin EOF, then the stragglers' groups are killed.
    pub fn shutdown_all(&self) {
        let procs: Vec<Arc<Process>> = self.lock().procs.values().cloned().collect();
        procs.iter().for_each(|p| p.close_stdin());
        let deadline = std::time::Instant::now() + CLOSE_GRACE;
        for p in &procs {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if !p.wait_exit(left) {
                p.kill_group(libc::SIGKILL);
            }
        }
    }
}
