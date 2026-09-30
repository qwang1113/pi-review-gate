//! The client's shared state: the session tree, the pi processes behind it, each
//! session's raw event log, pending gate dialogs and focus. The host server and
//! the window both act through `Hub`; neither owns state of its own.

use crate::protocol::{
    self, CloseParams, DecorateParams, DialogOutcome, DialogParams, ErrorCode, NotifyParams, OpenParams, Role, WireError,
};
use crate::rpc::{self, Output, Process, Record, RpcCommand, UiAnswer};
use crate::sessions::SessionTree;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// §6 `session.close`: stdin EOF first, signals after this grace period.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);
/// Lines kept per session for the raw event view.
const LOG_CAP: usize = 5000;

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
    pub logs: HashMap<String, VecDeque<String>>,
    pub dialogs: Vec<PendingDialog>,
    pub ui_requests: Vec<PendingUi>,
    /// The session the user has selected in the window.
    pub focused: Option<String>,
    pub frontmost: bool,
    /// Set by `focus`; the window consumes it and brings itself forward.
    pub activate_requested: bool,
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
        self.spawn(Some(requester), p.role, Some(p.placement), &p.title, &argv, &p.cwd, &p.env)
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

    fn on_output(&self, id: &str, o: Output) {
        let mut st = self.lock();
        let line = match o {
            Output::Record(Record::UiRequest { id: ui_id, request }, line) => {
                if request.is_dialog() {
                    st.ui_requests.push(PendingUi { session: id.to_string(), id: ui_id, request });
                }
                line
            }
            Output::Record(_, line) => line,
            Output::Unparsed { line, error } => format!("[unparsed: {error}] {line}"),
            Output::Stderr(line) => format!("[stderr] {line}"),
            Output::Exited(code) => {
                st.tree.mark_dead(id);
                st.procs.remove(id);
                st.ui_requests.retain(|u| u.session != id);
                format!("[exited: {}]", code.map_or("signal".into(), |c| c.to_string()))
            }
        };
        let log = st.logs.entry(id.to_string()).or_default();
        if log.len() == LOG_CAP {
            log.pop_front();
        }
        log.push_back(line);
        drop(st);
        self.changed();
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
            CloseParams::Session { host_session_id: id } if st.tree.may_write(requester, id) => vec![id.clone()],
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
        st.activate_requested = true;
        drop(st);
        self.changed();
        Ok(())
    }

    pub fn focus_state(&self) -> (Option<String>, bool) {
        let st = self.lock();
        (st.focused.clone(), st.frontmost)
    }

    pub fn notify(&self, p: &NotifyParams) -> bool {
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
        self.lock().focused = id;
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
