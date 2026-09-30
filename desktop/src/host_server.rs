//! Host socket server (`docs/desktop/host-protocol.md` §3–§4, §6–§8): a 0600 unix
//! socket, one thread per connection, `hello` binds the connection to a session,
//! and every later request acts as that session. `dialog.open` answers
//! asynchronously so other requests keep flowing while a human thinks.

use crate::hub::Hub;
use crate::protocol::{self, Decoded, ErrorCode, MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, WireError};
use serde_json::Value;
use std::fs::{self, DirBuilder, Permissions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

/// A private (0700) directory for this app instance; `$TMPDIR` on macOS is already
/// per-user. Falls back to `/tmp` when the path would exceed the sun_path limit.
pub fn socket_path() -> PathBuf {
    let pid = std::process::id();
    let preferred = std::env::temp_dir().join(format!("pi-desktop-{pid}")).join("host.sock");
    if preferred.as_os_str().len() <= protocol::MAX_SOCKET_PATH_BYTES {
        return preferred;
    }
    // SAFETY: getuid never fails.
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/pi-desktop-{uid}-{pid}/host.sock"))
}

pub fn listen(path: &Path) -> io::Result<UnixListener> {
    let dir = path.parent().ok_or_else(|| io::Error::other("socket path has no directory"))?;
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    fs::set_permissions(dir, Permissions::from_mode(0o700))?;
    let _ = fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub fn remove_socket(path: &Path) {
    let _ = fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = fs::remove_dir(dir);
    }
}

pub fn serve(hub: Arc<Hub>, listener: UnixListener) {
    let conns = AtomicU64::new(0);
    std::thread::spawn(move || {
        for stream in listener.incoming().map_while(Result::ok) {
            let hub = hub.clone();
            let conn = conns.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                if same_uid(&stream) {
                    handle(&hub, stream, conn);
                }
                hub.drop_connection(conn);
            });
        }
    });
}

fn same_uid(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: valid fd and out-pointers for the duration of the call.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    // SAFETY: getuid never fails.
    rc == 0 && uid == unsafe { libc::getuid() }
}

/// One frame without its LF. `Ok(None)` = clean EOF; an over-long line is an error
/// (the connection is dropped: there is no id to answer).
pub fn read_frame(r: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    let n = r.by_ref().take(MAX_FRAME_BYTES as u64 + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        return Ok(Some(buf));
    }
    if buf.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame exceeds MAX_FRAME_BYTES"));
    }
    Ok(None)
}

enum Reply {
    Now(Result<Value, WireError>),
    Dialog(Receiver<protocol::DialogOutcome>),
    /// Answer, then drop the connection (identity mismatch in `hello`).
    Close(WireError),
}

fn handle(hub: &Hub, stream: UnixStream, conn: u64) {
    let Ok(write_half) = stream.try_clone() else { return };
    let writer = Arc::new(Mutex::new(write_half));
    let mut reader = BufReader::new(stream);
    let mut bound: Option<String> = None;
    while let Ok(Some(line)) = read_frame(&mut reader) {
        let (id, request) = match protocol::decode_request(&line) {
            Decoded::Request { id, request } => (id, request),
            Decoded::Reject(reason) => {
                eprintln!("host socket: dropping connection {conn}: {reason}");
                break;
            }
        };
        let reply = match request {
            Err(e) => Reply::Now(Err(e)),
            Ok(r) => dispatch(hub, &mut bound, conn, r),
        };
        match reply {
            Reply::Now(result) => send(&writer, &id, result),
            Reply::Close(e) => {
                send(&writer, &id, Err(e));
                break;
            }
            Reply::Dialog(rx) => {
                let writer = writer.clone();
                std::thread::spawn(move || {
                    let outcome = rx.recv().unwrap_or(protocol::DialogOutcome::Unavailable);
                    send(&writer, &id, Ok(protocol::dialog_result(&outcome)));
                });
            }
        }
    }
    if let Ok(w) = writer.lock() {
        let _ = w.shutdown(std::net::Shutdown::Both);
    }
}

fn send(writer: &Mutex<UnixStream>, id: &str, result: Result<Value, WireError>) {
    let frame = match result {
        Ok(v) => protocol::encode_ok(id, v),
        Err(e) => protocol::encode_err(id, &e),
    };
    if let Ok(mut w) = writer.lock() {
        let _ = w.write_all(frame.as_bytes());
    }
}

fn dispatch(hub: &Hub, bound: &mut Option<String>, conn: u64, req: Request) -> Reply {
    let Some(me) = bound.clone() else {
        let Request::Hello(h) = req else {
            return Reply::Now(Err(WireError::new(ErrorCode::Forbidden, "the first request must be `hello`")));
        };
        if h.protocol != PROTOCOL_VERSION {
            return Reply::Now(Err(WireError::new(ErrorCode::VersionMismatch, format!("client speaks v{PROTOCOL_VERSION}"))));
        }
        if !hub.owns(&h.host_session_id, h.pid) {
            return Reply::Close(WireError::new(ErrorCode::Forbidden, "hostSessionId was not issued to this pid"));
        }
        *bound = Some(h.host_session_id);
        return Reply::Now(Ok(protocol::hello_result()));
    };
    let ok = |v: Value| Reply::Now(Ok(v));
    match req {
        Request::Hello(_) => Reply::Now(Err(WireError::bad("already said hello"))),
        Request::SessionOpen(p) => {
            Reply::Now(hub.open_child(&me, &p).map(|(id, pid)| protocol::open_result(&id, Some(pid))))
        }
        Request::SessionList => ok(protocol::list_result(&hub.list())),
        Request::SessionPin(p) => {
            hub.pin(&me, &p.reason);
            ok(protocol::empty_result())
        }
        Request::SessionClose(p) => Reply::Now(hub.close(&me, &p).map(|c| protocol::closed_result(&c))),
        Request::SessionDecorate(p) => Reply::Now(hub.decorate(&me, &p).map(|_| protocol::empty_result())),
        Request::Focus(p) => Reply::Now(hub.focus(&p.host_session_id).map(|_| protocol::empty_result())),
        Request::FocusState => {
            let (focused, front) = hub.focus_state();
            ok(protocol::focus_state_result(focused.as_deref(), front))
        }
        Request::Notify(p) => ok(protocol::notify_result(hub.notify(&p))),
        Request::DialogOpen(p) => match hub.dialog_open(&me, conn, p) {
            Ok(rx) => Reply::Dialog(rx),
            Err(e) => Reply::Now(Err(e)),
        },
        Request::DialogClose(p) => {
            hub.dialog_close(&me, &p.dialog_id);
            ok(protocol::empty_result())
        }
    }
}

#[cfg(test)]
#[path = "host_server_tests.rs"]
mod tests;
