//! Bundled resources (`docs/desktop/ui-design.md` §2.2, §3): the Lucide icons
//! the spec lists (ISC, stroke 1.5, `currentColor`), Inter and JetBrains Mono
//! (OFL-1.1). All of them are embedded in the binary; the licence texts live in
//! `desktop/assets/licenses/` and `scripts/bundle.sh` copies them into the `.app`.

use gpui_kit::{App, AssetSource, Hsla, Pixels, Result, SharedString, Styled, Svg, svg};
use std::borrow::Cow;

macro_rules! icons {
    ($($name:literal),* $(,)?) => {
        const ICONS: &[(&str, &[u8])] = &[
            $(($name, include_bytes!(concat!("../../assets/icons/", $name, ".svg")))),*
        ];
    };
}

icons!(
    "arrow-left", "arrow-up", "badge-check", "bell", "bot", "brain", "check", "chevron-down", "chevron-right",
    "circle", "circle-alert", "circle-check", "circle-dot", "circle-x", "copy", "crown", "file-check-corner",
    "file-pen", "file-text", "git-branch", "layers", "loader-circle", "message-circle-question-mark", "pencil",
    "plug", "refresh-cw", "shield-alert", "sparkles", "square", "square-check", "target", "terminal", "wrench",
);

const FONTS: &[&[u8]] = &[
    include_bytes!("../../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-SemiBold.ttf"),
];

const PREFIX: &str = "pi/";

/// Our icons under `pi/<name>.svg`; everything else (the component library's
/// own icons) falls through to gpui-kit's bundle.
pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(name) = path.strip_prefix(PREFIX).and_then(|p| p.strip_suffix(".svg")) {
            return Ok(ICONS.iter().find(|(n, _)| *n == name).map(|(_, b)| Cow::Borrowed(*b)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut out = gpui_kit::assets::Assets.list(path)?;
        out.extend(ICONS.iter().map(|(n, _)| SharedString::from(format!("{PREFIX}{n}.svg"))).filter(|p| p.starts_with(path)));
        Ok(out)
    }
}

pub fn register_fonts(cx: &mut App) {
    if let Err(e) = cx.text_system().add_fonts(FONTS.iter().map(|b| Cow::Borrowed(*b)).collect()) {
        eprintln!("cannot register the bundled fonts: {e}");
    }
}

/// macOS exposes SF Pro only under its private alias; every other family is
/// taken by name. The first family of the token list the system knows wins.
pub fn resolve_family(families: &[String], installed: &[String]) -> SharedString {
    for f in families {
        if f == "SF Pro Text" && cfg!(target_os = "macos") {
            return ".SystemUIFont".into();
        }
        if installed.iter().any(|i| i == f) {
            return f.clone().into();
        }
    }
    families.last().cloned().unwrap_or_default().into()
}

/// A Lucide icon, `size` square, tinted `color` (strokes use `currentColor`).
pub fn icon(name: &'static str, size: Pixels, color: Hsla) -> Svg {
    debug_assert!(ICONS.iter().any(|(n, _)| *n == name), "icon {name} is not bundled");
    svg().path(format!("{PREFIX}{name}.svg")).size(size).flex_none().text_color(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_icon_is_bundled_with_stroke_1_5() {
        for (name, bytes) in ICONS {
            let s = std::str::from_utf8(bytes).unwrap();
            assert!(s.contains("stroke-width=\"1.5\"") && s.contains("currentColor"), "{name}");
        }
        assert_eq!(AppAssets.load("pi/bot.svg").unwrap().map(|b| b.len()), Some(ICONS.iter().find(|i| i.0 == "bot").unwrap().1.len()));
        assert!(AppAssets.load("pi/nope.svg").unwrap().is_none());
    }

    #[test]
    fn licences_ship_next_to_the_assets() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/licenses");
        for f in ["Inter-OFL.txt", "JetBrainsMono-OFL.txt", "Lucide-LICENSE.txt"] {
            assert!(std::path::Path::new(dir).join(f).is_file(), "{f}");
        }
    }

    #[test]
    fn family_resolution() {
        let installed = vec!["Inter".to_string(), "JetBrains Mono".to_string(), "Menlo".to_string()];
        let ui = vec!["SF Pro Text".to_string(), "Inter".to_string()];
        assert_eq!(resolve_family(&ui, &installed).as_ref(), ".SystemUIFont");
        let mono = vec!["JetBrains Mono".to_string(), "SF Mono".to_string(), "Menlo".to_string()];
        assert_eq!(resolve_family(&mono, &installed).as_ref(), "JetBrains Mono");
        assert_eq!(resolve_family(&mono, &["Menlo".to_string()]).as_ref(), "Menlo");
    }
}
