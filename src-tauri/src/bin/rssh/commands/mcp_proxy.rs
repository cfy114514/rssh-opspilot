//! Stdio-to-Streamable-HTTP adapter for local MCP clients. stdout is reserved
//! for JSON-RPC; discovery credentials never appear in command arguments.
#[cfg(unix)]
mod unix {
    use rssh_lib::automation_discovery::{self, DiscoveryInfo};
    use serde_json::{json, Value};
    use std::io::{self, BufRead, Read, Write};
    use std::time::Duration;

    const MAX_MESSAGE: usize = 1024 * 1024;
    fn valid_endpoint(info: &DiscoveryInfo) -> bool {
        let Ok(url) = reqwest::Url::parse(&info.endpoint) else {
            return false;
        };
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.path() == "/mcp"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && !info.token.is_empty()
            && info.token.len() <= 256
    }

    async fn request(
        client: &reqwest::Client,
        info: &DiscoveryInfo,
        session: Option<&str>,
        body: &Value,
    ) -> Result<(Option<String>, Option<Value>), ()> {
        if !valid_endpoint(info) {
            return Err(());
        }
        let mut req = client
            .post(&info.endpoint)
            .bearer_auth(&info.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-03-26")
            .json(body);
        if let Some(id) = session {
            req = req.header("mcp-session-id", id);
        }
        let mut response = req.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if bytes.len() + chunk.len() > MAX_MESSAGE {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok((id, None));
        }
        let parsed = serde_json::from_slice(&bytes).map_err(|_| ())?;
        Ok((id, Some(parsed)))
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()?;
        let mut selected: Option<DiscoveryInfo> = None;
        let mut session = None;
        let stdin = io::stdin();
        let mut stdout = io::stdout().lock();
        let mut input = stdin.lock();
        loop {
            let mut line = Vec::new();
            let n = (&mut input)
                .take((MAX_MESSAGE + 1) as u64)
                .read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            if line.len() > MAX_MESSAGE {
                return Err("MCP request too large".into());
            }
            let Ok(body) = serde_json::from_slice::<Value>(&line) else {
                return Err("Invalid MCP JSON".into());
            };
            let method = body.get("method").and_then(Value::as_str);
            let result = if selected.is_none() && method == Some("initialize") {
                let infos = automation_discovery::candidates().unwrap_or_default();
                let mut found = None;
                for info in infos {
                    if let Ok((sid, response)) =
                        runtime.block_on(request(&client, &info, None, &body))
                    {
                        if response.as_ref().and_then(|r| r.get("result")).is_some() {
                            session = sid;
                            selected = Some(info);
                            found = response;
                            break;
                        }
                    }
                }
                found.map(Some).ok_or(())
            } else if let Some(ref info) = selected {
                runtime
                    .block_on(request(&client, info, session.as_deref(), &body))
                    .map(|(_, response)| response)
            } else {
                Err(())
            };
            if let Some(id) = body.get("id") {
                let response = match result {
                    Ok(Some(response)) => response,
                    _ => {
                        json!({"jsonrpc":"2.0", "id": id, "error": {"code": -32000, "message": "RSSH MCP access is unavailable. Enable it in RSSH and restart the client; input delivery may be uncertain."}})
                    }
                };
                serde_json::to_writer(&mut stdout, &response)?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn info(endpoint: &str) -> DiscoveryInfo {
            DiscoveryInfo {
                bridge_id: uuid::Uuid::new_v4().to_string(),
                endpoint: endpoint.into(),
                token: "secret".into(),
            }
        }
        #[tokio::test]
        async fn forwards_requests_and_stops_when_listener_is_revoked() {
            use axum::{extract::Request, http::StatusCode, routing::post, Router};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = Router::new().route(
                "/mcp",
                post(|req: Request| async move {
                    if req
                        .headers()
                        .get("authorization")
                        .and_then(|h| h.to_str().ok())
                        != Some("Bearer secret")
                    {
                        return (StatusCode::UNAUTHORIZED, "");
                    }
                    (
                        StatusCode::OK,
                        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
                    )
                }),
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let bridge = info(&format!("http://{address}/mcp"));
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let (_, response) = request(
                &client,
                &bridge,
                None,
                &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            )
            .await
            .unwrap();
            assert_eq!(response.unwrap()["result"]["ok"], true);
            server.abort();
            let _ = server.await;
            assert!(request(
                &client,
                &bridge,
                None,
                &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
            )
            .await
            .is_err());
        }

        #[test]
        fn only_accepts_loopback_mcp_endpoints() {
            assert!(valid_endpoint(&info("http://127.0.0.1:1234/mcp")));
            for url in [
                "http://localhost:1234/mcp",
                "https://127.0.0.1:1234/mcp",
                "http://127.0.0.2:1234/mcp",
                "http://127.0.0.1:1234/mcp?x=1",
                "http://user@127.0.0.1:1234/mcp",
                "http://127.0.0.1:1234/other",
            ] {
                assert!(!valid_endpoint(&info(url)), "{url}");
            }
        }
    }
}

#[cfg(unix)]
pub use unix::run;
#[cfg(not(unix))]
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    Err("MCP discovery is supported on Linux and macOS only".into())
}
