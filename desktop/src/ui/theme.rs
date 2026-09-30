//! Design tokens (`desktop/design/tokens.json`, the single source of every
//! colour, size, duration and easing — `docs/desktop/ui-design.md`). The JSON
//! is embedded at compile time and parsed once; components ask by token name
//! and never write a literal colour or size.

use gpui_kit::{BoxShadow, Hsla, Pixels, Rgba, point, px};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

const TOKENS_JSON: &str = include_str!("../../design/tokens.json");

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontTok {
    pub size: f32,
    pub line_height: f32,
    pub weight: f32,
}

#[derive(Debug)]
pub struct Tokens {
    colors: [HashMap<String, Rgba>; 2],
    shadows: [HashMap<String, Vec<(f32, f32, f32, f32, Rgba)>>; 2],
    sizes: HashMap<String, f32>,
    fonts: HashMap<String, FontTok>,
    durations: HashMap<String, u64>,
    easings: HashMap<String, [f32; 4]>,
    pub ui_families: Vec<String>,
    pub mono_families: Vec<String>,
}

pub fn parse_hex(s: &str) -> Option<Rgba> {
    let h = s.strip_prefix('#')?;
    let v = u32::from_str_radix(h, 16).ok()?;
    let (rgb, a) = match h.len() {
        6 => (v, 0xFF),
        8 => (v >> 8, v & 0xFF),
        _ => return None,
    };
    let c = |shift: u32| ((rgb >> shift) & 0xFF) as f32 / 255.0;
    Some(Rgba { r: c(16), g: c(8), b: c(0), a: a as f32 / 255.0 })
}

fn flat_numbers(v: &Value, prefix: &str, out: &mut HashMap<String, f32>) {
    if let Some(obj) = v.as_object() {
        for (k, v) in obj {
            if let Some(n) = v.as_f64() {
                out.insert(format!("{prefix}{k}"), n as f32);
            }
        }
    }
}

impl Tokens {
    pub fn parse(json: &str) -> Result<Tokens, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let colors_of = |mode: &str| -> Result<HashMap<String, Rgba>, String> {
            let obj = v["color"][mode].as_object().ok_or(format!("color.{mode} missing"))?;
            obj.iter()
                .map(|(k, c)| {
                    let s = c.as_str().ok_or(format!("color.{mode}.{k} not a string"))?;
                    parse_hex(s).map(|c| (k.clone(), c)).ok_or(format!("color.{mode}.{k}: bad hex {s}"))
                })
                .collect()
        };
        let shadows_of = |mode: &str| -> HashMap<String, Vec<(f32, f32, f32, f32, Rgba)>> {
            let n = |l: &Value, k: &str| l[k].as_f64().unwrap_or(0.0) as f32;
            v["shadow"][mode]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, layers)| {
                    let layers = layers.as_array().into_iter().flatten();
                    let parsed = layers
                        .filter_map(|l| Some((n(l, "x"), n(l, "y"), n(l, "blur"), n(l, "spread"), parse_hex(l["color"].as_str()?)?)))
                        .collect();
                    (k.clone(), parsed)
                })
                .collect()
        };
        let mut sizes = HashMap::new();
        flat_numbers(&v["size"], "", &mut sizes);
        flat_numbers(&v["space"], "space.", &mut sizes);
        flat_numbers(&v["radius"], "radius.", &mut sizes);
        flat_numbers(&v["ratio"], "ratio.", &mut sizes);
        flat_numbers(&v["limit"], "limit.", &mut sizes);
        let fonts = v["font"]["scale"]
            .as_object()
            .ok_or("font.scale missing")?
            .iter()
            .map(|(k, f)| {
                let n = |key: &str| f[key].as_f64().unwrap_or(0.0) as f32;
                (k.clone(), FontTok { size: n("size"), line_height: n("lineHeight"), weight: n("weight") })
            })
            .collect();
        let durations = v["motion"]["duration"]
            .as_object()
            .ok_or("motion.duration missing")?
            .iter()
            .filter_map(|(k, d)| Some((k.clone(), d.as_u64()?)))
            .collect();
        let easings = v["motion"]["easing"]
            .as_object()
            .ok_or("motion.easing missing")?
            .iter()
            .filter_map(|(k, e)| {
                let a: Vec<f32> = e.as_array()?.iter().filter_map(|x| x.as_f64().map(|x| x as f32)).collect();
                Some((k.clone(), <[f32; 4]>::try_from(a).ok()?))
            })
            .collect();
        let families = |k: &str| -> Vec<String> {
            v["font"]["family"][k].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect()
        };
        Ok(Tokens {
            colors: [colors_of("dark")?, colors_of("light")?],
            shadows: [shadows_of("dark"), shadows_of("light")],
            sizes,
            fonts,
            durations,
            easings,
            ui_families: families("ui"),
            mono_families: families("mono"),
        })
    }
}

pub static TOKENS: LazyLock<Tokens> = LazyLock::new(|| Tokens::parse(TOKENS_JSON).expect("design/tokens.json is valid"));

/// Solves a CSS `cubic-bezier(x1, y1, x2, y2)` for `t` ∈ [0, 1].
pub fn cubic_bezier([x1, y1, x2, y2]: [f32; 4], t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let bez = |a: f32, b: f32, s: f32| 3.0 * a * s * (1.0 - s).powi(2) + 3.0 * b * s * s * (1.0 - s) + s.powi(3);
    // Bisection on x(s) = t: monotone for x1, x2 ∈ [0, 1], always converges.
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bez(x1, x2, mid) < t { lo = mid } else { hi = mid }
    }
    bez(y1, y2, (lo + hi) / 2.0)
}

/// The `pulse_waiting_input` keyframes (§11): two beats in the first 600 ms, then rest.
pub fn heartbeat_scale(delta: f32) -> f32 {
    let ms = delta.clamp(0.0, 1.0) * 1200.0;
    let beat = |x: f32| if x < 150.0 { 1.0 + 0.25 * x / 150.0 } else { 1.25 - 0.25 * (x - 150.0) / 150.0 };
    match ms {
        m if m < 300.0 => beat(m),
        m if m < 600.0 => beat(m - 300.0),
        _ => 1.0,
    }
}

/// Palette handle passed to every renderer: which appearance is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Th {
    pub dark: bool,
}

impl Th {
    fn mode(self) -> usize {
        if self.dark { 0 } else { 1 }
    }

    /// Colour token without the `color.` prefix, e.g. `c("bg.app")`.
    pub fn c(self, name: &str) -> Hsla {
        match TOKENS.colors[self.mode()].get(name) {
            Some(c) => (*c).into(),
            None => {
                debug_assert!(false, "unknown colour token {name}");
                gpui_kit::red()
            }
        }
    }

    /// `c` with its alpha multiplied (animated fades).
    pub fn ca(self, name: &str, alpha: f32) -> Hsla {
        let mut c = self.c(name);
        c.a *= alpha;
        c
    }

    /// Any numeric token by its full name below the group: `n("sidebar.width_default")`,
    /// `n("space.4")`, `n("radius.lg")`, `n("ratio.confirm.width")`, `n("limit.diff.collapse_lines")`.
    pub fn n(self, name: &str) -> f32 {
        match TOKENS.sizes.get(name) {
            Some(v) => *v,
            None => {
                debug_assert!(false, "unknown size token {name}");
                0.0
            }
        }
    }

    pub fn px(self, name: &str) -> Pixels {
        px(self.n(name))
    }

    pub fn sp(self, step: u8) -> Pixels {
        self.px(&format!("space.{step}"))
    }

    pub fn r(self, name: &str) -> Pixels {
        self.px(&format!("radius.{name}"))
    }

    pub fn font(self, name: &str) -> FontTok {
        TOKENS.fonts.get(name).copied().unwrap_or(FontTok { size: 13.0, line_height: 20.0, weight: 400.0 })
    }

    pub fn ms(self, name: &str) -> Duration {
        Duration::from_millis(TOKENS.durations.get(name).copied().unwrap_or(0))
    }

    pub fn ease(self, name: &str) -> impl Fn(f32) -> f32 + 'static {
        let p = TOKENS.easings.get(name).copied().unwrap_or([0.0, 0.0, 1.0, 1.0]);
        move |t| cubic_bezier(p, t)
    }

    pub fn shadow(self, name: &str) -> Vec<BoxShadow> {
        TOKENS.shadows[self.mode()]
            .get(name)
            .into_iter()
            .flatten()
            .map(|&(x, y, blur, spread, color)| BoxShadow {
                offset: point(px(x), px(y)),
                blur_radius: px(blur),
                spread_radius: px(spread),
                color: color.into(),
                inset: false,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_parse_and_both_modes_have_the_same_colours() {
        let t = &*TOKENS;
        let mut dark: Vec<_> = t.colors[0].keys().collect();
        let mut light: Vec<_> = t.colors[1].keys().collect();
        dark.sort();
        light.sort();
        assert_eq!(dark, light);
        assert!(t.colors[0].len() >= 80);
        assert_eq!(t.shadows[0].len(), 4);
        assert_eq!(Th { dark: true }.n("sidebar.width_default"), 260.0);
        assert_eq!(Th { dark: true }.n("space.4"), 16.0);
        assert_eq!(Th { dark: true }.n("radius.xl"), 12.0);
        assert_eq!(Th { dark: true }.n("ratio.confirm.width"), 0.75);
        assert_eq!(Th { dark: true }.n("limit.diff.collapse_lines"), 200.0);
        assert_eq!(Th { dark: false }.font("body_strong"), FontTok { size: 13.0, line_height: 20.0, weight: 600.0 });
        assert_eq!(Th { dark: false }.ms("cursor_blink"), Duration::from_millis(800));
        assert_eq!(t.mono_families.first().map(String::as_str), Some("JetBrains Mono"));
    }

    #[test]
    fn hex_with_and_without_alpha() {
        let c = parse_hex("#6366F1").unwrap();
        assert_eq!((c.r * 255.0).round() as u8, 0x63);
        assert_eq!(c.a, 1.0);
        let c = parse_hex("#00000080").unwrap();
        assert!((c.a - 128.0 / 255.0).abs() < 1e-6 && c.r == 0.0);
        assert!(parse_hex("6366F1").is_none() && parse_hex("#12345").is_none());
    }

    #[test]
    fn bezier_endpoints_and_shape() {
        let e = [0.16, 1.0, 0.3, 1.0];
        assert!(cubic_bezier(e, 0.0).abs() < 1e-3);
        assert!((cubic_bezier(e, 1.0) - 1.0).abs() < 1e-3);
        // emphasized front-loads the motion.
        assert!(cubic_bezier(e, 0.3) > 0.7);
        assert!((cubic_bezier([0.0, 0.0, 1.0, 1.0], 0.4) - 0.4).abs() < 1e-3);
    }

    #[test]
    fn heartbeat_has_two_beats_then_rests() {
        assert_eq!(heartbeat_scale(0.0), 1.0);
        assert!((heartbeat_scale(150.0 / 1200.0) - 1.25).abs() < 1e-4);
        assert!((heartbeat_scale(300.0 / 1200.0) - 1.0).abs() < 1e-4);
        assert!((heartbeat_scale(450.0 / 1200.0) - 1.25).abs() < 1e-4);
        assert_eq!(heartbeat_scale(0.8), 1.0);
    }

    /// Every `c("…")` / `n("…")` / `px("…")` literal in the UI code names a real token.
    #[test]
    fn every_token_used_in_ui_code_exists() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/ui");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let src = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            for (call, colour) in [(".c(\"", true), (".ca(\"", true), (".n(\"", false), (".px(\"", false)] {
                for piece in src.split(call).skip(1) {
                    let name = piece.split('"').next().unwrap();
                    if colour {
                        assert!(TOKENS.colors[0].contains_key(name), "unknown colour token {name}");
                    } else {
                        assert!(TOKENS.sizes.contains_key(name), "unknown size token {name}");
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 0);
    }
}
