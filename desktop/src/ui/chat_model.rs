//! A session's conversation, folded from pi's RPC event stream (`json.md`):
//! user messages, assistant text/thinking blocks, tool calls with their results.
//! Pure — `apply` takes the event and the clock — so every rule is a unit test.
//! An event this fold does not know is ignored, never an error.

use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    /// The model is still writing the call's arguments.
    Pending,
    Running,
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
    pub status: ToolStatus,
    pub result: String,
    /// `details.patch` of an `edit` result: a unified diff.
    pub patch: Option<String>,
    pub started_ms: Option<u64>,
    pub ended_ms: Option<u64>,
}

impl ToolCall {
    /// The one-line argument summary on the card header (plain text).
    pub fn summary(&self) -> String {
        let pick = ["command", "path", "file_path", "pattern", "query", "url"].iter().find_map(|k| self.args.get(*k).and_then(Value::as_str));
        let s = match pick {
            Some(s) => s.to_string(),
            None if self.args.is_null() => String::new(),
            None => self.args.to_string(),
        };
        s.lines().next().unwrap_or("").to_string()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text { text: String, streaming: bool },
    Thinking { text: String, streaming: bool, started_ms: u64, secs: Option<u64> },
    /// Key into `Chat::tools`.
    Tool(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User { text: String, ts_ms: u64 },
    Assistant { blocks: Vec<Block>, ts_ms: u64, streaming: bool },
    /// A run-level fact worth a line in the stream (errors, retries, compaction).
    Notice { text: String, error: bool },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Chat {
    pub items: Vec<Item>,
    pub tools: HashMap<String, ToolCall>,
    /// Between `agent_start` and `agent_end`/`agent_settled`.
    pub running: bool,
    /// Bumped on every visible change (unread marks, auto-follow).
    pub rev: u64,
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

impl Chat {
    fn current(&mut self) -> Option<&mut Vec<Block>> {
        match self.items.last_mut() {
            Some(Item::Assistant { blocks, streaming: true, .. }) => Some(blocks),
            _ => None,
        }
    }

    fn block(&mut self, index: usize, make: impl FnOnce() -> Block) -> Option<&mut Block> {
        let blocks = self.current()?;
        while blocks.len() <= index {
            blocks.push(Block::Text { text: String::new(), streaming: false });
        }
        if matches!(&blocks[index], Block::Text { text, streaming: false } if text.is_empty()) {
            blocks[index] = make();
        }
        Some(&mut blocks[index])
    }

    fn tool(&mut self, id: &str, name: &str) -> &mut ToolCall {
        self.tools.entry(id.to_string()).or_insert_with(|| ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            args: Value::Null,
            status: ToolStatus::Pending,
            result: String::new(),
            patch: None,
            started_ms: None,
            ended_ms: None,
        })
    }

    pub fn push_user(&mut self, text: String, ts_ms: u64) {
        self.items.push(Item::User { text, ts_ms });
        self.rev += 1;
    }

    pub fn apply(&mut self, kind: &str, ev: &Value, now_ms: u64) {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match kind {
            "agent_start" => self.running = true,
            "agent_end" | "agent_settled" => {
                self.running = false;
                self.finish_streaming(now_ms);
            }
            "message_start" => {
                let m = &ev["message"];
                let ts = m["timestamp"].as_u64().unwrap_or(now_ms);
                match m["role"].as_str() {
                    Some("user") => self.push_user(text_of(&m["content"]), ts),
                    Some("assistant") => self.items.push(Item::Assistant { blocks: vec![], ts_ms: ts, streaming: true }),
                    _ => return,
                }
            }
            "message_update" => return self.apply_delta(&ev["assistantMessageEvent"], now_ms),
            "message_end" => {
                let m = &ev["message"];
                if m["role"].as_str() != Some("assistant") {
                    return;
                }
                self.end_assistant(m, now_ms);
            }
            "tool_execution_start" => {
                let t = self.tool(&s(ev, "toolCallId"), &s(ev, "toolName"));
                t.args = ev["args"].clone();
                t.status = ToolStatus::Running;
                t.started_ms = Some(now_ms);
            }
            "tool_execution_update" => {
                let text = text_of(&ev["partialResult"]["content"]);
                self.tool(&s(ev, "toolCallId"), &s(ev, "toolName")).result = text;
            }
            "tool_execution_end" => {
                let t = self.tool(&s(ev, "toolCallId"), &s(ev, "toolName"));
                t.status = if ev["isError"].as_bool() == Some(true) { ToolStatus::Error } else { ToolStatus::Ok };
                t.result = text_of(&ev["result"]["content"]);
                t.patch = ev["result"]["details"]["patch"].as_str().map(str::to_string);
                t.started_ms.get_or_insert(now_ms);
                t.ended_ms = Some(now_ms);
            }
            "auto_retry_start" => self.items.push(Item::Notice {
                text: format!("重试 {}/{}：{}", ev["attempt"], ev["maxAttempts"], s(ev, "errorMessage")),
                error: true,
            }),
            "compaction_start" => self.items.push(Item::Notice { text: "正在压缩上下文…".into(), error: false }),
            "extension_error" => self.items.push(Item::Notice { text: format!("扩展出错：{}", s(ev, "error")), error: true }),
            _ => return,
        }
        self.rev += 1;
    }

    fn apply_delta(&mut self, e: &Value, now_ms: u64) {
        if self.current().is_none() {
            return;
        }
        let idx = e["contentIndex"].as_u64().unwrap_or(0) as usize;
        let delta = e["delta"].as_str().unwrap_or("");
        match e["type"].as_str().unwrap_or("") {
            "text_start" | "text_delta" => {
                if let Some(Block::Text { text, streaming }) = self.block(idx, || Block::Text { text: String::new(), streaming: true }) {
                    text.push_str(delta);
                    *streaming = true;
                }
            }
            "text_end" => {
                if let Some(Block::Text { text, streaming }) = self.block(idx, || Block::Text { text: String::new(), streaming: false }) {
                    if let Some(c) = e["content"].as_str() {
                        *text = c.to_string();
                    }
                    *streaming = false;
                }
            }
            "thinking_start" | "thinking_delta" => {
                let make = || Block::Thinking { text: String::new(), streaming: true, started_ms: now_ms, secs: None };
                if let Some(Block::Thinking { text, .. }) = self.block(idx, make) {
                    text.push_str(delta);
                }
            }
            "thinking_end" => {
                let make = || Block::Thinking { text: String::new(), streaming: true, started_ms: now_ms, secs: None };
                if let Some(Block::Thinking { text, streaming, started_ms, secs }) = self.block(idx, make) {
                    if let Some(c) = e["content"].as_str() {
                        *text = c.to_string();
                    }
                    *streaming = false;
                    *secs = Some(now_ms.saturating_sub(*started_ms) / 1000);
                }
            }
            "toolcall_start" | "toolcall_end" => {
                let call = &e["toolCall"];
                let id = e["id"].as_str().or(call["id"].as_str()).unwrap_or("").to_string();
                let name = e["toolName"].as_str().or(call["name"].as_str()).unwrap_or("").to_string();
                if id.is_empty() {
                    return;
                }
                let args = call.get("arguments").cloned();
                let t = self.tool(&id, &name);
                if let Some(a) = args {
                    t.args = a;
                }
                self.block(idx, || Block::Tool(id));
            }
            _ => return,
        }
        self.rev += 1;
    }

    /// `message_end` is authoritative: rebuild the blocks from its content, keeping
    /// thinking timings the stream measured.
    fn end_assistant(&mut self, m: &Value, now_ms: u64) {
        if !matches!(self.items.last(), Some(Item::Assistant { streaming: true, .. })) {
            self.items.push(Item::Assistant { blocks: vec![], ts_ms: m["timestamp"].as_u64().unwrap_or(now_ms), streaming: true });
        }
        let old = self.current().map(std::mem::take).unwrap_or_default();
        let mut blocks = vec![];
        for (i, part) in m["content"].as_array().into_iter().flatten().enumerate() {
            let b = match part["type"].as_str() {
                Some("text") => Block::Text { text: part["text"].as_str().unwrap_or("").into(), streaming: false },
                Some("thinking") => {
                    let (started_ms, secs) = match old.get(i) {
                        Some(Block::Thinking { started_ms, secs, .. }) => (*started_ms, secs.or(Some(now_ms.saturating_sub(*started_ms) / 1000))),
                        _ => (now_ms, None),
                    };
                    Block::Thinking { text: part["thinking"].as_str().unwrap_or("").into(), streaming: false, started_ms, secs }
                }
                Some("toolCall") => {
                    let id = part["id"].as_str().unwrap_or("").to_string();
                    let t = self.tool(&id, part["name"].as_str().unwrap_or(""));
                    t.args = part["arguments"].clone();
                    Block::Tool(id)
                }
                _ => continue,
            };
            blocks.push(b);
        }
        if let Some(Item::Assistant { blocks: slot, streaming, .. }) = self.items.last_mut() {
            *slot = blocks;
            *streaming = false;
        }
        if let (Some("error" | "aborted"), Some(msg)) = (m["stopReason"].as_str(), m["errorMessage"].as_str()) {
            self.items.push(Item::Notice { text: msg.to_string(), error: true });
        }
    }

    fn finish_streaming(&mut self, now_ms: u64) {
        for item in &mut self.items {
            if let Item::Assistant { blocks, streaming, .. } = item {
                *streaming = false;
                for b in blocks {
                    match b {
                        Block::Text { streaming, .. } => *streaming = false,
                        Block::Thinking { streaming, started_ms, secs, .. } => {
                            *streaming = false;
                            secs.get_or_insert(now_ms.saturating_sub(*started_ms) / 1000);
                        }
                        Block::Tool(_) => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed(chat: &mut Chat, events: &[(Value, u64)]) {
        for (e, t) in events {
            chat.apply(e["type"].as_str().unwrap(), e, *t);
        }
    }

    fn upd(e: Value) -> Value {
        json!({"type": "message_update", "assistantMessageEvent": e})
    }

    #[test]
    fn streams_text_and_thinking_then_message_end_is_authoritative() {
        let mut c = Chat::default();
        feed(&mut c, &[
            (json!({"type":"agent_start"}), 0),
            (json!({"type":"message_start","message":{"role":"user","content":"hi","timestamp":5}}), 0),
            (json!({"type":"message_start","message":{"role":"assistant","content":[]}}), 1000),
            (upd(json!({"type":"thinking_start","contentIndex":0})), 1000),
            (upd(json!({"type":"thinking_delta","contentIndex":0,"delta":"hmm"})), 2000),
            (upd(json!({"type":"thinking_end","contentIndex":0,"content":"hmm."})), 15000),
            (upd(json!({"type":"text_delta","contentIndex":1,"delta":"Hel"})), 15000),
            (upd(json!({"type":"text_delta","contentIndex":1,"delta":"lo"})), 15100),
        ]);
        assert!(c.running && matches!(c.items.last(), Some(Item::Assistant { streaming: true, .. })));
        assert_eq!(c.items[0], Item::User { text: "hi".into(), ts_ms: 5 });
        let Item::Assistant { blocks, .. } = &c.items[1] else { panic!() };
        assert_eq!(blocks[0], Block::Thinking { text: "hmm.".into(), streaming: false, started_ms: 1000, secs: Some(14) });
        assert_eq!(blocks[1], Block::Text { text: "Hello".into(), streaming: true });

        feed(&mut c, &[
            (json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm."},{"type":"text","text":"Hello!"}],"stopReason":"stop"}}), 16000),
            (json!({"type":"agent_end","messages":[]}), 16000),
        ]);
        let Item::Assistant { blocks, streaming, .. } = &c.items[1] else { panic!() };
        assert!(!streaming && !c.running);
        assert_eq!(blocks[1], Block::Text { text: "Hello!".into(), streaming: false });
        assert!(matches!(blocks[0], Block::Thinking { secs: Some(14), .. }));
    }

    #[test]
    fn tool_lifecycle_ok_and_error() {
        let mut c = Chat::default();
        feed(&mut c, &[
            (json!({"type":"message_start","message":{"role":"assistant","content":[]}}), 0),
            (upd(json!({"type":"toolcall_start","contentIndex":0,"id":"t1","toolName":"bash"})), 0),
            (upd(json!({"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"git status\nmore"}}})), 10),
            (json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"git status\nmore"}}]}}), 20),
            (json!({"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"git status\nmore"}}), 100),
        ]);
        assert_eq!(c.tools["t1"].status, ToolStatus::Running);
        assert_eq!(c.tools["t1"].summary(), "git status");
        feed(&mut c, &[(json!({"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"clean"}]},"isError":false}), 242)]);
        let t = &c.tools["t1"];
        assert_eq!((t.status, t.result.as_str(), t.ended_ms.unwrap() - t.started_ms.unwrap()), (ToolStatus::Ok, "clean", 142));
        let Item::Assistant { blocks, .. } = &c.items[0] else { panic!() };
        assert_eq!(blocks, &vec![Block::Tool("t1".into())]);

        feed(&mut c, &[(json!({"type":"tool_execution_end","toolCallId":"t2","toolName":"edit","result":{"content":[{"type":"text","text":"no match"}],"details":{"patch":"@@ -1 +1 @@\n-a\n+b\n"}},"isError":true}), 300)]);
        assert_eq!(c.tools["t2"].status, ToolStatus::Error);
        assert!(c.tools["t2"].patch.is_some());
    }

    #[test]
    fn unknown_events_and_orphan_deltas_are_ignored() {
        let mut c = Chat::default();
        c.apply("brand_new_event", &json!({"type":"brand_new_event"}), 0);
        c.apply("message_update", &upd(json!({"type":"text_delta","contentIndex":0,"delta":"x"})), 0);
        c.apply("message_start", &json!({"type":"message_start","message":{"role":"toolResult"}}), 0);
        assert!(c.items.is_empty() && c.rev == 0);
    }

    #[test]
    fn aborted_stream_is_closed_by_agent_end_and_errors_become_notices() {
        let mut c = Chat::default();
        feed(&mut c, &[
            (json!({"type":"message_start","message":{"role":"assistant","content":[]}}), 0),
            (upd(json!({"type":"thinking_delta","contentIndex":0,"delta":"a"})), 0),
            (json!({"type":"agent_end","messages":[]}), 3000),
        ]);
        let Item::Assistant { blocks, streaming, .. } = &c.items[0] else { panic!() };
        assert!(!streaming);
        assert!(matches!(blocks[0], Block::Thinking { streaming: false, secs: Some(3), .. }));
        c.apply("message_end", &json!({"message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"429"}}), 4000);
        assert_eq!(c.items.last(), Some(&Item::Notice { text: "429".into(), error: true }));
    }
}
