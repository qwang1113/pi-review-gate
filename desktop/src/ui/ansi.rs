//! ANSI SGR text (§9.3): status texts from pi extensions (`setStatus`, the
//! gate's unmet rows) may carry escape sequences such as `\x1b[38;2;r;g;bm`.
//! `parse` turns one string into styled spans; no control byte survives it.
//! Pure — the status strip paints the spans with the `ansi.*` tokens.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    /// One of the 16 palette entries, painted with `color.ansi.<n>`.
    Palette(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Style {
    pub fg: Option<Color>,
    pub bg: Option<Color>,
    pub bold: bool,
    pub dim: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: Style,
}

/// xterm's 256-colour table: 0–15 stay palette entries (themeable), the cube
/// and the grey ramp become RGB.
pub fn color256(n: u8) -> Color {
    match n {
        0..=15 => Color::Palette(n),
        16..=231 => {
            let i = n - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
            Color::Rgb(level(i / 36), level(i / 6 % 6), level(i % 6))
        }
        _ => {
            let g = 8 + (n - 232) * 10;
            Color::Rgb(g, g, g)
        }
    }
}

/// `38;5;n` / `38;2;r;g;b` after the 38/48 selector; consumes its arguments.
fn extended(params: &[u16], i: &mut usize) -> Option<Color> {
    let byte = |k: usize| params.get(k).map(|&v| v.min(255) as u8);
    match params.get(*i + 1) {
        Some(5) => {
            let c = byte(*i + 2).map(color256);
            *i += 2;
            c
        }
        Some(2) => {
            let c = match (byte(*i + 2), byte(*i + 3), byte(*i + 4)) {
                (Some(r), Some(g), Some(b)) => Some(Color::Rgb(r, g, b)),
                _ => None,
            };
            *i += 4;
            c
        }
        _ => {
            *i += 1;
            None
        }
    }
}

fn apply_sgr(style: &mut Style, params: &[u16]) {
    if params.is_empty() {
        *style = Style::default();
        return;
    }
    let mut i = 0;
    while i < params.len() {
        match params[i] {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            22 => (style.bold, style.dim) = (false, false),
            4 => style.underline = true,
            24 => style.underline = false,
            7 => style.inverse = true,
            27 => style.inverse = false,
            n @ 30..=37 => style.fg = Some(Color::Palette((n - 30) as u8)),
            n @ 90..=97 => style.fg = Some(Color::Palette((n - 90 + 8) as u8)),
            n @ 40..=47 => style.bg = Some(Color::Palette((n - 40) as u8)),
            n @ 100..=107 => style.bg = Some(Color::Palette((n - 100 + 8) as u8)),
            39 => style.fg = None,
            49 => style.bg = None,
            38 => style.fg = extended(params, &mut i).or(style.fg),
            48 => style.bg = extended(params, &mut i).or(style.bg),
            // Italic (3/23), blink, strike-through, fonts…: ignored (§9.3).
            _ => {}
        }
        i += 1;
    }
}

/// Parses one string. Styles never leak between calls; SGR sequences restyle,
/// every other escape (CSI, OSC, a truncated tail) is dropped.
pub fn parse(s: &str) -> Vec<Span> {
    let mut spans: Vec<Span> = vec![];
    let mut style = Style::default();
    let mut text = String::new();
    let mut chars = s.chars().peekable();
    let flush = |text: &mut String, style: Style, spans: &mut Vec<Span>| {
        if text.is_empty() {
            return;
        }
        match spans.last_mut() {
            Some(last) if last.style == style => last.text.push_str(text),
            _ => spans.push(Span { text: text.clone(), style }),
        }
        text.clear();
    };
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            // Other C0 controls (BEL, BS, CR…) never reach the screen either.
            if !c.is_control() || c == '\t' {
                text.push(if c == '\t' { ' ' } else { c });
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                let mut body = String::new();
                let mut final_byte = None;
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        final_byte = Some(c);
                        break;
                    }
                    body.push(c);
                }
                if final_byte == Some('m') && body.chars().all(|c| c.is_ascii_digit() || c == ';' || c == ':') {
                    flush(&mut text, style, &mut spans);
                    let params: Vec<u16> = if body.is_empty() { vec![] } else { body.split([';', ':']).map(|p| p.parse().unwrap_or(0)).collect() };
                    apply_sgr(&mut style, &params);
                }
            }
            // OSC: up to BEL or ST (ESC \).
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            // Any other two-byte escape: drop both.
            _ => {}
        }
    }
    flush(&mut text, style, &mut spans);
    spans
}

/// The text without any styling (tooltips, copy).
pub fn plain(s: &str) -> String {
    parse(s).into_iter().map(|s| s.text).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fg(spans: &[Span]) -> Vec<(&str, Option<Color>)> {
        spans.iter().map(|s| (s.text.as_str(), s.style.fg)).collect()
    }

    #[test]
    fn truecolor_from_the_reported_screenshot() {
        let s = parse("\x1b[38;2;138;190;183mponytail\x1b[0m full");
        assert_eq!(fg(&s), vec![("ponytail", Some(Color::Rgb(138, 190, 183))), (" full", None)]);
        assert!(!plain("\x1b[38;2;138;190;183mx\x1b[39m").contains('['));
    }

    #[test]
    fn palette_bright_background_and_reset_codes() {
        let s = parse("\x1b[1;31mA\x1b[22;92mB\x1b[44mC\x1b[49;39mD");
        assert_eq!(s[0].style, Style { fg: Some(Color::Palette(1)), bold: true, ..Style::default() });
        assert_eq!(s[1].style, Style { fg: Some(Color::Palette(10)), ..Style::default() });
        assert_eq!(s[2].style.bg, Some(Color::Palette(4)));
        assert_eq!(s[3].style, Style::default());
        assert_eq!(parse("\x1b[100mx")[0].style.bg, Some(Color::Palette(8)));
        assert_eq!(parse("\x1b[1m\x1b[mx")[0].style, Style::default(), "ESC[m resets");
    }

    #[test]
    fn dim_underline_inverse_and_ignored_params() {
        let s = parse("\x1b[2;4;7;3;5;9mx\x1b[24;27my");
        assert_eq!(s[0].style, Style { dim: true, underline: true, inverse: true, ..Style::default() });
        assert_eq!(s[1].style, Style { dim: true, ..Style::default() });
    }

    #[test]
    fn colors_256() {
        assert_eq!(color256(9), Color::Palette(9));
        assert_eq!(color256(16), Color::Rgb(0, 0, 0));
        assert_eq!(color256(196), Color::Rgb(255, 0, 0));
        assert_eq!(color256(231), Color::Rgb(255, 255, 255));
        assert_eq!(color256(232), Color::Rgb(8, 8, 8));
        assert_eq!(color256(255), Color::Rgb(238, 238, 238));
        assert_eq!(parse("\x1b[48;5;21;38;5;3mx")[0].style, Style { fg: Some(Color::Palette(3)), bg: Some(Color::Rgb(0, 0, 255)), ..Style::default() });
        // A malformed extended colour keeps parsing the rest of the sequence.
        assert_eq!(parse("\x1b[38;2;1;1mx")[0].style.fg, None);
        assert_eq!(parse("\x1b[38;9;1mx")[0].style, Style { bold: true, ..Style::default() });
    }

    #[test]
    fn non_sgr_escapes_and_truncated_tails_are_dropped() {
        assert_eq!(plain("a\x1b[2Kb\x1b[1;1Hc"), "abc");
        assert_eq!(plain("\x1b]8;;https://x\x07link\x1b]8;;\x1b\\ end"), "link end");
        assert_eq!(plain("ok\x1b[38;2;1"), "ok");
        assert_eq!(plain("ok\x1b"), "ok");
        assert_eq!(plain("a\x07b\rc\td"), "abc d");
        assert_eq!(parse(""), vec![]);
    }

    #[test]
    fn styles_do_not_leak_between_strings_and_equal_spans_merge() {
        assert_eq!(parse("\x1b[31mred").len(), 1);
        assert_eq!(parse("plain")[0].style, Style::default());
        assert_eq!(parse("a\x1b[0mb").len(), 1, "a reset between unstyled text merges");
    }
}
