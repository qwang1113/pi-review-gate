//! `--demo`: fake sessions, events, widgets and dialogs pushed through the same
//! hub paths real pi processes and prg use, so every component has a state to
//! screenshot against `docs/desktop/ui-design.md`. Nothing here runs pi.

use crate::hub::{Hub, now_ms};
use crate::protocol::{DecorateParams, DialogParams, PaneState, Role};
use crate::rpc::{Output, Record, UiRequest};
use serde_json::{Value, json};

fn ev(hub: &Hub, id: &str, v: Value) {
    let kind = v["type"].as_str().unwrap_or_default().to_string();
    hub.on_output(id, Output::Record(Record::Event { kind, raw: v }));
}

fn ui(hub: &Hub, id: &str, ui_id: &str, request: UiRequest) {
    hub.on_output(id, Output::Record(Record::UiRequest { id: ui_id.into(), request }));
}

fn widget(hub: &Hub, id: &str, lines: &[&str]) {
    ui(hub, id, "w", UiRequest::SetWidget { key: "review-gate-agents".into(), lines: Some(lines.iter().map(|l| l.to_string()).collect()), placement: "belowEditor".into() });
}

fn status(hub: &Hub, id: &str, key: &str, text: &str) {
    ui(hub, id, "s", UiRequest::SetStatus { key: key.into(), text: Some(text.into()) });
}

/// One `--shots` state.
#[cfg(feature = "shots")]
pub struct Shot {
    pub name: &'static str,
    pub dark: bool,
    pub collapsed: bool,
    /// Narrow window with the overlay sidebar open.
    pub overlay: bool,
    pub select: String,
    pub open: Vec<String>,
    pub reason: Option<&'static str>,
    pub popover: bool,
    /// A gate dialog another party answers first (`dialog.close`) right before the shot.
    pub abort: Option<(String, &'static str)>,
}

fn decorate(hub: &Hub, id: &str, state: PaneState, kind: Option<&str>) {
    let at = now_ms() / 1000 - 42;
    hub.lock().tree.decorate(&DecorateParams { host_session_id: id.into(), state: Some(state), state_at: Some(at), kind: kind.map(str::to_string), ..Default::default() });
}

fn delta(kind: &str, i: usize, text: &str) -> Value {
    json!({"type": "message_update", "assistantMessageEvent": {"type": kind, "contentIndex": i, "delta": text}})
}

fn dialog(hub: &Hub, owner: &str, p: DialogParams) {
    let rx = hub.dialog_open(owner, 0, p).expect("demo dialog");
    // Keep the receiver alive; the answer is printed by the window.
    std::thread::spawn(move || drop(rx.recv()));
}

const MARKDOWN: &str = "# 桌面客户端\n\n门禁的**对话框**现在由客户端按结构渲染。\n\n## 改了什么\n\n- 单选模板：A/B/C 字母、`（推荐）` 标牌\n- 多选清单：`defaultChecked` 预勾\n\n### 代码\n\n```rust\nfn main() {\n    println!(\"hello, pi\");\n}\n```\n";

const PATCH: &str = "--- desktop/src/app.rs\n+++ desktop/src/app.rs\n@@ -12,6 +12,7 @@ use gpui_kit::*;\n use std::sync::Arc;\n-use std::time::Duration;\n+use std::time::{Duration, Instant};\n+use crate::ui::theme::Th;\n \n const VISIBLE_LINES: usize = 400;\n@@ -40,3 +41,3 @@ impl Shell {\n-        let th = 1;\n+        let th = Th { dark: true };\n         th\n";

fn long_body() -> String {
    let mut s = String::from("## 我对需求的理解\n\n在 t4 的内核上，按设计规格实现完整界面。\n\n## 改之前 → 改之后\n\n");
    for i in 1..=40 {
        s.push_str(&format!("{i}. 改之前：原始事件流逐行显示 → 改之后：第 {i} 个组件按设计规格渲染。\n"));
    }
    s
}

/// `--shots <dir>`: walk the demo states and save each as `<dir>/NN-name.png`,
/// rendered by GPUI's own offscreen path, then quit.
#[cfg(feature = "shots")]
pub fn shoot(shell: gpui_kit::Entity<crate::app::Shell>, window: gpui_kit::AnyWindowHandle, dir: std::path::PathBuf, cx: &mut gpui_kit::App) {
    let ids = |hub: &Hub| -> Vec<(String, String)> { hub.lock().tree.all().iter().map(|s| (s.title.clone(), s.id.clone())).collect() };
    let hub = shell.read(cx).hub.clone();
    let all = ids(&hub);
    let id = move |title: &str| all.iter().find(|(t, _)| t == title).map(|(_, i)| i.clone()).unwrap_or_default();
    let (root, rev, t1, t3, worker) = (id("main"), id("reviewer"), id("t1-ui-design"), id("t3-host-factory"), id("worker-1"));
    let (qa, acc, goal, adv) = (id("quality-auditor"), id("acceptance"), id("goal-auditor"), id("adviser"));
    let think = format!("{root}/1/0");
    let shot = |name: &'static str, dark: bool, select: &str| Shot { name, dark, collapsed: false, overlay: false, select: select.to_string(), open: vec![], reason: None, popover: false, abort: None };
    let reason = "状态条的明细应该由 prg 在 widget 里带上。\n客户端不该自己去跑 /gate-status。";
    let steps: Vec<Shot> = vec![
        shot("01-chat-dark", true, &root),
        Shot { open: vec![think.clone(), "tool/c1".into()], ..shot("02-chat-expanded-dark", true, &root) },
        shot("03-drawer-choice-dark", true, &rev),
        Shot { reason: Some(reason), ..shot("04-drawer-reason-dark", true, &rev) },
        shot("05-drawer-multi-dark", true, &t1),
        shot("06-drawer-long-confirm-dark", true, &t3),
        Shot { reason: Some("还差一条：退役 token 要同轮删掉。"), ..shot("07-drawer-long-reason-dark", true, &t3) },
        shot("08-drawer-pi-select-dark", true, &worker),
        shot("09-drawer-pi-input-dark", true, &qa),
        shot("10-drawer-pi-confirm-dark", true, &acc),
        shot("11-drawer-pi-editor-dark", true, &goal),
        Shot { collapsed: true, ..shot("12-sidebar-collapsed-dark", true, &root) },
        Shot { collapsed: true, ..shot("13-sidebar-collapsed-waiting-badge-dark", true, &rev) },
        Shot { overlay: true, ..shot("14-sidebar-overlay-narrow-dark", true, &root) },
        Shot { popover: true, ..shot("15-status-unmet-popover-dark", true, &root) },
        shot("16-status-ansi-dark", true, &adv),
        Shot { abort: Some((adv.clone(), "demo-abort")), ..shot("17-drawer-aborted-toast-dark", true, &adv) },
        Shot { open: vec![think, "tool/c1".into()], ..shot("18-chat-light", false, &root) },
        shot("19-drawer-choice-light", false, &rev),
        shot("20-drawer-multi-light", false, &t1),
        shot("21-drawer-long-confirm-light", false, &t3),
        Shot { collapsed: true, popover: true, ..shot("22-collapsed-popover-light", false, &root) },
        shot("23-status-ansi-light", false, &adv),
    ];
    std::fs::create_dir_all(&dir).expect("shots dir");
    cx.spawn(async move |cx| {
        let exec = cx.background_executor().clone();
        let wait = |ms| exec.timer(std::time::Duration::from_millis(ms));
        wait(1500).await;
        let wide = gpui_kit::size(gpui_kit::px(1280.), gpui_kit::px(800.));
        let narrow = gpui_kit::size(gpui_kit::px(880.), gpui_kit::px(800.));
        for s in steps {
            let name = s.name;
            if let Some((owner, id)) = &s.abort {
                hub.dialog_close(owner, id);
            }
            let _ = window.update(cx, |_, w, _| w.resize(if s.overlay { narrow } else { wide }));
            wait(300).await;
            let _ = window.update(cx, |_, w, cx| shell.update(cx, |sh, cx| sh.demo_state(&s, w, cx)));
            wait(900).await;
            // The window may be occluded (no display-link frames): draw frames ourselves,
            // a few, so enter/reveal animations that start on the first one have finished
            // and layout-dependent readings (the long box's progress) have caught up.
            for _ in 0..3 {
                let _ = window.update(cx, |_, w, cx| {
                    w.refresh();
                    w.draw(cx).clear(cx);
                });
                wait(400).await;
            }
            let _ = window.update(cx, |_, w, _| match w.render_to_image() {
                Ok(img) => img.save(dir.join(format!("{name}.png"))).unwrap_or_else(|e| eprintln!("{name}: {e}")),
                Err(e) => eprintln!("{name}: {e}"),
            });
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

pub fn populate(hub: &Hub, cwd: &str) {
    let root = hub.insert_detached(None, Role::Root, "main", cwd);
    let judges = ["reviewer", "quality-auditor", "acceptance", "goal-auditor", "adviser"];
    let judge_states = [PaneState::Working, PaneState::WaitingJudge, PaneState::Idle, PaneState::Done, PaneState::Idle];
    let mut judge_ids = vec![];
    for (j, st) in judges.iter().zip(judge_states) {
        let id = hub.insert_detached(Some(&root), Role::Judge, j, cwd);
        decorate(hub, &id, st, Some("judge"));
        judge_ids.push(id);
    }
    let worker = hub.insert_detached(Some(&root), Role::Worker, "worker-1", cwd);
    decorate(hub, &worker, PaneState::Working, Some("worker"));
    let t1 = hub.insert_detached(Some(&root), Role::OrchestrationChild, "t1-ui-design", cwd);
    decorate(hub, &t1, PaneState::WaitingInput, Some("child"));
    let t1_rev = hub.insert_detached(Some(&t1), Role::Judge, "reviewer", cwd);
    decorate(hub, &t1_rev, PaneState::Working, Some("judge"));
    let t2 = hub.insert_detached(Some(&root), Role::OrchestrationChild, "t2-host-protocol", cwd);
    hub.lock().tree.mark_dead(&t2);
    let t3 = hub.insert_detached(Some(&root), Role::OrchestrationChild, "t3-host-factory", cwd);
    decorate(hub, &t3, PaneState::Done, Some("child"));
    decorate(hub, &root, PaneState::Working, Some("orchestrator"));

    // Root: the full chat stream, still generating at the end.
    let t = now_ms();
    ev(hub, &root, json!({"type": "agent_start"}));
    ev(hub, &root, json!({"type": "message_start", "message": {"role": "user", "content": "按设计规格把桌面客户端的界面做完，要精致。", "timestamp": t - 90_000}}));
    ev(hub, &root, json!({"type": "message_start", "message": {"role": "assistant", "content": [], "timestamp": t - 80_000}}));
    ev(hub, &root, delta("thinking_delta", 0, "先读 ui-design.md 与 tokens.json，再看 t4 的 hub……"));
    ev(hub, &root, json!({"type": "message_end", "message": {"role": "assistant", "stopReason": "toolUse", "content": [
        {"type": "thinking", "thinking": "先读 ui-design.md 与 tokens.json，再看 t4 的 hub。token 必须从 JSON 读，不写字面色值。"},
        {"type": "text", "text": MARKDOWN},
        {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "git status --porcelain"}},
        {"type": "toolCall", "id": "c2", "name": "edit", "arguments": {"path": "desktop/src/app.rs"}},
        {"type": "toolCall", "id": "c3", "name": "read", "arguments": {"path": "docs/desktop/missing.md"}},
        {"type": "toolCall", "id": "c4", "name": "bash", "arguments": {"command": "cargo test"}},
    ]}}));
    hub.lock().chats.get_mut(&root).map(|c| {
        if let Some(crate::ui::chat_model::Item::Assistant { blocks, .. }) = c.items.last_mut() {
            if let Some(crate::ui::chat_model::Block::Thinking { secs, .. }) = blocks.first_mut() {
                *secs = Some(14);
            }
        }
    });
    ev(hub, &root, json!({"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash", "args": {"command": "git status --porcelain"}}));
    ev(hub, &root, json!({"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash", "isError": false, "result": {"content": [{"type": "text", "text": " M desktop/src/app.rs\n?? desktop/src/ui/"}]}}));
    ev(hub, &root, json!({"type": "tool_execution_start", "toolCallId": "c2", "toolName": "edit", "args": {"path": "desktop/src/app.rs"}}));
    ev(hub, &root, json!({"type": "tool_execution_end", "toolCallId": "c2", "toolName": "edit", "isError": false, "result": {"content": [{"type": "text", "text": "Successfully replaced 2 block(s)."}], "details": {"patch": PATCH}}}));
    ev(hub, &root, json!({"type": "tool_execution_start", "toolCallId": "c3", "toolName": "read", "args": {"path": "docs/desktop/missing.md"}}));
    ev(hub, &root, json!({"type": "tool_execution_end", "toolCallId": "c3", "toolName": "read", "isError": true, "result": {"content": [{"type": "text", "text": "ENOENT: no such file or directory, open 'docs/desktop/missing.md'"}]}}));
    ev(hub, &root, json!({"type": "tool_execution_start", "toolCallId": "c4", "toolName": "bash", "args": {"command": "cargo test"}}));
    ev(hub, &root, json!({"type": "message_start", "message": {"role": "assistant", "content": []}}));
    ev(hub, &root, delta("text_delta", 0, "测试还在跑，我先把**状态条**接上：它读的是 prg 的 `review-gate-agents` widget"));
    widget(hub, &root, &[
        "门禁 · mode orchestrator · feat/desktop-host · 已编辑 · 3 项未满足",
        "· code review gate is PENDING (need READY)",
        "· precommit has not run",
        "· \x1b[33mcopilot review\x1b[0m has not landed on the current head",
    ]);
    // pi extensions paint their `setStatus` texts with ANSI escapes (§9.3).
    status(hub, &root, "ponytail", "\x1b[38;2;138;190;183mponytail\x1b[0m full");

    // Every other session gets a one-line history and its own strip.
    for (id, line) in [
        (&judge_ids[0], "门禁 · mode loop · feat/desktop-host · 未编辑 · 轮 3"),
        (&worker, "门禁 · mode explore · feat/desktop-host · 未编辑"),
        (&t1, "门禁 · mode loop · rg-child-t1 · 已编辑 · 轮 2 · 已关闭 acceptance · 1 项未满足"),
        (&t3, "门禁 · mode loop · rg-child-t3 · 已编辑 · 轮 4"),
        (&judge_ids[4], "门禁 · mode loop · feat/desktop-host · 未编辑 · 0 项未满足"),
    ] {
        ev(hub, id, json!({"type": "message_start", "message": {"role": "user", "content": "开始吧"}}));
        widget(hub, id, &[line]);
    }
    for (key, text) in [
        ("mcp", "\x1b[1;32m●\x1b[22;39m mcp \x1b[2m11 servers\x1b[0m"),
        ("ponytail", "\x1b[38;2;138;190;183mponytail\x1b[0m full"),
        ("model", "\x1b[38;5;208mclaude-fable-5\x1b[0m \x1b[4mmax\x1b[24m"),
        ("ctx", "\x1b[7m 42% \x1b[27m ctx"),
    ] {
        status(hub, &judge_ids[4], key, text);
    }
    // pi's own boxes, one per session (§6.6).
    ui(hub, &judge_ids[1], "native-input", UiRequest::Input { title: "pi 扩展：给这个会话起个名字".into(), placeholder: Some("kebab-case，如 r3-desktop-ui".into()) });
    ui(hub, &judge_ids[2], "native-confirm", UiRequest::Confirm { title: "pi 扩展：确认删除".into(), message: "要删除 `.pi/tmp` 下的 **3 个**缓存文件吗？".into(), timeout: Some(600_000) });
    ui(hub, &judge_ids[3], "native-editor", UiRequest::Editor { title: "pi 扩展：编辑提交说明".into(), prefill: Some("feat(desktop): rebuild the client UI\n\n- drawers replace dialogs\n- sidebar collapses fully".into()) });
    hub.lock().unread.insert(worker.clone());

    // Dialogs, each on its own session so the root chat stays uncovered: single
    // choice (interview 2/3), checklist, long confirm, pi's own select.
    dialog(hub, &judge_ids[0], DialogParams::Choice {
        dialog_id: "demo-choice".into(),
        title: "问题 2 / 3\n状态条的未满足项要不要点开看明细？".into(),
        body: None,
        options: vec!["要，浮层列出每一项".into(), "不要，只显示数量".into(), "等 prg 在 widget 里带上明细再做".into()],
        decline_row: "✎ 不选，我说明原因".into(),
        back: true,
        recommended: Some("等 prg 在 widget 里带上明细再做".into()),
    });
    dialog(hub, &t1, DialogParams::Multi {
        dialog_id: "demo-multi".into(),
        title: "本轮要跑哪些环节？".into(),
        body: None,
        options: vec!["goal".into(), "review".into(), "quality".into(), "acceptance".into(), "precommit".into()],
        decline_row: "✎ 不选，我说明原因".into(),
        back: false,
        default_checked: vec!["goal".into(), "review".into(), "quality".into(), "precommit".into()],
    });
    dialog(hub, &t3, DialogParams::Choice {
        dialog_id: "demo-long".into(),
        title: "review-gate: 这是 AI 对需求的反述——理解对了吗？".into(),
        body: Some(long_body()),
        options: vec!["对，就是这样".into(), "不对，我来补充".into()],
        decline_row: "✎ 不选，我说明原因".into(),
        back: false,
        recommended: Some("对，就是这样".into()),
    });
    ui(hub, &worker, "native-1", UiRequest::Select { title: "pi 扩展：选择一个模型".into(), options: vec!["claude-fable-5".into(), "claude-opus-5".into()], timeout: None });
    // Answered first by the project manager in shot 17 (`dialog.close` ⇒ aborted, §6.1).
    dialog(hub, &judge_ids[4], DialogParams::Choice {
        dialog_id: "demo-abort".into(),
        title: "要不要把退役 token 同轮删掉？".into(),
        body: None,
        options: vec!["要".into(), "不要".into()],
        decline_row: "✎ 不选，我说明原因".into(),
        back: false,
        recommended: Some("要".into()),
    });
    hub.set_focused(Some(root));
}
