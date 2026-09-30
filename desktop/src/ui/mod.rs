//! The window's views (`docs/desktop/ui-design.md`), one module per region.
//! `*_model` modules are pure and unit-tested; the others paint them.

pub mod anim;
pub mod ansi;
pub mod assets;
pub mod chat;
pub mod chat_model;
pub mod chrome;
pub mod composer;
pub mod controls;
pub mod dialog_host;
pub mod dialog_state;
pub mod dialogs;
pub mod diff;
pub mod drawer;
pub mod motion;
pub mod scroll;
pub mod sidebar;
pub mod sidebar_model;
pub mod sidebar_state;
pub mod status;
pub mod status_model;
pub mod stream_text;
pub mod theme;

use gpui_kit::component::theme::{Theme, ThemeMode};
use gpui_kit::{App, Global, SharedString};
use theme::{TOKENS, Th};

/// Looping ambient motion (pulses, spinners) repaints the whole window; this
/// caps it so an idle window with a working session stays cheap.
pub const LOOP_FPS: f32 = 30.0;

/// The font families resolved from the tokens at startup (§2.2).
pub struct Fonts {
    pub ui: SharedString,
    pub mono: SharedString,
}

impl Global for Fonts {}

/// Fonts, families and the component library's theme, once at startup.
pub fn init(cx: &mut App) {
    assets::register_fonts(cx);
    let installed = cx.text_system().all_font_names();
    let fonts = Fonts {
        ui: assets::resolve_family(&TOKENS.ui_families, &installed),
        mono: assets::resolve_family(&TOKENS.mono_families, &installed),
    };
    cx.set_global(fonts);
}

/// Keeps gpui-component's widgets (text inputs, markdown, tooltips) on our tokens.
pub fn apply_theme(th: Th, cx: &mut App) {
    Theme::change(if th.dark { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
    let (ui, mono) = {
        let f = cx.global::<Fonts>();
        (f.ui.clone(), f.mono.clone())
    };
    Theme::update(cx, |t| {
        t.font_family = ui;
        t.mono_font_family = mono;
        t.font_size = gpui_kit::px(th.font("body").size);
        t.colors.background = th.c("bg.app");
        t.colors.foreground = th.c("text.primary");
        t.colors.muted_foreground = th.c("text.muted");
        t.colors.border = th.c("border.default");
        t.colors.input = th.c("border.default");
        t.colors.ring = th.c("border.focus");
        t.colors.caret = th.c("accent.primary");
        t.colors.selection = th.ca("accent.primary", 0.35);
        t.colors.link = th.c("accent.primary");
        t.colors.popover = th.c("bg.overlay");
        t.colors.popover_foreground = th.c("text.primary");
        t.colors.accent = th.c("code.inline.bg");
        t.colors.accent_foreground = th.c("code.inline.text");
    });
}

/// macOS「减少动态效果」(§11). No reading ⇒ full motion.
pub fn system_reduce_motion() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        use objc2::msg_send;
        let Some(cls) = AnyClass::get(c"NSWorkspace") else { return false };
        // SAFETY: documented AppKit class methods with these exact signatures.
        unsafe {
            let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
            if ws.is_null() {
                return false;
            }
            let reduce: Bool = msg_send![ws, accessibilityDisplayShouldReduceMotion];
            reduce.as_bool()
        }
    }
    #[cfg(not(target_os = "macos"))]
    false
}
