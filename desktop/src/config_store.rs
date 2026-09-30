//! The config page's files on disk (`docs/desktop/ui-design.md` §7): which
//! files, reading them, and the one save path — validate with prg's own
//! checker, refuse on a changed disk, back the original up, write atomically.
//!
//! No validation rule lives here: `scripts/validate-config.ts` (prg's TS,
//! `lib/config-validate.ts`) decides, and a checker that cannot run refuses the
//! save (fail-closed) instead of letting an unchecked file through.

use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

/// Which rule set a file is checked against (the validator's `<kind>` argument).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    PiSettings,
    PiModels,
    Gate,
}

impl Kind {
    fn arg(self) -> &'static str {
        match self {
            Kind::PiSettings => "pi-settings",
            Kind::PiModels => "pi-models",
            Kind::Gate => "gate",
        }
    }
}

/// One editable file.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigFile {
    /// Nav group: `pi` or `门禁`.
    pub group: &'static str,
    /// Nav label.
    pub label: &'static str,
    pub path: PathBuf,
    pub kind: Kind,
}

/// The files the page offers; the project ones only when there is a repo (§7.1).
pub fn files(home: &Path, repo: Option<&Path>) -> Vec<ConfigFile> {
    let f = |group, label, path: PathBuf, kind| ConfigFile { group, label, path, kind };
    let mut out = vec![
        f("pi", "settings.json · 全局", home.join(".pi/agent/settings.json"), Kind::PiSettings),
        f("pi", "models.json", home.join(".pi/agent/models.json"), Kind::PiModels),
    ];
    if let Some(r) = repo {
        out.push(f("pi", "settings.json · 项目", r.join(".pi/settings.json"), Kind::PiSettings));
    }
    out.push(f("门禁", "全局", home.join(".pi/review-gate.json"), Kind::Gate));
    if let Some(r) = repo {
        out.push(f("门禁", "项目", r.join(".pi/review-gate.json"), Kind::Gate));
    }
    out
}

/// A file as read: `text: None` = it does not exist yet (saving creates it).
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded {
    pub text: Option<String>,
    pub mtime: Option<SystemTime>,
}

pub fn load(path: &Path) -> std::io::Result<Loaded> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Loaded { text: Some(text), mtime: std::fs::metadata(path)?.modified().ok() }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Loaded { text: None, mtime: None }),
        Err(e) => Err(e),
    }
}

/// One validator finding: a dotted JSON path (`agents.reviewer`, `""` = the file) and why.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

/// How to run prg's checker: `<node> <prg>/scripts/validate-config.ts <kind>`.
#[derive(Clone, Debug)]
pub struct Validator {
    pub node: String,
    pub script: PathBuf,
    /// `$HOME` for the checker (the model registry it resolves slots against); None = inherit.
    pub home: Option<PathBuf>,
}

impl Validator {
    /// `PI_DESKTOP_NODE` (default `node`) and `PI_DESKTOP_PRG` (default: the prg
    /// checkout this binary was built from).
    pub fn from_env() -> Validator {
        let prg = std::env::var_os("PI_DESKTOP_PRG").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
        Validator { node: std::env::var("PI_DESKTOP_NODE").unwrap_or_else(|_| "node".into()), script: prg.join("scripts/validate-config.ts"), home: None }
    }

    /// The findings (empty = valid), or Err when the checker itself could not give a verdict.
    pub fn check(&self, kind: Kind, text: &str) -> Result<Vec<Issue>, String> {
        #[derive(Deserialize)]
        struct Verdict {
            issues: Vec<Issue>,
        }
        let mut cmd = Command::new(&self.node);
        cmd.arg(&self.script).arg(kind.arg()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(h) = &self.home {
            cmd.env("HOME", h);
        }
        let mut child = cmd.spawn().map_err(|e| format!("无法启动校验器（{} {}）：{e}", self.node, self.script.display()))?;
        // The checker reads stdin to EOF before it prints anything, so a plain write-then-wait cannot deadlock.
        child.stdin.take().expect("piped").write_all(text.as_bytes()).map_err(|e| format!("校验器输入失败：{e}"))?;
        let out = child.wait_with_output().map_err(|e| format!("校验器异常退出：{e}"))?;
        if !out.status.success() {
            return Err(format!("校验器失败（{}）：{}", out.status, String::from_utf8_lossy(&out.stderr).trim()));
        }
        serde_json::from_slice::<Verdict>(&out.stdout).map(|v| v.issues).map_err(|e| format!("校验器输出无法解析：{e}"))
    }
}

#[derive(Debug, PartialEq)]
pub enum SaveError {
    /// The checker refused the text; nothing was written.
    Invalid(Vec<Issue>),
    /// The file changed on disk since it was loaded; nothing was written (§7.4).
    Conflict,
    /// The checker could not run; nothing was written.
    Validator(String),
    /// Backup or write failed.
    Io(String),
}

#[derive(Debug, PartialEq)]
pub struct Saved {
    /// Where the previous content went (None: there was no file to back up).
    pub backup: Option<PathBuf>,
    pub loaded: Loaded,
}

/// Save `text` to `path`. `seen` is the mtime the draft was loaded at; `force`
/// overwrites a file that changed since (after backing THAT version up).
/// `stamp` names the backup (`<file>.bak-<stamp>`).
pub fn save(path: &Path, text: &str, kind: Kind, seen: Option<SystemTime>, force: bool, validator: &Validator, stamp: &str) -> Result<Saved, SaveError> {
    let issues = validator.check(kind, text).map_err(SaveError::Validator)?;
    if !issues.is_empty() {
        return Err(SaveError::Invalid(issues));
    }
    let now = load(path).map_err(|e| SaveError::Io(format!("读取 {} 失败：{e}", path.display())))?;
    if !force && now.mtime != seen {
        return Err(SaveError::Conflict);
    }
    let backup = match now.text {
        Some(_) => Some(backup(path, stamp).map_err(|e| SaveError::Io(format!("备份失败，未保存：{e}")))?),
        None => None,
    };
    write_atomic(path, text).map_err(|e| SaveError::Io(format!("写入 {} 失败：{e}", path.display())))?;
    let loaded = load(path).map_err(|e| SaveError::Io(e.to_string()))?;
    Ok(Saved { backup, loaded })
}

/// Copy `path` to `<path>.bak-<stamp>` beside it (`-2`, `-3`… if that name is taken).
fn backup(path: &Path, stamp: &str) -> std::io::Result<PathBuf> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config");
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!("-{n}") };
        let to = path.with_file_name(format!("{name}.bak-{stamp}{suffix}"));
        if !to.exists() {
            std::fs::copy(path, &to)?;
            return Ok(to);
        }
        n += 1;
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_file_name(format!(".{}.tmp-{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("config"), std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| drop(std::fs::remove_file(&tmp)))
}

/// Local time as `YYYYMMDD-HHMMSS` for backup names.
pub fn stamp_now() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as libc::time_t;
    // SAFETY: localtime_r only writes the tm we own.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A temp home whose registry knows `anthropic/claude-fable-5`, and a validator bound to it.
    fn setup(tag: &str) -> (Tmp, Validator) {
        let dir = std::env::temp_dir().join(format!("pi-desktop-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".pi/agent")).unwrap();
        std::fs::write(dir.join(".pi/agent/models.json"), r#"{"providers":{"anthropic":{"models":[{"id":"claude-fable-5","thinkingLevelMap":{"max":"max"}}]}}}"#).unwrap();
        let v = Validator { home: Some(dir.clone()), ..Validator::from_env() };
        (Tmp(dir), v)
    }

    const GOOD: &str = "{\n  \"agents\": {\"reviewer\": {\"auto\": false, \"slots\": [\"anthropic/claude-fable-5:max\"]}}\n}\n";
    const BAD: &str = "{\n  \"agents\": {\"reviewer\": {\"auto\": false, \"slots\": [\"nope/ghost-9\"]}}\n}\n";

    #[test]
    fn valid_save_backs_up_the_original_and_writes() {
        let (tmp, v) = setup("ok");
        let path = tmp.0.join(".pi/review-gate.json");
        std::fs::write(&path, "{}\n").unwrap();
        let seen = load(&path).unwrap().mtime;
        let saved = save(&path, GOOD, Kind::Gate, seen, false, &v, "20260930-120000").unwrap();
        let bak = saved.backup.unwrap();
        assert_eq!(bak, tmp.0.join(".pi/review-gate.json.bak-20260930-120000"));
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "{}\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), GOOD);
        assert_eq!(saved.loaded.text.as_deref(), Some(GOOD));
        // Same second again: the first backup is kept.
        let saved = save(&path, GOOD, Kind::Gate, saved.loaded.mtime, false, &v, "20260930-120000").unwrap();
        assert!(saved.backup.unwrap().ends_with("review-gate.json.bak-20260930-120000-2"));
    }

    #[test]
    fn an_unresolvable_slot_is_refused_and_the_file_is_untouched() {
        let (tmp, v) = setup("bad");
        let path = tmp.0.join(".pi/review-gate.json");
        std::fs::write(&path, GOOD).unwrap();
        let seen = load(&path).unwrap().mtime;
        match save(&path, BAD, Kind::Gate, seen, false, &v, "x") {
            Err(SaveError::Invalid(issues)) => assert_eq!(issues[0].path, "agents.reviewer"),
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), GOOD);
        assert_eq!(std::fs::read_dir(tmp.0.join(".pi")).unwrap().count(), 2, "no backup, no temp file");
    }

    #[test]
    fn a_missing_file_is_created_without_a_backup() {
        let (tmp, v) = setup("new");
        let path = tmp.0.join("proj/.pi/review-gate.json");
        assert_eq!(load(&path).unwrap(), Loaded { text: None, mtime: None });
        let saved = save(&path, GOOD, Kind::Gate, None, false, &v, "x").unwrap();
        assert_eq!(saved.backup, None);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), GOOD);
    }

    #[test]
    fn a_file_changed_since_loading_is_a_conflict_until_forced() {
        let (tmp, v) = setup("conflict");
        let path = tmp.0.join(".pi/review-gate.json");
        std::fs::write(&path, "{}\n").unwrap();
        let old = SystemTime::UNIX_EPOCH;
        assert_eq!(save(&path, GOOD, Kind::Gate, Some(old), false, &v, "x"), Err(SaveError::Conflict));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        let saved = save(&path, GOOD, Kind::Gate, Some(old), true, &v, "x").unwrap();
        assert_eq!(std::fs::read_to_string(saved.backup.unwrap()).unwrap(), "{}\n");
    }

    #[test]
    fn a_checker_that_cannot_run_refuses_the_save() {
        let (tmp, v) = setup("nochecker");
        let path = tmp.0.join(".pi/review-gate.json");
        let v = Validator { node: "/nonexistent/node".into(), ..v };
        assert!(matches!(save(&path, GOOD, Kind::Gate, None, false, &v, "x"), Err(SaveError::Validator(_))));
        assert!(!path.exists());
    }

    #[test]
    fn pi_settings_types_are_checked_by_prg() {
        let (_tmp, v) = setup("pi");
        assert_eq!(v.check(Kind::PiSettings, r#"{"defaultModel":"x"}"#).unwrap(), vec![]);
        assert_eq!(v.check(Kind::PiSettings, r#"{"quietStartup":"yes"}"#).unwrap()[0].path, "quietStartup");
    }

    #[test]
    fn the_file_list_follows_the_repo() {
        let home = Path::new("/h");
        assert_eq!(files(home, None).len(), 3);
        let with = files(home, Some(Path::new("/r")));
        assert_eq!(with.iter().map(|f| f.path.to_str().unwrap()).collect::<Vec<_>>(), [
            "/h/.pi/agent/settings.json",
            "/h/.pi/agent/models.json",
            "/r/.pi/settings.json",
            "/h/.pi/review-gate.json",
            "/r/.pi/review-gate.json"
        ]);
    }

    #[test]
    fn stamp_is_sortable() {
        let s = stamp_now();
        assert_eq!(s.len(), 15);
        assert_eq!(&s[8..9], "-");
    }
}
