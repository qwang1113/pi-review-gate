//! Host protocol v1 wire types (`docs/desktop/host-protocol.md`).
//!
//! The field table lives in `lib/desktop-host-protocol.ts`; its generated form is
//! `desktop/protocol/host-protocol.schema.json`, and `tests` below read that file so a
//! drift between the two sides fails `cargo test`. Every object is closed
//! (`deny_unknown_fields`); bounds serde cannot express are checked in `validate`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const ENV_HOST: &str = "RG_HOST";
pub const ENV_SOCKET: &str = "RG_HOST_SOCKET";
pub const ENV_SESSION: &str = "RG_HOST_SESSION";
/// `x-inheritedGateEnv`: `RG_` keys that survive the child-env scrub (§2).
pub const INHERITED_GATE_ENV: &[&str] = &["RG_NO_SIDE_EFFECTS"];
pub const MAX_SOCKET_PATH_BYTES: usize = 103;
/// `dialog.open` options / defaultChecked / `checked` size guard (TS `DIALOG_MAX_OPTIONS`).
pub const MAX_DIALOG_OPTIONS: usize = 16;

#[cfg(test)]
pub const METHODS: &[&str] = &[
    "hello",
    "session.open",
    "session.list",
    "session.pin",
    "session.close",
    "session.decorate",
    "focus",
    "focus.state",
    "notify",
    "dialog.open",
    "dialog.close",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // `Internal` is part of the wire vocabulary; nothing fails that way yet
pub enum ErrorCode {
    BadRequest,
    UnknownMethod,
    VersionMismatch,
    NotFound,
    Forbidden,
    Unavailable,
    Internal,
}

impl ErrorCode {
    #[cfg(test)]
    pub const ALL: [ErrorCode; 7] = [
        Self::BadRequest,
        Self::UnknownMethod,
        Self::VersionMismatch,
        Self::NotFound,
        Self::Forbidden,
        Self::Unavailable,
        Self::Internal,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad-request",
            Self::UnknownMethod => "unknown-method",
            Self::VersionMismatch => "version-mismatch",
            Self::NotFound => "not-found",
            Self::Forbidden => "forbidden",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
}

impl WireError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }
}

// ---------------------------------------------------------------- params

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol: u64,
    pub pid: u32,
    pub host_session_id: String,
    pub pi_session_id: Option<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Root,
    Judge,
    Worker,
    OrchestrationChild,
    Successor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Placement {
    OwnGroup,
    BesideOpener,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenParams {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub title: String,
    pub role: Role,
    pub placement: Placement,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinParams {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "target", rename_all = "lowercase", deny_unknown_fields)]
pub enum CloseParams {
    #[serde(rename_all = "camelCase")]
    Session { host_session_id: String },
    Children {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PaneState {
    Working,
    WaitingInput,
    WaitingJudge,
    Done,
    Idle,
    ModeChanged,
    Dead,
    Stalled,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DecorateParams {
    pub host_session_id: String,
    pub label: Option<String>,
    pub color_seed: Option<String>,
    pub state: Option<PaneState>,
    pub state_at: Option<u64>,
    pub kind: Option<String>,
    pub repo: Option<String>,
    pub pi_session_id: Option<String>,
    /// absent = leave alone, `null` = clear, string = set.
    #[serde(default, deserialize_with = "present")]
    pub session_name: Option<Option<String>>,
}

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FocusParams {
    pub host_session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotifyKind {
    Finished,
    Failed,
    NeedsUser,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotifyParams {
    #[allow(dead_code)] // closed wire shape; the banner does not vary by kind
    pub kind: NotifyKind,
    pub title: String,
    pub body: String,
    pub group: Option<String>,
    pub focus_host_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase", deny_unknown_fields)]
pub enum DialogParams {
    #[serde(rename_all = "camelCase")]
    Choice {
        dialog_id: String,
        title: String,
        body: Option<String>,
        options: Vec<String>,
        decline_row: String,
        back: bool,
        recommended: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Multi {
        dialog_id: String,
        title: String,
        body: Option<String>,
        options: Vec<String>,
        decline_row: String,
        back: bool,
        default_checked: Vec<String>,
    },
}

impl DialogParams {
    pub fn dialog_id(&self) -> &str {
        match self {
            Self::Choice { dialog_id, .. } | Self::Multi { dialog_id, .. } => dialog_id,
        }
    }
    pub fn title(&self) -> &str {
        match self {
            Self::Choice { title, .. } | Self::Multi { title, .. } => title,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DialogCloseParams {
    pub dialog_id: String,
}

#[derive(Debug, Clone)]
pub enum Request {
    Hello(HelloParams),
    SessionOpen(OpenParams),
    SessionList,
    SessionPin(PinParams),
    SessionClose(CloseParams),
    SessionDecorate(DecorateParams),
    Focus(FocusParams),
    FocusState,
    Notify(NotifyParams),
    DialogOpen(DialogParams),
    DialogClose(DialogCloseParams),
}

// ---------------------------------------------------------------- results

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub host_session_id: String,
    pub parent: Option<String>,
    pub role: Role,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub group_pin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[allow(dead_code)] // checked/decline/back come from t5's dialog renderer
pub enum DialogOutcome {
    Picked { option: String },
    Checked { options: Vec<String> },
    Decline { reason: String },
    Back,
    Dismissed,
    Aborted,
    Unavailable,
}

pub fn hello_result() -> Value {
    json!({"protocol": PROTOCOL_VERSION, "client": {"name": "pi-desktop", "version": env!("CARGO_PKG_VERSION")}})
}

pub fn open_result(id: &str, pid: Option<u32>) -> Value {
    let mut m = Map::new();
    m.insert("hostSessionId".into(), json!(id));
    if let Some(pid) = pid {
        m.insert("pid".into(), json!(pid));
    }
    Value::Object(m)
}

pub fn list_result(sessions: &[ListEntry]) -> Value {
    json!({ "sessions": sessions })
}

pub fn closed_result(closed: &[String]) -> Value {
    json!({ "closed": closed })
}

pub fn focus_state_result(focused: Option<&str>, frontmost: bool) -> Value {
    json!({ "focusedHostSessionId": focused, "appFrontmost": frontmost })
}

pub fn notify_result(shown: bool) -> Value {
    json!({ "shown": shown })
}

pub fn empty_result() -> Value {
    json!({})
}

pub fn dialog_result(outcome: &DialogOutcome) -> Value {
    serde_json::to_value(outcome).expect("outcome serializes")
}

// ---------------------------------------------------------------- frames

/// What a request line decodes to. `Reject` is a line whose envelope is too
/// broken to carry an id back — the connection is dropped (no response is possible).
#[derive(Debug)]
pub enum Decoded {
    Request { id: String, request: Result<Request, WireError> },
    Reject(String),
}

pub fn decode_request(line: &[u8]) -> Decoded {
    let value: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(e) => return Decoded::Reject(format!("not JSON: {e}")),
    };
    let Value::Object(mut obj) = value else {
        return Decoded::Reject("frame is not an object".into());
    };
    let id = match obj.get("id").and_then(Value::as_str) {
        Some(id) if is_id(id) => id.to_string(),
        _ => return Decoded::Reject("frame has no valid id".into()),
    };
    let request = decode_envelope(&mut obj);
    Decoded::Request { id, request }
}

fn decode_envelope(obj: &mut Map<String, Value>) -> Result<Request, WireError> {
    if let Some(k) = obj.keys().find(|k| !["v", "type", "id", "method", "params"].contains(&k.as_str())) {
        return Err(WireError::bad(format!("unknown envelope field `{k}`")));
    }
    if obj.get("v") != Some(&json!(PROTOCOL_VERSION)) {
        return Err(WireError::bad("envelope v must be 1"));
    }
    if obj.get("type") != Some(&json!("request")) {
        return Err(WireError::bad("envelope type must be `request`"));
    }
    let method = obj
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| WireError::bad("envelope method must be a string"))?
        .to_string();
    let params = obj.remove("params").ok_or_else(|| WireError::bad("envelope params missing"))?;
    decode_params(&method, params)
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, WireError> {
    serde_json::from_value(params).map_err(|e| WireError::bad(e.to_string()))
}

pub fn decode_params(method: &str, params: Value) -> Result<Request, WireError> {
    let req = match method {
        "hello" => Request::Hello(parse(params)?),
        "session.open" => Request::SessionOpen(parse(params)?),
        "session.list" => parse::<EmptyParams>(params).map(|_| Request::SessionList)?,
        "session.pin" => Request::SessionPin(parse(params)?),
        "session.close" => Request::SessionClose(parse(params)?),
        "session.decorate" => Request::SessionDecorate(parse(params)?),
        "focus" => Request::Focus(parse(params)?),
        "focus.state" => parse::<EmptyParams>(params).map(|_| Request::FocusState)?,
        "notify" => Request::Notify(parse(params)?),
        "dialog.open" => Request::DialogOpen(parse(params)?),
        "dialog.close" => Request::DialogClose(parse(params)?),
        other => return Err(WireError::new(ErrorCode::UnknownMethod, format!("unknown method `{other}`"))),
    };
    validate(&req)?;
    Ok(req)
}

pub fn encode_ok(id: &str, result: Value) -> String {
    let mut s = json!({"v": PROTOCOL_VERSION, "type": "response", "id": id, "ok": true, "result": result}).to_string();
    s.push('\n');
    s
}

pub fn encode_err(id: &str, err: &WireError) -> String {
    let message: String = err.message.chars().take(2000).collect();
    let mut s = json!({"v": PROTOCOL_VERSION, "type": "response", "id": id, "ok": false,
        "error": {"code": err.code.as_str(), "message": message}})
    .to_string();
    s.push('\n');
    s
}

// ---------------------------------------------------------------- validation

pub fn is_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn check_id(field: &str, s: &str) -> Result<(), WireError> {
    if is_id(s) { Ok(()) } else { Err(WireError::bad(format!("`{field}` is not a valid id"))) }
}

fn check_len(field: &str, s: &str, min: usize, max: usize) -> Result<(), WireError> {
    let n = s.chars().count();
    if (min..=max).contains(&n) {
        Ok(())
    } else {
        Err(WireError::bad(format!("`{field}` length {n} outside {min}..={max}")))
    }
}

fn check_abs(field: &str, s: &str) -> Result<(), WireError> {
    check_len(field, s, 1, 4096)?;
    if s.starts_with('/') { Ok(()) } else { Err(WireError::bad(format!("`{field}` must be absolute"))) }
}

fn check_opt(field: &str, s: &Option<String>, min: usize, max: usize) -> Result<(), WireError> {
    s.as_deref().map_or(Ok(()), |s| check_len(field, s, min, max))
}

fn check_options(field: &str, items: &[String], min: usize) -> Result<(), WireError> {
    if !(min..=MAX_DIALOG_OPTIONS).contains(&items.len()) {
        return Err(WireError::bad(format!("`{field}` must hold {min}..={MAX_DIALOG_OPTIONS} items")));
    }
    items.iter().try_for_each(|o| check_len(field, o, 1, 4096))
}

fn is_env_name(k: &str) -> bool {
    let mut b = k.bytes();
    matches!(b.next(), Some(c) if c.is_ascii_alphabetic() || c == b'_') && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

fn validate(req: &Request) -> Result<(), WireError> {
    match req {
        Request::Hello(p) => {
            if p.protocol < 1 || p.pid < 1 {
                return Err(WireError::bad("`protocol` and `pid` must be >= 1"));
            }
            check_id("hostSessionId", &p.host_session_id)?;
            check_opt("piSessionId", &p.pi_session_id, 1, 128)?;
            check_abs("cwd", &p.cwd)
        }
        Request::SessionOpen(p) => {
            if !(1..=512).contains(&p.argv.len()) {
                return Err(WireError::bad("`argv` must hold 1..=512 items"));
            }
            p.argv.iter().try_for_each(|a| check_len("argv[]", a, 1, 65536))?;
            check_abs("cwd", &p.cwd)?;
            check_len("title", &p.title, 1, 200)?;
            if p.role == Role::Root {
                return Err(WireError::bad("`role` root is the user's own session; prg cannot open one"));
            }
            if p.env.len() > 256 {
                return Err(WireError::bad("`env` holds more than 256 entries"));
            }
            for (k, v) in &p.env {
                if !is_env_name(k) {
                    return Err(WireError::bad(format!("`env` key `{k}` is not a variable name")));
                }
                if [ENV_HOST, ENV_SOCKET, ENV_SESSION].contains(&k.as_str()) {
                    return Err(WireError::bad(format!("`env` may not set `{k}`: only the client writes it")));
                }
                check_len("env value", v, 0, 65536)?;
            }
            Ok(())
        }
        Request::SessionPin(p) => check_len("reason", &p.reason, 1, 200),
        Request::SessionClose(CloseParams::Session { host_session_id }) => check_id("hostSessionId", host_session_id),
        Request::SessionDecorate(p) => {
            check_id("hostSessionId", &p.host_session_id)?;
            check_opt("label", &p.label, 0, 200)?;
            check_opt("colorSeed", &p.color_seed, 1, 128)?;
            check_opt("kind", &p.kind, 1, 32)?;
            if let Some(repo) = &p.repo {
                check_abs("repo", repo)?;
            }
            check_opt("piSessionId", &p.pi_session_id, 1, 128)?;
            check_opt("sessionName", &p.session_name.clone().flatten(), 2, 32)
        }
        Request::Focus(p) => check_id("hostSessionId", &p.host_session_id),
        Request::Notify(p) => {
            check_len("title", &p.title, 1, 80)?;
            check_len("body", &p.body, 0, 300)?;
            check_opt("group", &p.group, 1, 128)?;
            p.focus_host_session_id.as_deref().map_or(Ok(()), |id| check_id("focusHostSessionId", id))
        }
        Request::DialogOpen(p) => {
            check_id("dialogId", p.dialog_id())?;
            let (title, body, options, decline) = match p {
                DialogParams::Choice { title, body, options, decline_row, recommended, .. } => {
                    check_opt("recommended", recommended, 1, 4096)?;
                    (title, body, options, decline_row)
                }
                DialogParams::Multi { title, body, options, decline_row, default_checked, .. } => {
                    check_options("defaultChecked", default_checked, 0)?;
                    (title, body, options, decline_row)
                }
            };
            check_len("title", title, 1, 65536)?;
            check_opt("body", body, 0, 262144)?;
            check_options("options", options, 2)?;
            check_len("declineRow", decline, 1, 200)
        }
        Request::DialogClose(p) => check_id("dialogId", &p.dialog_id),
        Request::SessionList | Request::FocusState | Request::SessionClose(CloseParams::Children {}) => Ok(()),
    }
}

/// §2: the child's env = client env minus every `RG_` key (bar `x-inheritedGateEnv`),
/// overlaid with `session.open.params.env`, then the client's own three `RG_HOST*`.
pub fn child_env(
    client_env: impl IntoIterator<Item = (String, String)>,
    requested: &BTreeMap<String, String>,
    socket: &str,
    host_session_id: &str,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = client_env
        .into_iter()
        .filter(|(k, _)| !k.starts_with("RG_") || INHERITED_GATE_ENV.contains(&k.as_str()))
        .collect();
    env.extend(requested.iter().map(|(k, v)| (k.clone(), v.clone())));
    env.insert(ENV_HOST.into(), "desktop".into());
    env.insert(ENV_SOCKET.into(), socket.into());
    env.insert(ENV_SESSION.into(), host_session_id.into());
    env
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
