use super::*;

fn schema() -> Value {
    // Compiled in, so a schema change rebuilds the tests and no absolute path is baked.
    let mut s: Value = serde_json::from_str(include_str!("../protocol/host-protocol.schema.json")).unwrap();
    s.as_object_mut().unwrap().remove("$id");
    s
}

/// Validate `instance` against `$defs[def]` of the generated schema.
fn assert_schema(def: &str, instance: &Value) {
    let mut root = schema();
    root["$ref"] = json!(format!("#/$defs/{def}"));
    let v = jsonschema::validator_for(&root).unwrap();
    let errors: Vec<String> = v.iter_errors(instance).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{def}: {instance} -> {errors:?}");
}

fn assert_envelope(key: &str, frame: &str) {
    let mut root = schema();
    let sub = root[key].clone();
    root.as_object_mut().unwrap().retain(|k, _| k == "$defs" || k == "$schema");
    for (k, v) in sub.as_object().unwrap() {
        root[k] = v.clone();
    }
    let v = jsonschema::validator_for(&root).unwrap();
    let instance: Value = serde_json::from_str(frame.trim_end()).unwrap();
    assert!(v.is_valid(&instance), "{key}: {frame}");
}

/// One params sample per method with every optional field present.
fn samples() -> Vec<(&'static str, Value)> {
    vec![
        ("hello", json!({"protocol": 1, "pid": 42, "hostSessionId": "s1", "piSessionId": "abc", "cwd": "/tmp"})),
        (
            "session.open",
            json!({"argv": ["pi", "--session-id", "x"], "cwd": "/tmp", "env": {"FOO": "1"}, "title": "judge",
                   "role": "judge", "placement": "own-group"}),
        ),
        ("session.list", json!({})),
        ("session.pin", json!({"reason": "orchestration-child"})),
        ("session.close", json!({"target": "session", "hostSessionId": "s2"})),
        ("session.close", json!({"target": "children"})),
        (
            "session.decorate",
            json!({"hostSessionId": "s2", "label": "review@main:r", "colorSeed": "seed", "state": "waiting-judge",
                   "stateAt": 17, "kind": "judge", "repo": "/repo", "piSessionId": "p", "sessionName": "t2-reg"}),
        ),
        ("focus", json!({"hostSessionId": "s2"})),
        ("focus.state", json!({})),
        (
            "notify",
            json!({"kind": "needs-user", "title": "等你回答 · repo", "body": "q", "group": "g", "focusHostSessionId": "s1"}),
        ),
        (
            "dialog.open",
            json!({"shape": "choice", "dialogId": "d1", "title": "问题 1 / 2", "body": "long", "options": ["a", "b"],
                   "declineRow": "✎ 不选，我说明原因", "back": true, "recommended": "a"}),
        ),
        (
            "dialog.open",
            json!({"shape": "multi", "dialogId": "d2", "title": "t", "options": ["a", "b", "c"],
                   "declineRow": "✎", "back": false, "defaultChecked": []}),
        ),
        ("dialog.close", json!({"dialogId": "d1"})),
    ]
}

#[test]
fn constants_match_the_schema() {
    let s = schema();
    assert_eq!(s["x-protocolVersion"], json!(PROTOCOL_VERSION));
    assert_eq!(s["x-maxFrameBytes"], json!(MAX_FRAME_BYTES));
    assert_eq!(s["x-env"], json!({"host": ENV_HOST, "socket": ENV_SOCKET, "hostSession": ENV_SESSION}));
    assert_eq!(s["x-inheritedGateEnv"], json!(INHERITED_GATE_ENV));
    assert_eq!(s["x-methods"], json!(METHODS));
    let codes: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
    assert_eq!(s["x-wireErrorCodes"], json!(codes));
    for shape in s["$defs"]["dialog.open.params"]["oneOf"].as_array().unwrap() {
        assert_eq!(shape["properties"]["options"]["maxItems"], json!(MAX_DIALOG_OPTIONS));
    }
}

#[test]
fn dialog_option_bound_is_the_schema_bound() {
    let with = |n: usize| {
        let options: Vec<String> = (0..n).map(|i| format!("o{i}")).collect();
        json!({"shape": "choice", "dialogId": "d", "title": "t", "options": options, "declineRow": "x", "back": false})
    };
    assert!(decode_params("dialog.open", with(MAX_DIALOG_OPTIONS)).is_ok());
    assert!(decode_params("dialog.open", with(MAX_DIALOG_OPTIONS + 1)).is_err());
}

#[test]
fn every_method_has_a_sample_the_schema_and_the_decoder_accept() {
    let covered: std::collections::BTreeSet<&str> = samples().iter().map(|(m, _)| *m).collect();
    assert_eq!(covered, METHODS.iter().copied().collect());
    for (method, params) in samples() {
        assert_schema(&format!("{method}.params"), &params);
        decode_params(method, params.clone()).unwrap_or_else(|e| panic!("{method} {params}: {e:?}"));
    }
}

#[test]
fn unknown_fields_and_missing_required_fields_are_bad_requests() {
    for (method, params) in samples() {
        let mut extra = params.clone();
        extra["zzUnknown"] = json!(1);
        let err = decode_params(method, extra).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest, "{method} accepted an unknown field");
        for key in params.as_object().unwrap().keys() {
            let def = &schema()["$defs"][format!("{method}.params")];
            let required = def["required"].as_array().cloned().unwrap_or_default();
            if !required.contains(&json!(key)) {
                continue;
            }
            let mut missing = params.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(decode_params(method, missing).is_err(), "{method} without {key}");
        }
    }
}

#[test]
fn bounds_the_schema_states_are_enforced() {
    let bad = [
        ("hello", json!({"protocol": 1, "pid": 42, "hostSessionId": "bad id", "cwd": "/tmp"})),
        ("hello", json!({"protocol": 1, "pid": 42, "hostSessionId": "s", "cwd": "relative"})),
        ("hello", json!({"protocol": 0, "pid": 42, "hostSessionId": "s", "cwd": "/"})),
        (
            "session.open",
            json!({"argv": [], "cwd": "/", "env": {}, "title": "t", "role": "judge", "placement": "own-group"}),
        ),
        (
            "session.open",
            json!({"argv": ["pi"], "cwd": "/", "env": {"RG_HOST_SESSION": "x"}, "title": "t", "role": "judge", "placement": "own-group"}),
        ),
        (
            "session.open",
            json!({"argv": ["pi"], "cwd": "/", "env": {"1BAD": "x"}, "title": "t", "role": "judge", "placement": "own-group"}),
        ),
        (
            "session.open",
            json!({"argv": ["pi"], "cwd": "/", "env": {}, "title": "t", "role": "root", "placement": "own-group"}),
        ),
        ("session.decorate", json!({"hostSessionId": "s", "sessionName": "x"})),
        ("session.decorate", json!({"hostSessionId": "s", "state": "sleeping"})),
        ("notify", json!({"kind": "finished", "title": "", "body": ""})),
        ("notify", json!({"kind": "finished", "title": "t", "body": "x".repeat(301)})),
        (
            "dialog.open",
            json!({"shape": "choice", "dialogId": "d", "title": "t", "options": ["only"], "declineRow": "x", "back": false}),
        ),
        (
            "dialog.open",
            json!({"shape": "choice", "dialogId": "d", "title": "t", "options": ["a", "b"], "declineRow": "x", "back": false, "defaultChecked": []}),
        ),
        ("session.close", json!({"target": "window"})),
    ];
    for (method, params) in bad {
        let err = decode_params(method, params.clone()).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest, "{method} {params}");
    }
}

#[test]
fn session_name_distinguishes_absent_null_and_set() {
    let get = |p: Value| match decode_params("session.decorate", p).unwrap() {
        Request::SessionDecorate(d) => d.session_name,
        _ => unreachable!(),
    };
    assert_eq!(get(json!({"hostSessionId": "s"})), None);
    assert_eq!(get(json!({"hostSessionId": "s", "sessionName": null})), Some(None));
    assert_eq!(get(json!({"hostSessionId": "s", "sessionName": "ab"})), Some(Some("ab".into())));
}

#[test]
fn every_result_shape_matches_the_schema() {
    let entry = |pid| ListEntry {
        host_session_id: "s2".into(),
        parent: Some("s1".into()),
        role: Role::Judge,
        title: "t".into(),
        pid,
        group_pin: None,
    };
    let cases = vec![
        ("hello.result", hello_result()),
        ("session.open.result", open_result("s2", Some(7))),
        ("session.open.result", open_result("s2", None)),
        ("session.list.result", list_result(&[entry(Some(3)), entry(None)])),
        ("session.pin.result", empty_result()),
        ("session.close.result", closed_result(&["s2".into()])),
        ("session.decorate.result", empty_result()),
        ("focus.result", empty_result()),
        ("focus.state.result", focus_state_result(Some("s1"), true)),
        ("focus.state.result", focus_state_result(None, false)),
        ("notify.result", notify_result(false)),
        ("dialog.close.result", empty_result()),
    ];
    for (def, v) in cases {
        assert_schema(def, &v);
    }
    let outcomes = [
        DialogOutcome::Picked { option: "a".into() },
        DialogOutcome::Checked { options: vec![] },
        DialogOutcome::Decline { reason: "".into() },
        DialogOutcome::Back,
        DialogOutcome::Dismissed,
        DialogOutcome::Aborted,
        DialogOutcome::Unavailable,
    ];
    for o in &outcomes {
        assert_schema("dialog.open.result", &dialog_result(o));
    }
}

#[test]
fn response_envelopes_match_the_schema() {
    assert_envelope("x-response", &encode_ok("r-1", empty_result()));
    for code in ErrorCode::ALL {
        let frame = encode_err("r-1", &WireError::new(code, "m".repeat(5000)));
        assert!(frame.ends_with('\n') && !frame[..frame.len() - 1].contains('\n'));
        assert_envelope("x-response", &frame);
    }
    assert_envelope("x-request", r#"{"v":1,"type":"request","id":"r-1","method":"focus","params":{}}"#);
}

#[test]
fn bad_frames_and_frames_without_an_id_are_rejected() {
    let wrong_v = br#"{"v":2,"type":"request","id":"r-9","method":"session.list","params":{}}"#;
    for line in [&b"not json"[..], b"[1]", br#"{"v":1}"#, br#"{"v":1,"id":"bad id"}"#, wrong_v] {
        assert!(matches!(decode_request(line), Decoded::Reject(_)), "{}", String::from_utf8_lossy(line));
    }
}

#[test]
fn envelope_errors_carry_the_id_back() {
    let code = |line: &str| match decode_request(line.as_bytes()) {
        Decoded::Request { id, request } => {
            assert_eq!(id, "r-9");
            request.err().map(|e| e.code)
        }
        Decoded::Reject(r) => panic!("rejected {r}"),
    };
    assert_eq!(code(r#"{"v":1,"type":"request","id":"r-9","method":"session.list","params":{}}"#), None);
    assert_eq!(code(r#"{"v":1,"type":"response","id":"r-9","method":"session.list","params":{}}"#), Some(ErrorCode::BadRequest));
    assert_eq!(
        code(r#"{"v":1,"type":"request","id":"r-9","method":"session.list","params":{},"x":1}"#),
        Some(ErrorCode::BadRequest)
    );
    assert_eq!(code(r#"{"v":1,"type":"request","id":"r-9","method":"session.nuke","params":{}}"#), Some(ErrorCode::UnknownMethod));
}

#[test]
fn child_env_scrubs_rg_keys_but_keeps_inherited_ones() {
    let client = [("PATH", "/bin"), ("RG_ORCHESTRATION_ID", "o"), ("RG_NO_SIDE_EFFECTS", "1"), ("RG_HOST", "tmux")]
        .map(|(k, v)| (k.to_string(), v.to_string()));
    let requested = BTreeMap::from([("RG_STATION_CAP".to_string(), "commit".to_string())]);
    let env = child_env(client, &requested, "/tmp/s.sock", "s3");
    assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
    assert!(!env.contains_key("RG_ORCHESTRATION_ID"));
    assert_eq!(env.get("RG_NO_SIDE_EFFECTS").map(String::as_str), Some("1"));
    assert_eq!(env.get("RG_STATION_CAP").map(String::as_str), Some("commit"));
    assert_eq!(env.get(ENV_HOST).map(String::as_str), Some("desktop"));
    assert_eq!(env.get(ENV_SOCKET).map(String::as_str), Some("/tmp/s.sock"));
    assert_eq!(env.get(ENV_SESSION).map(String::as_str), Some("s3"));
}
