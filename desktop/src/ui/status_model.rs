//! The bottom status strip's facts (§9), read from what prg already sends over
//! pi RPC (`host-protocol.md` §7.4): the `review-gate-agents` widget line built
//! by `lib/ui-widget.ts` `buildGateWidget` —
//! `门禁 · mode <mode> · <branch> · <已编辑|未编辑>[ · 轮 N][ · <stages>][ · N 项未满足]`
//! — plus any `setStatus` texts. A line this parser cannot read is shown raw.
//! On the desktop host every widget row after the first is one unmet item,
//! `· <short text>` (`buildGateWidget({details})`, `host-protocol.md`).

pub const GATE_WIDGET_KEY: &str = "review-gate-agents";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Strip {
    pub mode: String,
    pub branch: Option<String>,
    pub round: Option<u32>,
    pub stages: Option<String>,
    pub unmet: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Gate(Strip),
    Raw(String),
}

pub fn parse(line: &str) -> Parsed {
    let raw = || Parsed::Raw(line.to_string());
    let mut parts = line.split(" · ");
    if parts.next() != Some("门禁") {
        return raw();
    }
    let rest: Vec<&str> = parts.collect();
    if rest.first() == Some(&"非 git 目录") {
        return Parsed::Gate(Strip { mode: "normal".into(), ..Strip::default() });
    }
    let Some(mode) = rest.first().and_then(|m| m.strip_prefix("mode ")) else { return raw() };
    let mut s = Strip { mode: mode.to_string(), ..Strip::default() };
    for p in &rest[1..] {
        if *p == "已编辑" || *p == "未编辑" {
            continue;
        } else if let Some(n) = p.strip_prefix("轮 ").and_then(|n| n.parse().ok()) {
            s.round = Some(n);
        } else if let Some(n) = p.strip_suffix(" 项未满足").and_then(|n| n.parse().ok()) {
            s.unmet = n;
        } else if p.starts_with("已关闭") {
            s.stages = Some(p.to_string());
        } else if s.branch.is_none() {
            s.branch = Some(p.to_string());
        }
    }
    Parsed::Gate(s)
}

/// The unmet items the widget carries after its strip row (§9.2). A widget
/// that sends only the strip yields none — the popover then shows the count.
pub fn unmet_items(lines: &[String]) -> Vec<String> {
    lines.iter().skip(1).filter_map(|l| l.strip_prefix("· ").or_else(|| l.strip_prefix('·'))).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
}

/// The mode badge's colour tokens (§9); an unknown mode reads as `normal`.
pub fn mode_tokens(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "orchestrator" => ("mode.orchestrator.bg", "mode.orchestrator.text"),
        "loop" => ("mode.loop.bg", "mode.loop.text"),
        "explore" => ("mode.explore.bg", "mode.explore.text"),
        _ => ("mode.normal.bg", "mode.normal.text"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_segment_of_the_gate_widget() {
        let p = parse("门禁 · mode loop · feat/desktop-host · 已编辑 · 轮 3 · 已关闭 review、precommit · 2 项未满足");
        assert_eq!(
            p,
            Parsed::Gate(Strip {
                mode: "loop".into(),
                branch: Some("feat/desktop-host".into()),
                round: Some(3),
                stages: Some("已关闭 review、precommit".into()),
                unmet: 2
            })
        );
        let Parsed::Gate(s) = parse("门禁 · mode orchestrator · main · 未编辑") else { panic!() };
        assert_eq!((s.round, s.unmet, s.branch.as_deref()), (None, 0, Some("main")));
        let Parsed::Gate(s) = parse("门禁 · mode 未初始化 · 未编辑") else { panic!() };
        assert_eq!((s.mode.as_str(), s.branch), ("未初始化", None));
    }

    #[test]
    fn unmet_rows_follow_the_strip() {
        let lines: Vec<String> = ["门禁 · mode loop · b · 已编辑 · 2 项未满足", "· code review gate is PENDING (need READY)", "· precommit has not run"]
            .map(String::from)
            .to_vec();
        assert_eq!(unmet_items(&lines), vec!["code review gate is PENDING (need READY)", "precommit has not run"]);
        assert!(unmet_items(&lines[..1]).is_empty(), "a terminal-style single row has no detail");
        assert!(unmet_items(&["· looks like a row".to_string()]).is_empty(), "the first row is the strip, never an item");
        assert!(unmet_items(&["x".into(), "·  ".into(), "other".into()]).is_empty());
    }

    #[test]
    fn non_git_and_unreadable_lines() {
        assert!(matches!(parse("门禁 · 非 git 目录 · 已编辑"), Parsed::Gate(Strip { branch: None, .. })));
        assert_eq!(parse("something else"), Parsed::Raw("something else".into()));
        assert_eq!(parse("门禁 · weird"), Parsed::Raw("门禁 · weird".into()));
        assert_eq!(mode_tokens("bogus").0, "mode.normal.bg");
    }
}
