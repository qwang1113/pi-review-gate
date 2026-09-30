//! pi-desktop: a macOS host for pi sessions. `pi-desktop [cwd]` opens a window and
//! starts one root `pi --mode rpc` session in `cwd` (default: the current dir).
//! `pi-desktop --demo` opens the window over fake sessions, events and dialogs
//! instead (no pi, no socket) — one screenshot-ready state per component.
//! `PI_DESKTOP_PI` overrides the pi executable (default `pi` on `PATH`);
//! `PI_DESKTOP_APPEARANCE=light|dark` pins the theme (default: follow macOS).

mod app;
mod demo;
mod host_server;
mod hub;
mod notify;
mod protocol;
mod rpc;
mod sessions;
mod ui;

use gpui_kit::*;
use std::path::PathBuf;
use ui::theme::Th;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let demo = args.iter().any(|a| a == "--demo");
    args.retain(|a| a != "--demo");
    #[cfg(feature = "shots")]
    let shots = args.iter().position(|a| a == "--shots").map(|i| {
        let dir = args.get(i + 1).cloned().expect("--shots <dir>");
        args.drain(i..=i + 1);
        PathBuf::from(dir)
    });
    let cwd = args.first().map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().expect("current dir"));
    let cwd = cwd.canonicalize().expect("cwd must exist").to_string_lossy().into_owned();
    let socket = host_server::socket_path();
    let pi = std::env::var("PI_DESKTOP_PI").unwrap_or_else(|_| "pi".into());
    let hub = hub::Hub::new(socket.to_string_lossy().into_owned(), vec![pi], Box::new(notify::show));
    if !demo {
        let listener = host_server::listen(&socket).unwrap_or_else(|e| panic!("cannot listen on {}: {e}", socket.display()));
        host_server::serve(hub.clone(), listener);
    }

    gpui_kit::application().with_assets(ui::assets::AppAssets).run(move |cx| {
        gpui_kit::init(cx);
        ui::init(cx);
        let clicked = hub.clone();
        notify::init(move |id| {
            let _ = clicked.focus(&id);
        });
        let quitting = hub.clone();
        cx.on_app_quit(move |_| {
            quitting.shutdown_all();
            if !demo {
                host_server::remove_socket(&socket);
            }
            async {}
        })
        .detach();
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        if demo {
            demo::populate(&hub, &cwd);
        } else {
            match hub.open_root(&cwd) {
                Ok(id) => hub.set_focused(Some(id)),
                Err(e) => eprintln!("cannot start the root session: {}", e.message),
            }
        }
        let th = Th { dark: true };
        let size = |w: &str, h: &str| gpui_kit::size(th.px(w), th.px(h));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size("window.default_width", "window.default_height"), cx))),
            window_min_size: Some(size("window.min_width", "window.min_height")),
            titlebar: Some(TitlebarOptions {
                title: Some("Pi".into()),
                appears_transparent: true,
                // Vertically centred in the 38 px bar.
                traffic_light_position: Some(point(th.px("titlebar.traffic_light_inset"), px(12.))),
            }),
            ..Default::default()
        };
        let shell_hub = hub.clone();
        let (_handle, _shell) = gpui_kit::open_window(options, cx, move |window, cx| cx.new(|cx| app::Shell::new(shell_hub, cwd, demo, window, cx)))
            .expect("failed to open window");
        #[cfg(feature = "shots")]
        if let (Some(dir), true) = (shots.clone(), demo) {
            demo::shoot(_shell, _handle, dir, cx);
        }
        cx.activate(true);
    });
}
