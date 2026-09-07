use super::super::llm::ChatMessage;
use super::*;

#[test]
fn credentials_require_persistent_os_storage_without_file_fallback() {
    let mut response = json!({
        "config": {
            "features": {"shell_tool": false, "secret_auth_storage": true},
            "web_search": "disabled",
            "project_doc_max_bytes": 0,
            "skills": {"bundled": {"enabled": false}, "include_instructions": false},
            "forced_login_method": "chatgpt",
            "cli_auth_credentials_store": "keyring"
        },
        "layers": [{"config": {"tools": {
            "update_plan": {"enabled": false},
            "experimental_request_user_input": {"enabled": false}
        }}}]
    });
    assert!(validate_config(&response).is_ok());
    for mode in [
        json!("file"),
        json!("auto"),
        json!("ephemeral"),
        Value::Null,
    ] {
        response["config"]["cli_auth_credentials_store"] = mode;
        assert_eq!(
            validate_config(&response).unwrap_err().code(),
            "codex_tools_unavailable"
        );
    }
    response["config"]["cli_auth_credentials_store"] = json!("keyring");
    for value in [json!(false), Value::Null] {
        response["config"]["features"]["secret_auth_storage"] = value;
        assert_eq!(
            validate_config(&response).unwrap_err().code(),
            "codex_tools_unavailable"
        );
    }
}

#[test]
fn model_catalog_controls_effort_without_expensive_fallback() {
    let m = ModelInfo {
        id: "gpt-5.6-luna".into(),
        display_name: None,
        supported_reasoning_efforts: vec!["low".into(), "none".into()],
        default_reasoning_effort: Some("low".into()),
    };
    assert_eq!(choose_effort(&m, None).unwrap(), "none");
    assert_eq!(choose_effort(&m, Some("low")).unwrap(), "low");
    assert_eq!(
        choose_effort(&m, Some("max")).unwrap_err().code(),
        "codex_effort_invalid"
    );
    let m = ModelInfo {
        supported_reasoning_efforts: vec!["high".into(), "low".into()],
        ..m
    };
    assert_eq!(choose_effort(&m, None).unwrap(), "low");
    assert!(choose_effort(&m, Some("none")).is_err());
}

#[test]
fn only_official_https_login_links_are_accepted() {
    assert!(validate_login_url("https://auth.openai.com/oauth/authorize?state=fixture").is_ok());
    for value in [
        "http://auth.openai.com/",
        "https://auth.openai.com.attacker.invalid/",
        "file:///secret",
        "https://user:pass@auth.openai.com/",
    ] {
        assert!(validate_login_url(value).is_err());
    }
}

#[test]
fn catalog_is_filtered_and_uses_wire_model_name() {
    let result = parse_models(&json!({"data":[
        {"id":"display-id","model":"gpt-5.6-luna","displayName":"Luna","supportedReasoningEfforts":[{"reasoningEffort":"none"}],"defaultReasoningEffort":"none"},
        {"model":"hidden","hidden":true,"supportedReasoningEfforts":[]}
    ]})).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, "gpt-5.6-luna");
    assert_eq!(result[0].supported_reasoning_efforts, ["none"]);
    assert!(parse_models(&json!({"data":[{"model":""}]})).is_err());
}

#[tokio::test]
async fn jsonl_reader_handles_fragmented_utf8_and_rejects_oversize() {
    use tokio::io::{AsyncWriteExt, BufReader};
    let (mut writer, reader) = tokio::io::duplex(1024);
    let mut reader = BufReader::new(reader);
    let task = tokio::spawn(async move {
        let bytes = "{\"delta\":\"你好\"}\n".as_bytes();
        for byte in bytes {
            writer.write_all(&[*byte]).await.unwrap();
        }
    });
    assert_eq!(
        read_frame(&mut reader, 1024).await.unwrap(),
        json!({"delta":"你好"})
    );
    task.await.unwrap();
    let mut bytes = BufReader::new(&b"1234567890\n"[..]);
    assert!(read_frame(&mut bytes, 5).await.is_err());
    let mut bytes = BufReader::new(&b"{}"[..]);
    assert!(read_frame(&mut bytes, 100).await.is_err());
}

#[test]
fn transcript_and_schema_are_bounded_and_tools_never_cross() {
    let req = ChatRequest {
        system_prompt: "Answer only".into(),
        messages: vec![ChatMessage::User {
            content: "hello".into(),
        }],
        tools: vec![],
        model: "gpt-5.6-luna".into(),
        max_tokens: 100,
        output_schema: None,
    };
    assert!(request_text(&req).unwrap().contains("hello"));
    let mut invalid = req.clone();
    invalid.tools.push(super::super::llm::ToolSchema {
        name: "run".into(),
        description: "".into(),
        input_schema: json!({}),
    });
    assert_eq!(
        request_text(&invalid).unwrap_err().code(),
        "codex_tools_unavailable"
    );
    let mut large = req;
    large.system_prompt = "x".repeat(MAX_INPUT_BYTES + 1);
    assert!(request_text(&large).is_err());
}

#[test]
fn runtime_blocks_unexpected_server_actions_and_redacts_error_payloads() {
    assert_eq!(
        protocol_error(&json!({"code":-1,"message":"sensitive fixture"})).code(),
        "codex_request_failed"
    );
    assert!(!protocol_error(&json!({"message":"sensitive fixture"}))
        .to_string()
        .contains("sensitive fixture"));
    assert!(is_tool_item(&json!({"type":"commandExecution"})));
    assert!(is_tool_item(&json!({"type":"fileChange"})));
    assert!(is_tool_item(&json!({"type":"mcpToolCall"})));
    assert!(!is_tool_item(&json!({"type":"agentMessage"})));
}

#[tokio::test]
#[ignore = "requires a local Codex binary; no login or inference"]
async fn installed_runtime_starts_isolated_without_credentials() {
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let root = temp.join(format!("rssh-codex-runtime-{}", uuid::Uuid::new_v4()));
    let runtime = CodexSubscription::new(root.clone());
    let result = runtime.status(None).await;
    if result.is_ok() {
        let id = runtime.process.lock().await.as_ref().unwrap().child.id();
        assert_eq!(
            runtime.models(None).await.unwrap_err().code(),
            "codex_auth_required"
        );
        assert_eq!(
            runtime.process.lock().await.as_ref().unwrap().child.id(),
            id
        );
        let (first, second) = tokio::join!(runtime.status(None), runtime.status(None));
        assert!(
            first.is_ok() && second.is_ok(),
            "concurrent metadata must serialize, not report busy"
        );
    }
    runtime.reset().await.unwrap();
    assert!(!root.join("codex-subscription/auth.json").exists());
    // Only this test's freshly-created UUID directory may be removed.
    assert_eq!(root.parent(), Some(temp.as_path()));
    for _ in 0..40 {
        if !root.exists() || std::fs::remove_dir_all(&root).is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(!root.exists(), "test runtime directory was not released");
    let status = result.unwrap();
    assert!(status.available);
    assert!(!status.authenticated);
    assert!(status.version.is_none());
}

#[test]
fn stream_routes_by_thread_and_turn_and_does_not_duplicate_final_text() {
    use std::sync::{Arc, Mutex};
    let text = Arc::new(Mutex::new(String::new()));
    let captured = text.clone();
    let sink: DeltaSink = Arc::new(move |delta| {
        if let ChatDelta::Text(s) = delta {
            captured.lock().unwrap().push_str(&s);
        }
    });
    let mut output = TurnOutput::new("thread", "turn");
    assert!(output.push(json!({"method":"item/started","params":{"threadId":"other","turnId":"turn","item":{"type":"commandExecution"}}}), &sink).unwrap().is_none());
    output.push(json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"a","delta":"hello"}}), &sink).unwrap();
    assert!(output.push(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"old","status":"completed"}}}), &sink).unwrap().is_none());
    output.push(json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"a","type":"agentMessage","phase":"final_answer","text":"hello"}}}), &sink).unwrap();
    output.push(json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread","turnId":"turn","tokenUsage":{"total":{"inputTokens":123,"outputTokens":45}}}}), &sink).unwrap();
    let answer = output.push(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}), &sink).unwrap().unwrap();
    assert_eq!(answer.text, "hello");
    assert_eq!(answer.tokens_in, Some(123));
    assert_eq!(answer.tokens_out, Some(45));
    assert_eq!(*text.lock().unwrap(), "hello");
    assert!(answer.tool_calls.is_empty());
}

#[test]
fn stream_rejects_tools_errors_and_unbounded_output() {
    let sink: DeltaSink = std::sync::Arc::new(|_| {});
    let mut output = TurnOutput::new("t", "u");
    assert_eq!(output.push(json!({"method":"item/started","params":{"threadId":"t","turnId":"u","item":{"type":"commandExecution"}}}), &sink).unwrap_err().code(), "codex_tools_unavailable");
    let mut output = TurnOutput::new("t", "u");
    assert_eq!(output.push(json!({"method":"error","params":{"threadId":"t","error":{"codexErrorInfo":"usageLimitExceeded","message":"secret"}}}), &sink).unwrap_err().code(), "codex_usage_limit");
    let mut output = TurnOutput::new("t", "u");
    assert_eq!(output.push(json!({"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"a","delta":"x".repeat(MAX_OUTPUT_BYTES+1)}}), &sink).unwrap_err().code(), "codex_output_too_large");
    let mut output = TurnOutput::new("t", "u");
    assert!(output.push(json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"completed"}}}), &sink).is_err());
}

#[test]
fn commentary_is_not_returned_as_final_output() {
    let sink: DeltaSink =
        std::sync::Arc::new(|_| panic!("commentary must not be shown as the answer"));
    let mut output = TurnOutput::new("t", "u");
    output.push(json!({"method":"item/started","params":{"threadId":"t","turnId":"u","item":{"id":"a","type":"agentMessage","phase":"commentary"}}}), &sink).unwrap();
    output.push(json!({"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"a","delta":"I will inspect files"}}), &sink).unwrap();
    output.push(json!({"method":"item/completed","params":{"threadId":"t","turnId":"u","item":{"id":"a","type":"agentMessage","phase":"commentary","text":"I will inspect files"}}}), &sink).unwrap();
    assert!(output.push(json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"completed"}}}), &sink).is_err());
}

#[tokio::test]
async fn relative_home_and_invalid_login_ids_fail_before_starting_a_process() {
    let runtime = CodexSubscription::new(std::path::PathBuf::from("relative"));
    assert_eq!(
        runtime.status(None).await.unwrap_err().code(),
        "codex_request_failed"
    );
    assert_eq!(
        runtime.cancel_login("").await.unwrap_err().code(),
        "codex_request_failed"
    );
    assert!(runtime.process.try_lock().unwrap().is_none());
}

#[test]
fn readiness_requires_a_current_model_and_supported_effort() {
    let models = vec![ModelInfo {
        id: "gpt-5.6-luna".into(),
        display_name: None,
        supported_reasoning_efforts: vec!["none".into(), "low".into()],
        default_reasoning_effort: Some("none".into()),
    }];
    assert!(catalog_supports(&models, "gpt-5.6-luna", Some("none")));
    assert!(catalog_supports(&models, "gpt-5.6-luna", None));
    assert!(!catalog_supports(&models, "", None));
    assert!(!catalog_supports(&models, "gpt-5.6-sol", None));
    assert!(!catalog_supports(&models, "gpt-5.6-luna", Some("high")));
    assert!(!catalog_supports(&[], "gpt-5.6-luna", None));
}
