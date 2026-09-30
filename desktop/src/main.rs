//! pi-desktop: a macOS host for pi sessions. `pi-desktop [cwd]` opens a window and
//! starts one root `pi --mode rpc` session in `cwd` (default: the current dir).
//! `PI_DESKTOP_PI` overrides the pi executable (default `pi` on `PATH`).

mod app;
mod host_server;
mod hub;
mod notify;
mod protocol;
mod rpc;
mod sessions;

use gpui_kit::*;
use std::path::PathBuf;

fn main() {
    let cwd = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("current dir"));
    let cwd = cwd.canonicalize().expect("cwd must exist").to_string_lossy().into_owned();
    let socket = host_server::socket_path();
    let listener = host_server::listen(&socket).unwrap_or_else(|e| panic!("cannot listen on {}: {e}", socket.display()));
    let pi = std::env::var("PI_DESKTOP_PI").unwrap_or_else(|_| "pi".into());
    let hub = hub::Hub::new(socket.to_string_lossy().into_owned(), vec![pi], Box::new(notify::show));
    host_server::serve(hub.clone(), listener);

    gpui_kit::application().with_assets(gpui_kit::assets::Assets).run(move |cx| {
        gpui_kit::init(cx);
        let clicked = hub.clone();
        notify::init(move |id| {
            let _ = clicked.focus(&id);
        });
        let quitting = hub.clone();
        cx.on_app_quit(move |_| {
            quitting.shutdown_all();
            host_server::remove_socket(&socket);
            async {}
        })
        .detach();
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        let first = hub.open_root(&cwd);
        match &first {
            Ok(id) => hub.set_focused(Some(id.clone())),
            Err(e) => eprintln!("cannot start the root session: {}", e.message),
        }
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1200.0), px(800.0)), cx))),
            ..Default::default()
        };
        let shell_hub = hub.clone();
        gpui_kit::open_window(options, cx, move |window, cx| cx.new(|cx| app::Shell::new(shell_hub, cwd, window, cx)))
            .expect("failed to open window");
        cx.activate(true);
    });
}
