//! End-to-end over a real socket, with a fake `pi` that records its env and lives
//! until stdin closes — the same lifecycle contract the real one has.

use super::*;
use crate::hub::Hub;
use serde_json::json;
use std::sync::atomic::AtomicUsize;
use std::time::{Duration, Instant};

static DIRS: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    hub: Arc<Hub>,
    dir: PathBuf,
    socket: PathBuf,
    notified: Arc<Mutex<Vec<String>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.hub.shutdown_all();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Fixture {
    let n = DIRS.fetch_add(1, Ordering::SeqCst);
    // Not `temp_dir()`: a long $TMPDIR would push the socket past sun_path's limit.
    let dir = PathBuf::from(format!("/tmp/pdt-{}-{n}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-pi");
    fs::write(&script, "#!/bin/sh\nenv > \"$(dirname \"$0\")/$RG_HOST_SESSION.env\"\nexec cat >/dev/null\n").unwrap();
    fs::set_permissions(&script, Permissions::from_mode(0o755)).unwrap();
    let socket = dir.join("s").join("host.sock");
    let notified = Arc::new(Mutex::new(vec![]));
    let sink = notified.clone();
    let hub = Hub::new(
        socket.to_string_lossy().into_owned(),
        vec![script.to_string_lossy().into_owned()],
        Box::new(move |p| {
            sink.lock().unwrap().push(p.title.clone());
            true
        }),
    );
    serve(hub.clone(), listen(&socket).unwrap());
    Fixture { hub, dir, socket, notified }
}

struct Client {
    r: BufReader<UnixStream>,
    w: UnixStream,
    n: u32,
}

impl Client {
    fn connect(f: &Fixture) -> Client {
        let w = UnixStream::connect(&f.socket).unwrap();
        w.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        Client { r: BufReader::new(w.try_clone().unwrap()), w, n: 0 }
    }
    fn send(&mut self, method: &str, params: Value) -> String {
        self.n += 1;
        let id = format!("r-{}", self.n);
        let frame = json!({"v": 1, "type": "request", "id": id, "method": method, "params": params});
        self.w.write_all(format!("{frame}\n").as_bytes()).unwrap();
        id
    }
    fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        (self.r.read_line(&mut line).ok()? > 0).then(|| serde_json::from_str(&line).unwrap())
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        let v = self.read().expect("response");
        assert_eq!(v["id"], json!(id));
        v
    }
    fn ok(&mut self, method: &str, params: Value) -> Value {
        let v = self.call(method, params);
        assert_eq!(v["ok"], json!(true), "{method}: {v}");
        v["result"].clone()
    }
    fn err(&mut self, method: &str, params: Value) -> String {
        let v = self.call(method, params);
        assert_eq!(v["ok"], json!(false), "{method}: {v}");
        v["error"]["code"].as_str().unwrap().to_string()
    }
    fn hello(f: &Fixture, id: &str) -> Client {
        let pid = f.hub.lock().tree.get(id).unwrap().pid.unwrap();
        let mut c = Client::connect(f);
        c.ok("hello", json!({"protocol": 1, "pid": pid, "hostSessionId": id, "cwd": "/"}));
        c
    }
}

fn ids(list: &Value) -> Vec<String> {
    list["sessions"].as_array().unwrap().iter().map(|s| s["hostSessionId"].as_str().unwrap().to_string()).collect()
}

fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn socket_is_private() {
    let f = fixture();
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&f.socket), 0o600);
    assert_eq!(mode(f.socket.parent().unwrap()), 0o700);
}

#[test]
fn handshake_is_required_and_bound_to_the_spawned_pid() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let pid = f.hub.lock().tree.get(&root).unwrap().pid.unwrap();

    let mut c = Client::connect(&f);
    assert_eq!(c.err("session.list", json!({})), "forbidden");
    assert_eq!(c.err("hello", json!({"protocol": 2, "pid": pid, "hostSessionId": root, "cwd": "/"})), "version-mismatch");
    assert_eq!(c.err("hello", json!({"protocol": 1, "pid": pid + 1, "hostSessionId": root, "cwd": "/"})), "forbidden");
    assert!(c.read().is_none(), "an impostor is disconnected");

    let mut c = Client::hello(&f, &root);
    assert_eq!(c.err("hello", json!({"protocol": 1, "pid": pid, "hostSessionId": root, "cwd": "/"})), "bad-request");
    assert_eq!(c.err("session.explode", json!({})), "unknown-method");
    assert_eq!(c.err("session.list", json!({"x": 1})), "bad-request");
    assert!(ids(&c.ok("session.list", json!({}))).contains(&root));
}

#[test]
fn broken_frames_drop_the_connection() {
    let f = fixture();
    let mut c = Client::connect(&f);
    c.w.write_all(b"this is not json\n").unwrap();
    assert!(c.read().is_none());
    let mut c = Client::connect(&f);
    c.w.write_all(&vec![b' '; MAX_FRAME_BYTES + 10]).unwrap();
    assert!(c.read().is_none());
}

#[test]
fn open_list_pin_decorate_close_lifecycle() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let mut c = Client::hello(&f, &root);
    let dir = f.dir.to_string_lossy().into_owned();

    let opened = c.ok(
        "session.open",
        json!({"argv": [f.dir.join("fake-pi")], "cwd": dir, "env": {"EXTRA": "yes"}, "title": "review", "role": "judge", "placement": "own-group"}),
    );
    let child = opened["hostSessionId"].as_str().unwrap().to_string();
    assert!(opened["pid"].as_u64().is_some());
    assert_eq!(
        c.err("session.open", json!({"argv": ["/nonexistent/pi"], "cwd": dir, "env": {}, "title": "t", "role": "worker", "placement": "own-group"})),
        "unavailable"
    );

    // Env injection (§2), read back from what the fake pi dumped.
    let env_file = f.dir.join(format!("{child}.env"));
    wait_for("the child's env dump", || fs::read_to_string(&env_file).is_ok_and(|s| s.contains("RG_HOST_SESSION")));
    let env = fs::read_to_string(&env_file).unwrap();
    assert!(env.contains("RG_HOST=desktop\n") && env.contains(&format!("RG_HOST_SESSION={child}\n")) && env.contains("EXTRA=yes\n"));
    assert!(env.contains(&format!("RG_HOST_SOCKET={}\n", f.socket.display())));

    let list = c.ok("session.list", json!({}));
    let entry = list["sessions"].as_array().unwrap().iter().find(|s| s["hostSessionId"] == json!(child)).unwrap().clone();
    assert_eq!((entry["parent"].clone(), entry["role"].clone(), entry["groupPin"].clone()), (json!(root), json!("judge"), json!(null)));
    c.ok("session.pin", json!({"reason": "orchestration-child"}));
    let list = c.ok("session.list", json!({}));
    assert!(list["sessions"].as_array().unwrap().iter().any(|s| s["hostSessionId"] == json!(child) && s["groupPin"] == json!("orchestration-child")));

    c.ok("session.decorate", json!({"hostSessionId": child, "label": "review@main", "state": "working"}));
    assert_eq!(f.hub.lock().tree.get(&child).unwrap().decoration.label.as_deref(), Some("review@main"));
    assert_eq!(c.err("session.decorate", json!({"hostSessionId": "s999-judge"})), "not-found");

    // The child may not touch its parent.
    let mut kid = Client::hello(&f, &child);
    assert_eq!(kid.err("session.close", json!({"target": "session", "hostSessionId": root})), "forbidden");
    assert_eq!(kid.err("session.decorate", json!({"hostSessionId": root, "label": "x"})), "forbidden");

    // Close is idempotent, and the process really ends (stdin EOF).
    let pid = f.hub.lock().tree.get(&child).unwrap().pid.unwrap();
    assert_eq!(c.ok("session.close", json!({"target": "session", "hostSessionId": child})), json!({"closed": [child]}));
    assert_eq!(c.ok("session.close", json!({"target": "session", "hostSessionId": child})), json!({"closed": []}));
    assert!(!ids(&c.ok("session.list", json!({}))).contains(&child));
    // SAFETY: probing an already-known pid with signal 0.
    wait_for("the child process to exit", || f.hub.lock().logs.get(&child).is_some_and(|l| l.iter().any(|x| x.starts_with("[exited"))));
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
}

#[test]
fn children_close_takes_the_own_group_only() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let mut c = Client::hello(&f, &root);
    let open = |c: &mut Client, placement: &str| {
        let r = c.ok(
            "session.open",
            json!({"argv": [f.dir.join("fake-pi")], "cwd": "/", "env": {}, "title": "t", "role": "worker", "placement": placement}),
        );
        r["hostSessionId"].as_str().unwrap().to_string()
    };
    let a = open(&mut c, "own-group");
    let b = open(&mut c, "own-group");
    let successor = open(&mut c, "beside-opener");
    let mut closed = c.ok("session.close", json!({"target": "children"}))["closed"].as_array().unwrap().clone();
    closed.sort_by_key(|v| v.to_string());
    assert_eq!(closed, vec![json!(a), json!(b)]);
    assert_eq!(ids(&c.ok("session.list", json!({}))), vec![root, successor]);
}

#[test]
fn dialogs_wait_for_an_answer_while_other_requests_flow() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let mut c = Client::hello(&f, &root);
    let dialog = |id: &str| {
        json!({"shape": "choice", "dialogId": id, "title": "t", "options": ["a", "b"], "declineRow": "✎", "back": false, "recommended": "a"})
    };

    // aborted by dialog.close, with another request answered in between
    let open_id = c.send("dialog.open", dialog("d1"));
    wait_for("the dialog to register", || f.hub.lock().dialogs.len() == 1);
    assert_eq!(c.err("dialog.open", dialog("d1")), "bad-request", "duplicate dialogId");
    assert_eq!(c.ok("focus.state", json!({})), json!({"focusedHostSessionId": null, "appFrontmost": false}));
    let close_id = c.send("dialog.close", json!({"dialogId": "d1"}));
    let (x, y) = (c.read().unwrap(), c.read().unwrap());
    let (open_resp, close_resp) = if x["id"] == json!(open_id) { (x, y) } else { (y, x) };
    assert_eq!(close_resp["id"], json!(close_id));
    assert_eq!(open_resp["result"], json!({"kind": "aborted"}));
    assert_eq!(c.ok("dialog.close", json!({"dialogId": "d1"})), json!({}), "idempotent");

    // answered by the window
    let open_id = c.send("dialog.open", dialog("d2"));
    wait_for("the dialog to register", || f.hub.lock().dialogs.len() == 1);
    f.hub.dialog_answer(&root, "d2", protocol::DialogOutcome::Picked { option: "b".into() });
    let v = c.read().unwrap();
    assert_eq!((v["id"].clone(), v["result"].clone()), (json!(open_id), json!({"kind": "picked", "option": "b"})));

    // a dropped connection settles its dialogs
    c.send("dialog.open", dialog("d3"));
    wait_for("the dialog to register", || f.hub.lock().dialogs.len() == 1);
    drop(c);
    wait_for("the dialog to be dropped", || f.hub.lock().dialogs.is_empty());
}

#[test]
fn focus_and_notify() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let mut c = Client::hello(&f, &root);
    assert_eq!(c.err("focus", json!({"hostSessionId": "s404-root"})), "not-found");
    c.ok("focus", json!({"hostSessionId": root}));
    assert!(f.hub.take_activate_request());
    f.hub.set_frontmost(true);
    assert_eq!(c.ok("focus.state", json!({})), json!({"focusedHostSessionId": root, "appFrontmost": true}));
    assert_eq!(
        c.ok("notify", json!({"kind": "finished", "title": "done", "body": "", "focusHostSessionId": root})),
        json!({"shown": true})
    );
    assert_eq!(*f.notified.lock().unwrap(), vec!["done".to_string()]);
}

#[test]
fn a_dead_process_leaves_the_list() {
    let f = fixture();
    let root = f.hub.open_root("/").unwrap();
    let pid = f.hub.lock().tree.get(&root).unwrap().pid.unwrap();
    // SAFETY: our own child's process group.
    unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
    wait_for("the exit to be observed", || !f.hub.list().iter().any(|e| e.host_session_id == root));
}
