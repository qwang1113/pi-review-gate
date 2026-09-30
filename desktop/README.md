# pi-desktop

macOS host for pi sessions: starts `pi --mode rpc` processes, shows their raw
event streams, and serves prg's host socket (`docs/desktop/host-protocol.md`).

```sh
cargo build && cargo test           # unit + socket end-to-end tests (fake pi)
cargo test -- --ignored real_pi     # one round-trip against the real `pi` on PATH
cargo run -- /path/to/repo          # window + one root session in that repo
scripts/bundle.sh                   # .app wrapper: needed for native notifications
```

`PI_DESKTOP_PI` overrides the pi executable (default `pi` on `PATH`).

## Modules

| File | Owns |
| --- | --- |
| `src/protocol.rs` | host protocol v1 wire types, decoding + bounds, response encoding, child env rule (§2) |
| `src/sessions.rs` | session tree: parents, liveness, group pins, write authorization (pure) |
| `src/rpc.rs` | pi RPC: stdout record parsing, stdin commands, the child process (own process group) |
| `src/hub.rs` | shared state the socket and the window act through: processes, logs, dialogs, focus |
| `src/host_server.rs` | 0600 unix socket, peer-uid check, `hello` binding, per-method dispatch |
| `src/notify.rs` | `UNUserNotificationCenter`; click ⇒ `focus` |
| `src/app.rs` | the minimal window (t5 replaces the visuals) |

## GPUI dependency

`gpui-kit = "=0.7.0"` (longbridge). It pins the GPUI release it was built
against (`gpui-pre =0.3.7`) and bundles gpui-component, so one exact version
fixes the whole UI stack; crates.io `gpui 0.2.2` has no text input, which the
prompt line (and t5's dialogs: multi-line reason editor, checklists) need.
gpui-component already ships Input/Textarea, List, Scroll and Dialog, so t5
builds on those instead of hand-rolling editors.

## Client-side decisions the protocol left to t4

- `--mode rpc` is inserted right after `argv[0]` unless the argv already has `--mode`; nothing else is rewritten.
- `session.close`: the target leaves `session.list` at once; the process gets stdin EOF, SIGTERM to its process group after 3 s, SIGKILL 1 s later. App quit does the same for every session (EOF, 3 s, SIGKILL).
- `session.close` on an id this client never issued is treated like "already gone": `ok`, `closed: []`.
- `dialog.open` with a `dialogId` already pending for the same session ⇒ `bad-request`.
- `focus.state.focusedHostSessionId` is the session selected in the window, reported even when the app is in the background (prg combines it with `appFrontmost`).
- A bad frame (not JSON, not an object, `v` ≠ 1, over 1 MiB) or one without a usable `id` drops the connection — there is nothing to answer in this protocol version.

## Gaps for the project manager

- `hello` checks the pid the client spawned. A launcher that forks instead of exec'ing (e.g. `npx pi`) reports a different pid and is refused; prg's `session.open` argv must exec pi directly.
- pi-native `extension_ui_request` dialogs (`select`/`confirm`/`input`/`editor`) without a `timeout` block pi until answered; the window only has a bare fallback until t5 renders them.
- Notifications need the `.app` bundle (`scripts/bundle.sh`); a bare `cargo run` answers `notify` with `shown:false`.
