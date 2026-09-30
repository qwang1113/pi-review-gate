//! Unified-diff parsing for the diff block (§5.4): the `details.patch` pi's
//! `edit` tool returns (jsdiff `createTwoFilesPatch`) or any ```diff fence.
//! Pure: the renderer only paints what this returns.

use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hunk,
    Ctx,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub kind: Kind,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    /// The changed span inside `text` (byte range), when it pairs with a line of the opposite kind.
    pub word: Option<Range<usize>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiffFile {
    pub path: String,
    pub adds: usize,
    pub dels: usize,
    pub lines: Vec<Line>,
}

fn hunk_starts(h: &str) -> (u32, u32) {
    // "@@ -12,5 +12,6 @@ ..." — a missing count means 1 line.
    let mut it = h.split_whitespace().skip(1);
    let num = |s: Option<&str>, sign: char| {
        s.and_then(|s| s.strip_prefix(sign)).and_then(|s| s.split(',').next()).and_then(|n| n.parse().ok()).unwrap_or(1)
    };
    (num(it.next(), '-'), num(it.next(), '+'))
}

/// `None` when the text has no hunk at all (not a diff).
pub fn parse(patch: &str) -> Option<DiffFile> {
    let mut f = DiffFile::default();
    let (mut old, mut new) = (0u32, 0u32);
    let mut in_hunk = false;
    for raw in patch.lines() {
        if !in_hunk && (raw.starts_with("+++ ") || raw.starts_with("--- ")) {
            let p = raw[4..].split('\t').next().unwrap_or("").trim();
            let p = p.strip_prefix("b/").or_else(|| p.strip_prefix("a/")).unwrap_or(p);
            if p != "/dev/null" && (f.path.is_empty() || raw.starts_with("+++")) {
                f.path = p.to_string();
            }
            continue;
        }
        if raw.starts_with("@@") {
            in_hunk = true;
            (old, new) = hunk_starts(raw);
            f.lines.push(Line { kind: Kind::Hunk, old: None, new: None, text: raw.to_string(), word: None });
            continue;
        }
        if !in_hunk || raw.starts_with('\\') {
            continue;
        }
        let (kind, text) = match raw.chars().next() {
            Some('+') => (Kind::Add, &raw[1..]),
            Some('-') => (Kind::Del, &raw[1..]),
            Some(' ') => (Kind::Ctx, &raw[1..]),
            None => (Kind::Ctx, ""),
            _ => continue,
        };
        let (o, n) = match kind {
            Kind::Add => {
                f.adds += 1;
                new += 1;
                (None, Some(new - 1))
            }
            Kind::Del => {
                f.dels += 1;
                old += 1;
                (Some(old - 1), None)
            }
            _ => {
                old += 1;
                new += 1;
                (Some(old - 1), Some(new - 1))
            }
        };
        f.lines.push(Line { kind, old: o, new: n, text: text.to_string(), word: None });
    }
    if !f.lines.iter().any(|l| l.kind == Kind::Hunk) {
        return None;
    }
    mark_words(&mut f.lines);
    Some(f)
}

/// Pairs each run of deletions with the run of additions right after it, line by
/// line, and marks what differs between the common prefix and suffix.
fn mark_words(lines: &mut [Line]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind != Kind::Del {
            i += 1;
            continue;
        }
        let del_start = i;
        while i < lines.len() && lines[i].kind == Kind::Del {
            i += 1;
        }
        let add_start = i;
        while i < lines.len() && lines[i].kind == Kind::Add {
            i += 1;
        }
        let pairs = (add_start - del_start).min(i - add_start);
        for k in 0..pairs {
            let (d, a) = (del_start + k, add_start + k);
            let (dw, aw) = changed_spans(&lines[d].text, &lines[a].text);
            lines[d].word = dw;
            lines[a].word = aw;
        }
    }
}

fn changed_spans(a: &str, b: &str) -> (Option<Range<usize>>, Option<Range<usize>>) {
    let prefix = a.char_indices().zip(b.chars()).take_while(|((_, x), y)| x == y).map(|((i, x), _)| i + x.len_utf8()).last().unwrap_or(0);
    let (ar, br) = (&a[prefix..], &b[prefix..]);
    let suffix = ar.chars().rev().zip(br.chars().rev()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum::<usize>();
    let span = |s: &str| {
        let r = prefix..s.len() - suffix;
        (!r.is_empty() && r.len() < s.len()).then_some(r)
    };
    (span(a), span(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "--- src/a.rs\n+++ src/a.rs\n@@ -1,4 +1,4 @@\n fn main() {\n-    let x = 1;\n+    let x = 42;\n     run(x);\n }\n\\ No newline at end of file\n@@ -10 +10,2 @@\n+added\n ctx\n";

    #[test]
    fn parses_headers_hunks_and_numbers() {
        let f = parse(PATCH).unwrap();
        assert_eq!(f.path, "src/a.rs");
        assert_eq!((f.adds, f.dels), (2, 1));
        let kinds: Vec<Kind> = f.lines.iter().map(|l| l.kind).collect();
        use Kind::*;
        assert_eq!(kinds, vec![Hunk, Ctx, Del, Add, Ctx, Ctx, Hunk, Add, Ctx]);
        assert_eq!((f.lines[2].old, f.lines[2].new), (Some(2), None));
        assert_eq!((f.lines[3].old, f.lines[3].new), (None, Some(2)));
        assert_eq!((f.lines[4].old, f.lines[4].new), (Some(3), Some(3)));
        assert_eq!((f.lines[7].new, f.lines[8].old, f.lines[8].new), (Some(10), Some(10), Some(11)));
    }

    #[test]
    fn marks_the_changed_word() {
        let f = parse(PATCH).unwrap();
        assert_eq!(&f.lines[2].text[f.lines[2].word.clone().unwrap()], "1");
        assert_eq!(&f.lines[3].text[f.lines[3].word.clone().unwrap()], "42");
        assert_eq!(f.lines[7].word, None, "an unpaired addition has no word span");
    }

    #[test]
    fn git_prefixes_and_non_diffs() {
        let f = parse("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n").unwrap();
        assert_eq!(f.path, "x");
        assert_eq!(f.lines[1].word, None, "a fully different line highlights nothing");
        assert!(parse("just some text\n+ not a diff").is_none());
        assert_eq!(changed_spans("héllo wörld", "héllo world"), (Some(8..10), Some(8..9)));
    }
}
