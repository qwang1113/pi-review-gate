//! The config page's draft (§7) — pure: a file's JSON as form fields generated
//! from the value's own types (no copy of any schema), the JSON text view, the
//! switch between them, dirtiness and the error count. The page paints it;
//! `crate::config_store` saves it.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Form,
    Json,
}

/// What a form row edits (§7.2: the control follows the JSON value's type).
#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    Bool(bool),
    Number(String),
    Text(String),
    /// An array of strings: an ordered list (`agents.*.slots`).
    List(Vec<String>),
    /// An object: a foldable sub-group; its fields follow with `depth + 1`.
    Group,
    /// null, mixed arrays, …: edit in the JSON view.
    ReadOnly(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// Dotted path (`agents.reviewer.slots`), the field's identity.
    pub path: String,
    pub key: String,
    /// 0 for a section's direct rows.
    pub depth: usize,
    pub control: Control,
    /// Masked in the form (§7.2).
    pub sensitive: bool,
}

/// A form section: the top-level scalars together (`常规`), then one per top-level object.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub title: String,
    pub fields: Vec<Field>,
}

pub const GENERAL: &str = "常规";

pub fn is_sensitive(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["key", "token", "secret", "password"].iter().any(|w| k.contains(w))
}

pub fn sections(v: &Value) -> Vec<Section> {
    let Value::Object(m) = v else { return vec![] };
    let mut general = Section { title: GENERAL.into(), fields: vec![] };
    let mut out = vec![];
    for (k, val) in m {
        if let Value::Object(inner) = val {
            let mut s = Section { title: k.clone(), fields: vec![] };
            walk(inner, k, 0, &mut s.fields);
            out.push(s);
        } else {
            general.fields.push(field(k, k, 0, val));
        }
    }
    if !general.fields.is_empty() {
        out.insert(0, general);
    }
    out
}

fn walk(m: &Map<String, Value>, prefix: &str, depth: usize, out: &mut Vec<Field>) {
    for (k, v) in m {
        let path = format!("{prefix}.{k}");
        out.push(field(k, &path, depth, v));
        if let Value::Object(inner) = v {
            walk(inner, &path, depth + 1, out);
        }
    }
}

fn field(key: &str, path: &str, depth: usize, v: &Value) -> Field {
    let control = match v {
        Value::Bool(b) => Control::Bool(*b),
        Value::Number(n) => Control::Number(n.to_string()),
        Value::String(s) => Control::Text(s.clone()),
        Value::Array(a) if a.iter().all(Value::is_string) => Control::List(a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()),
        Value::Object(_) => Control::Group,
        other => Control::ReadOnly(other.to_string()),
    };
    Field { path: path.into(), key: key.into(), depth, control, sensitive: is_sensitive(key) && matches!(v, Value::String(_)) }
}

/// A JSON syntax error, 1-based like the editor's gutter.
#[derive(Clone, Debug, PartialEq)]
pub struct SyntaxError {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

pub fn parse(text: &str) -> Result<Value, SyntaxError> {
    serde_json::from_str(text).map_err(|e| SyntaxError { line: e.line(), column: e.column(), message: e.to_string() })
}

/// The file text a value saves as: 2-space indent, the key order it was read in, trailing newline.
pub fn to_text(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default() + "\n"
}

/// One file being edited.
#[derive(Clone, Debug)]
pub struct Draft {
    /// The disk text it was loaded from (None: the file does not exist).
    pub disk: Option<String>,
    pub view: View,
    /// The form's value (authoritative in the form view).
    pub value: Value,
    /// The JSON view's text (authoritative in the JSON view).
    pub text: String,
    /// Form fields whose input does not parse (path → why); the value keeps its last good entry.
    pub field_errors: BTreeMap<String, String>,
    /// The last save's validator findings.
    pub issues: Vec<crate::config_store::Issue>,
}

impl Draft {
    /// A disk text that does not parse opens in the JSON view (the form has nothing to show).
    pub fn load(disk: Option<String>) -> Draft {
        let text = disk.clone().unwrap_or_else(|| "{}\n".into());
        let (value, view) = match parse(&text) {
            Ok(v) => (v, View::Form),
            Err(_) => (Value::Null, View::Json),
        };
        Draft { disk, view, value, text, field_errors: BTreeMap::new(), issues: vec![] }
    }

    /// Form → JSON: always possible.
    pub fn to_json_view(&mut self) {
        if self.view == View::Form {
            self.text = to_text(&self.value);
            self.view = View::Json;
        }
    }

    /// JSON → form: refused (the view stays) while the text does not parse (§7.3).
    pub fn to_form_view(&mut self) -> Result<(), SyntaxError> {
        if self.view == View::Json {
            self.value = parse(&self.text)?;
            self.field_errors.clear();
            self.view = View::Form;
        }
        Ok(())
    }

    pub fn syntax_error(&self) -> Option<SyntaxError> {
        (self.view == View::Json).then(|| parse(&self.text).err()).flatten()
    }

    /// The text a save writes.
    pub fn save_text(&self) -> String {
        match self.view {
            View::Form => to_text(&self.value),
            View::Json => self.text.clone(),
        }
    }

    /// The draft would save something different from the disk: whitespace does not count,
    /// key order does (the saved text keeps it; `Value` equality would not).
    pub fn dirty(&self) -> bool {
        // The text is the disk's byte for byte (an unreadable file's placeholder included): untouched.
        if self.view == View::Json && self.disk.as_deref() == Some(self.text.as_str()) {
            return false;
        }
        let now = match self.view {
            View::Form => Ok(self.value.clone()),
            View::Json => parse(&self.text),
        };
        let disk = self.disk.as_deref().map(parse);
        match (disk, now) {
            (_, Err(_)) => true,
            (None, Ok(v)) => v != Value::Object(Map::new()),
            (Some(Ok(d)), Ok(v)) => to_text(&d) != to_text(&v) || !self.field_errors.is_empty(),
            (Some(Err(_)), Ok(_)) => true,
        }
    }

    /// Errors that block saving (§7.4 「N 处错误」).
    pub fn error_count(&self) -> usize {
        self.field_errors.len() + usize::from(self.syntax_error().is_some())
    }

    /// Loaded again (after a save, or 「重新载入」).
    pub fn reset(&mut self, disk: Option<String>) {
        let view = self.view;
        *self = Draft::load(disk);
        // The JSON view shows the disk text as it is, not a reformatted copy.
        self.view = view;
    }

    /// A save of `sent` landed and the file now reads `disk`. A draft still equal to `sent`
    /// reloads (true); one edited while the save ran keeps those edits on top of the new disk text.
    pub fn saved(&mut self, sent: &str, disk: Option<String>) -> bool {
        if self.save_text() == sent {
            self.reset(disk);
            true
        } else {
            self.disk = disk;
            false
        }
    }

    pub fn get(&self, path: &str) -> Option<&Value> {
        path.split('.').try_fold(&self.value, |v, seg| match v {
            Value::Object(m) => m.get(seg),
            Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => None,
        })
    }

    fn get_mut(&mut self, path: &str) -> Option<&mut Value> {
        path.split('.').try_fold(&mut self.value, |v, seg| match v {
            Value::Object(m) => m.get_mut(seg),
            Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get_mut(i)),
            _ => None,
        })
    }

    /// Replace one value in place (key order kept).
    pub fn set(&mut self, path: &str, v: Value) {
        if let Some(slot) = self.get_mut(path) {
            *slot = v;
        }
        self.field_errors.remove(path);
    }

    /// A number box's text: a number is stored, anything else is a field error (§7.4).
    pub fn edit_number(&mut self, path: &str, input: &str) {
        let t = input.trim();
        let n = t.parse::<i64>().map(Value::from).ok().or_else(|| t.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number));
        match n {
            Some(v) => self.set(path, v),
            None => {
                self.field_errors.insert(path.into(), format!("「{t}」不是数字"));
            }
        }
    }

    /// Ordered-list edits on a string array (§7.2): move up/down, delete, append.
    pub fn list_move(&mut self, path: &str, i: usize, up: bool) {
        if let Some(Value::Array(a)) = self.get_mut(path) {
            let j = if up { i.checked_sub(1) } else { Some(i + 1).filter(|j| *j < a.len()) };
            if let Some(j) = j.filter(|_| i < a.len()) {
                a.swap(i, j);
            }
        }
    }

    pub fn list_remove(&mut self, path: &str, i: usize) {
        if let Some(Value::Array(a)) = self.get_mut(path) {
            if i < a.len() {
                a.remove(i);
            }
        }
    }

    pub fn list_push(&mut self, path: &str) {
        if let Some(Value::Array(a)) = self.get_mut(path) {
            a.push(Value::String(String::new()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const GATE: &str = "{\n  \"maxRounds\": 8,\n  \"agents\": {\n    \"reviewer\": {\n      \"auto\": false,\n      \"slots\": [\"a/x:max\", \"a/y\"]\n    }\n  },\n  \"apiKey\": \"sk-1\",\n  \"extra\": null\n}\n";

    #[test]
    fn fields_follow_the_value_types_and_keep_the_key_order() {
        let d = Draft::load(Some(GATE.into()));
        let s = sections(&d.value);
        assert_eq!(s.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), [GENERAL, "agents"]);
        assert_eq!(s[0].fields.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), ["maxRounds", "apiKey", "extra"]);
        assert_eq!(s[0].fields[0].control, Control::Number("8".into()));
        assert!(s[0].fields[1].sensitive);
        assert_eq!(s[0].fields[2].control, Control::ReadOnly("null".into()));
        let a: Vec<_> = s[1].fields.iter().map(|f| (f.path.as_str(), f.depth, f.control.clone())).collect();
        assert_eq!(a, [
            ("agents.reviewer", 0, Control::Group),
            ("agents.reviewer.auto", 1, Control::Bool(false)),
            ("agents.reviewer.slots", 1, Control::List(vec!["a/x:max".into(), "a/y".into()])),
        ]);
    }

    #[test]
    fn form_and_json_views_stay_in_sync() {
        let mut d = Draft::load(Some(GATE.into()));
        assert!(!d.dirty());
        d.set("agents.reviewer.auto", json!(true));
        d.list_move("agents.reviewer.slots", 1, true);
        d.list_push("agents.reviewer.slots");
        d.set("agents.reviewer.slots.2", json!("b/z"));
        d.to_json_view();
        // The original key order survives the round trip.
        let order: Vec<_> = ["maxRounds", "agents", "apiKey", "extra"].iter().map(|k| d.text.find(&format!("\"{k}\"")).unwrap()).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]));
        assert!(d.text.contains("\"auto\": true"));
        // JSON edits come back into the form.
        d.text = d.text.replace("\"b/z\"", "\"c/w\"");
        d.to_form_view().unwrap();
        assert_eq!(d.get("agents.reviewer.slots"), Some(&json!(["a/y", "a/x:max", "c/w"])));
        assert!(d.dirty());
        assert_eq!(parse(&d.save_text()).unwrap(), d.value);
    }

    #[test]
    fn a_syntax_error_keeps_the_json_view_and_counts() {
        let mut d = Draft::load(Some(GATE.into()));
        d.to_json_view();
        d.text = "{\n  \"a\": ,\n}".into();
        let e = d.to_form_view().unwrap_err();
        assert_eq!((e.line, d.view), (2, View::Json));
        assert_eq!(d.error_count(), 1);
        assert!(d.dirty());
    }

    #[test]
    fn a_bad_number_is_a_field_error_and_the_value_keeps_its_last_good_entry() {
        let mut d = Draft::load(Some(GATE.into()));
        d.edit_number("maxRounds", "8x");
        assert_eq!((d.error_count(), d.get("maxRounds")), (1, Some(&json!(8))));
        d.edit_number("maxRounds", "12");
        assert_eq!((d.error_count(), d.get("maxRounds")), (0, Some(&json!(12))));
    }

    #[test]
    fn list_edits_stay_in_bounds() {
        let mut d = Draft::load(Some("{\"a\":{\"l\":[\"x\",\"y\"]}}".into()));
        d.list_move("a.l", 0, true);
        d.list_move("a.l", 1, false);
        d.list_remove("a.l", 5);
        assert_eq!(d.get("a.l"), Some(&json!(["x", "y"])));
        d.list_remove("a.l", 0);
        assert_eq!(d.get("a.l"), Some(&json!(["y"])));
    }

    #[test]
    fn missing_and_unparsable_files() {
        let d = Draft::load(None);
        assert_eq!((d.view, d.dirty()), (View::Form, false));
        let mut d = Draft::load(Some("{oops".into()));
        assert_eq!(d.view, View::Json);
        assert_eq!(d.text, "{oops");
        assert!(!d.dirty(), "an untouched unparsable file is not an edit");
        d.text.push('}');
        assert!(d.dirty());
    }

    #[test]
    fn edits_made_while_a_save_ran_survive_it() {
        let mut d = Draft::load(Some("{\"a\":1}".into()));
        d.set("a", json!(2));
        let sent = d.save_text();
        d.set("a", json!(3));
        assert!(!d.saved(&sent, Some(sent.clone())));
        assert_eq!((d.get("a"), d.dirty()), (Some(&json!(3)), true));
        let sent = d.save_text();
        assert!(d.saved(&sent, Some(sent.clone())));
        assert!(!d.dirty());
    }

    #[test]
    fn reordering_keys_is_a_change() {
        let mut d = Draft::load(Some("{\"a\":1,\"b\":2}".into()));
        d.to_json_view();
        d.text = "{ \"a\": 1, \"b\": 2 }".into();
        assert!(!d.dirty(), "whitespace only");
        d.text = "{\"b\":2,\"a\":1}".into();
        assert!(d.dirty());
    }

    #[test]
    fn reset_keeps_the_view() {
        let mut d = Draft::load(Some(GATE.into()));
        d.to_json_view();
        d.text.push(' ');
        d.reset(Some("{\"a\":1}".into()));
        assert_eq!(d.view, View::Json);
        assert_eq!((d.text.as_str(), d.dirty()), ("{\"a\":1}", false));
    }
}
