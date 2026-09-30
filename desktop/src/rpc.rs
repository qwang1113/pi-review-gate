//! pi RPC client (`pi --mode rpc`): stdout JSONL parsing, stdin commands, and the
//! child process itself. Protocol: `@earendil-works/pi-coding-agent/docs/rpc*.md`, `json.md`.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Dialog methods block pi until answered; the rest are fire-and-forget.
#[derive(Debug, Clone, PartialEq)]
pub enum UiRequest {
    Select { title: String, options: Vec<String>, timeout: Option<u64> },
    Confirm { title: String, message: String, timeout: Option<u64> },
    Input { title: String, placeholder: Option<String> },
    Editor { title: String, prefill: Option<String> },
    Notify { message: String, notify_type: String },
    SetStatus { key: String, text: Option<String> },
    SetWidget { key: String, lines: Option<Vec<String>>, placement: String },
    SetTitle { title: String },
    SetEditorText { text: String },
    /// A method this client does not know yet — shown raw, never answered.
    Other { method: String },
}

impl UiRequest {
    pub fn is_dialog(&self) -> bool {
        matches!(self, Self::Select { .. } | Self::Confirm { .. } | Self::Input { .. } | Self::Editor { .. })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Record {
    Response { id: Option<String>, command: String, success: bool, error: Option<String>, data: Option<Value> },
    UiRequest { id: String, request: UiRequest },
    /// A session event (`agent_start`, `message_update`, …). Kept as its type plus the
    /// raw record: `json.md` grows event types, and an unknown one must not be fatal.
    Event { kind: String, raw: Value },
}

pub fn parse_record(line: &[u8]) -> Result<Record, String> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let v: Value = serde_json::from_slice(line).map_err(|e| format!("not JSON: {e}"))?;
    let kind = v.get("type").and_then(Value::as_str).ok_or("record has no `type`")?.to_string();
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let t = |k: &str| s(k).unwrap_or_default();
    match kind.as_str() {
        "response" => Ok(Record::Response {
            id: s("id"),
            command: t("command"),
            success: v.get("success").and_then(Value::as_bool).ok_or("response has no `success`")?,
            error: s("error"),
            data: v.get("data").cloned(),
        }),
        "extension_ui_request" => {
            let id = s("id").ok_or("extension_ui_request has no `id`")?;
            let method = s("method").ok_or("extension_ui_request has no `method`")?;
            let timeout = v.get("timeout").and_then(Value::as_u64);
            let strings = |k: &str| {
                v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            };
            let request = match method.as_str() {
                "select" => UiRequest::Select { title: t("title"), options: strings("options").unwrap_or_default(), timeout },
                "confirm" => UiRequest::Confirm { title: t("title"), message: t("message"), timeout },
                "input" => UiRequest::Input { title: t("title"), placeholder: s("placeholder") },
                "editor" => UiRequest::Editor { title: t("title"), prefill: s("prefill") },
                "notify" => UiRequest::Notify { message: t("message"), notify_type: s("notifyType").unwrap_or("info".into()) },
                "setStatus" => UiRequest::SetStatus { key: t("statusKey"), text: s("statusText") },
                "setWidget" => UiRequest::SetWidget {
                    key: t("widgetKey"),
                    lines: strings("widgetLines"),
                    placement: s("widgetPlacement").unwrap_or("aboveEditor".into()),
                },
                "setTitle" => UiRequest::SetTitle { title: t("title") },
                "set_editor_text" => UiRequest::SetEditorText { text: t("text") },
                _ => UiRequest::Other { method },
            };
            Ok(Record::UiRequest { id, request })
        }
        _ => Ok(Record::Event { kind, raw: v }),
    }
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // `Confirmed` answers pi's `confirm`, rendered by t5
pub enum UiAnswer {
    Value(String),
    Confirmed(bool),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RpcCommand {
    Prompt { id: String, message: String, streaming_behavior: Option<&'static str> },
    Abort { id: String },
    UiResponse { id: String, answer: UiAnswer },
}

pub fn encode_command(cmd: &RpcCommand) -> String {
    let mut v = match cmd {
        RpcCommand::Prompt { id, message, streaming_behavior } => {
            let mut v = json!({"id": id, "type": "prompt", "message": message});
            if let Some(b) = streaming_behavior {
                v["streamingBehavior"] = json!(b);
            }
            v
        }
        RpcCommand::Abort { id } => json!({"id": id, "type": "abort"}),
        RpcCommand::UiResponse { id, answer } => {
            let mut v = json!({"type": "extension_ui_response", "id": id});
            match answer {
                UiAnswer::Value(s) => v["value"] = json!(s),
                UiAnswer::Confirmed(b) => v["confirmed"] = json!(b),
                UiAnswer::Cancelled => v["cancelled"] = json!(true),
            }
            v
        }
    }
    .to_string();
    v.push('\n');
    v
}

/// Everything a process reports, delivered on its reader threads.
#[derive(Debug)]
pub enum Output {
    /// A parsed record plus the line it came from (the raw event view shows the line).
    Record(Record, String),
    Unparsed { line: String, error: String },
    Stderr(String),
    Exited(Option<i32>),
}

/// The client's `--mode rpc` rule for argv it did not build: insert it after
/// argv[0] unless the caller already chose a mode; never rewrite anything else.
pub fn rpc_argv(argv: &[String]) -> Vec<String> {
    let mut out = argv.to_vec();
    if !argv.iter().any(|a| a == "--mode" || a.starts_with("--mode=")) {
        out.splice(1..1, ["--mode".to_string(), "rpc".to_string()]);
    }
    out
}

pub struct Process {
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    alive: Arc<AtomicBool>,
}

impl Process {
    /// Execs `argv` directly (no shell) in its own process group, so closing it can
    /// reap the tools pi started too. `on_output` runs on the reader threads.
    pub fn spawn(
        argv: &[String],
        cwd: &str,
        env: &BTreeMap<String, String>,
        on_output: impl Fn(Output) + Send + Sync + 'static,
    ) -> io::Result<Arc<Process>> {
        let (prog, args) = argv.split_first().ok_or_else(|| io::Error::other("empty argv"))?;
        let mut child = Command::new(prog)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()?;
        let on_output = Arc::new(on_output);
        let alive = Arc::new(AtomicBool::new(true));
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let proc = Arc::new(Process { pid: child.id(), stdin: Mutex::new(child.stdin.take()), alive: alive.clone() });

        let err_out = on_output.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                err_out(Output::Stderr(String::from_utf8_lossy(&line).into_owned()));
            }
        });
        std::thread::spawn(move || {
            read_records(stdout, |o| on_output(o));
            let code = child.wait().ok().and_then(|s| s.code());
            alive.store(false, Ordering::SeqCst);
            on_output(Output::Exited(code));
        });
        Ok(proc)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn send(&self, cmd: &RpcCommand) -> io::Result<()> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))?;
        stdin.write_all(encode_command(cmd).as_bytes())?;
        stdin.flush()
    }

    /// Orderly shutdown request (`rpc.md` §Shutdown): EOF on stdin.
    pub fn close_stdin(&self) {
        self.stdin.lock().unwrap().take();
    }

    pub fn kill_group(&self, signal: i32) {
        if self.is_alive() {
            // SAFETY: plain syscall; the pid is our own un-reaped child (alive flag).
            unsafe { libc::killpg(self.pid as i32, signal) };
        }
    }

    /// Close stdin, then escalate if pi is still there after `grace` (non-blocking).
    pub fn shutdown(self: &Arc<Self>, grace: Duration) {
        self.close_stdin();
        let me = self.clone();
        std::thread::spawn(move || {
            if !me.wait_exit(grace) {
                me.kill_group(libc::SIGTERM);
                if !me.wait_exit(Duration::from_secs(1)) {
                    me.kill_group(libc::SIGKILL);
                }
            }
        });
    }

    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        while self.is_alive() {
            if Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        true
    }
}

/// Splits on LF only (`rpc.md` §Framing: U+2028/U+2029 are not boundaries).
pub fn read_records(stream: impl Read, mut sink: impl FnMut(Output)) {
    for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(&line).into_owned();
        sink(match parse_record(&line) {
            Ok(r) => Output::Record(r, text),
            Err(error) => Output::Unparsed { line: text, error },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_responses_events_and_ui_requests() {
        let r = parse_record(br#"{"id":"req-1","type":"response","command":"prompt","success":true}"#).unwrap();
        assert!(matches!(r, Record::Response { ref id, success: true, .. } if id.as_deref() == Some("req-1")));
        let r = parse_record(br#"{"type":"response","command":"parse","success":false,"error":"bad"}"#).unwrap();
        assert!(matches!(r, Record::Response { id: None, success: false, ref error, .. } if error.as_deref() == Some("bad")));

        let r = parse_record(br#"{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hi"}}"#).unwrap();
        let Record::Event { kind, raw } = r else { panic!() };
        assert_eq!((kind.as_str(), &raw["assistantMessageEvent"]["delta"]), ("message_update", &json!("Hi")));
        let Record::Event { kind, .. } = parse_record(b"{\"type\":\"agent_settled\"}\r").unwrap() else { panic!() };
        assert_eq!(kind, "agent_settled");
        assert!(matches!(parse_record(br#"{"type":"brand_new_event","x":1}"#).unwrap(), Record::Event { .. }));

        let r = parse_record(br#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Allow?","options":["Allow","Block"],"timeout":10000}"#).unwrap();
        assert_eq!(
            r,
            Record::UiRequest {
                id: "u1".into(),
                request: UiRequest::Select { title: "Allow?".into(), options: vec!["Allow".into(), "Block".into()], timeout: Some(10000) }
            }
        );
        let Record::UiRequest { request, .. } =
            parse_record(br#"{"type":"extension_ui_request","id":"u7","method":"setWidget","widgetKey":"k","widgetLines":["a"]}"#).unwrap()
        else {
            panic!()
        };
        assert_eq!(request, UiRequest::SetWidget { key: "k".into(), lines: Some(vec!["a".into()]), placement: "aboveEditor".into() });
        assert!(!request.is_dialog());
        let Record::UiRequest { request, .. } =
            parse_record(br#"{"type":"extension_ui_request","id":"u6","method":"setStatus","statusKey":"k"}"#).unwrap()
        else {
            panic!()
        };
        assert_eq!(request, UiRequest::SetStatus { key: "k".into(), text: None });
        let Record::UiRequest { request, .. } =
            parse_record(br#"{"type":"extension_ui_request","id":"u9","method":"teleport"}"#).unwrap()
        else {
            panic!()
        };
        assert_eq!(request, UiRequest::Other { method: "teleport".into() });
    }

    #[test]
    fn malformed_records_are_errors_not_panics() {
        for line in [&b"nope"[..], b"{}", b"[]", br#"{"type":"response"}"#, br#"{"type":"extension_ui_request","method":"select"}"#] {
            assert!(parse_record(line).is_err(), "{}", String::from_utf8_lossy(line));
        }
    }

    #[test]
    fn splits_only_on_lf() {
        let stream = "{\"type\":\"a\",\"s\":\"x\u{2028}y\"}\n\n{\"type\":\"b\"}\r\nbroken\n";
        let mut out = vec![];
        read_records(stream.as_bytes(), |o| out.push(o));
        assert_eq!(out.len(), 3);
        assert!(matches!(&out[0], Output::Record(Record::Event { raw, .. }, _) if raw["s"] == "x\u{2028}y"));
        assert!(matches!(&out[1], Output::Record(Record::Event { kind, .. }, _) if kind == "b"));
        assert!(matches!(&out[2], Output::Unparsed { .. }));
    }

    #[test]
    fn encodes_commands() {
        let p = RpcCommand::Prompt { id: "p1".into(), message: "hi".into(), streaming_behavior: Some("steer") };
        let line = encode_command(&p);
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v, json!({"id": "p1", "type": "prompt", "message": "hi", "streamingBehavior": "steer"}));
        let v: Value = serde_json::from_str(&encode_command(&RpcCommand::Abort { id: "a".into() })).unwrap();
        assert_eq!(v, json!({"id": "a", "type": "abort"}));
        for (answer, expect) in [
            (UiAnswer::Value("Allow".into()), json!({"type": "extension_ui_response", "id": "u1", "value": "Allow"})),
            (UiAnswer::Confirmed(false), json!({"type": "extension_ui_response", "id": "u1", "confirmed": false})),
            (UiAnswer::Cancelled, json!({"type": "extension_ui_response", "id": "u1", "cancelled": true})),
        ] {
            let v: Value = serde_json::from_str(&encode_command(&RpcCommand::UiResponse { id: "u1".into(), answer })).unwrap();
            assert_eq!(v, expect);
        }
    }

    #[test]
    fn rpc_argv_inserts_mode_once() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(rpc_argv(&a(&["pi", "--session-id", "x"])), a(&["pi", "--mode", "rpc", "--session-id", "x"]));
        assert_eq!(rpc_argv(&a(&["pi", "--mode", "rpc"])), a(&["pi", "--mode", "rpc"]));
        assert_eq!(rpc_argv(&a(&["pi", "--mode=json"])), a(&["pi", "--mode=json"]));
    }

    /// Needs a real `pi` on PATH: `cargo test -- --ignored real_pi`.
    #[test]
    #[ignore]
    fn real_pi_answers_over_rpc() {
        let (tx, rx) = std::sync::mpsc::channel();
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let argv = rpc_argv(&["pi".to_string(), "--no-session".to_string()]);
        let p = Process::spawn(&argv, "/tmp", &env, move |o| drop(tx.send(o))).unwrap();
        p.send(&RpcCommand::Abort { id: "a1".into() }).unwrap();
        let end = Instant::now() + Duration::from_secs(60);
        loop {
            let o = rx.recv_timeout(end.saturating_duration_since(Instant::now())).expect("a response from pi");
            if let Output::Record(Record::Response { id, command, success, .. }, _) = o {
                assert_eq!((id.as_deref(), command.as_str(), success), (Some("a1"), "abort", true));
                break;
            }
        }
        p.shutdown(Duration::from_secs(5));
        assert!(p.wait_exit(Duration::from_secs(10)), "pi exits on stdin EOF");
    }

    #[test]
    fn process_exit_is_observed_and_stdin_eof_ends_it() {
        let (tx, rx) = std::sync::mpsc::channel();
        let env = BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        let argv = ["/bin/sh", "-c", "echo '{\"type\":\"agent_start\"}'; cat >/dev/null"].map(String::from);
        let p = Process::spawn(&argv, "/", &env, move |o| tx.send(format!("{o:?}")).unwrap()).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().contains("agent_start"));
        assert!(p.is_alive());
        p.shutdown(Duration::from_secs(5));
        assert!(p.wait_exit(Duration::from_secs(5)));
        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().starts_with("Exited"));
    }
}
