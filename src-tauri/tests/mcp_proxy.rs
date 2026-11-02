#![cfg(all(feature = "cli", unix))]
use rssh_lib::automation_discovery::{publish_at, DiscoveryInfo};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

#[test]
fn stdio_discovers_live_bridge_and_reports_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join(".rssh/mcp-discovery");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let registration = publish_at(
        &dir,
        &DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint,
            token: "isolated-test-token".into(),
        },
    )
    .unwrap();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buf[..n]);
                if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length: usize = header
                        .lines()
                        .find_map(|s| s.strip_prefix("content-length: "))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        assert!(header.contains("authorization: bearer isolated-test-token"));
                        break;
                    }
                }
            }
            let body = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\nmcp-session-id: test-session\r\ncontent-length: {}\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_rssh-cli"))
        .arg("mcp-proxy")
        .env("HOME", temp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize"})
    )
    .unwrap();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["result"]["ok"],
        true
    );
    line.clear();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
    )
    .unwrap();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("result"));
    server.join().unwrap();
    drop(registration);
    line.clear();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})
    )
    .unwrap();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains("unavailable"));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
