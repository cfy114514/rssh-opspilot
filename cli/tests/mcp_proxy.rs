#![cfg(any(unix, windows))]
use rssh_core::automation_discovery::{publish_at, DiscoveryInfo, Registration};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::thread::JoinHandle;
use std::time::Duration;

const PROTOCOL: &str = "2025-03-26";

fn request(socket: &mut TcpStream, token: &str) -> (String, Value) {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(socket);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line.to_ascii_lowercase());
    }
    assert!(headers.contains(&format!("authorization: bearer {token}\r\n")));
    let length: usize = headers
        .lines()
        .find_map(|s| s.strip_prefix("content-length: "))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    (headers, serde_json::from_slice(&body).unwrap())
}

fn start(
    dir: &Path,
    token: &'static str,
    label: &'static str,
    simulate_loss: bool,
    stateful: bool,
) -> (Registration, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let registration = publish_at(
        dir,
        &DiscoveryInfo {
            bridge_id: uuid::Uuid::new_v4().to_string(),
            endpoint,
            token: token.into(),
        },
    )
    .unwrap();
    let server = std::thread::spawn(move || {
        let methods: &[&str] = if stateful {
            &["initialize", "notifications/initialized", "tools/call"]
        } else {
            &["initialize", "tools/call"]
        };
        for &method in methods {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, rpc) = request(&mut socket, token);
            assert_eq!(rpc["method"], method);
            if method != "initialize" {
                assert_eq!(
                    headers.contains("mcp-session-id: test-session\r\n"),
                    stateful
                );
            }
            if method == "notifications/initialized" {
                write!(
                    socket,
                    "HTTP/1.1 202 Accepted\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"
                )
                .unwrap();
                continue;
            }
            if method == "tools/call" && simulate_loss {
                // Simulate disconnect *after* input arrived. The proxy must
                // surface uncertain delivery rather than repeat it.
                return;
            }
            let result = if method == "initialize" {
                assert_eq!(rpc["params"]["protocolVersion"], PROTOCOL);
                json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"0.1"}})
            } else {
                json!({"content":[{"type":"text","text":label}]})
            };
            let body = json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}).to_string();
            let session_header = if stateful {
                "mcp-session-id: test-session\r\n"
            } else {
                ""
            };
            write!(socket,"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n{session_header}content-length: {}\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    (registration, server)
}

fn rpc(stdin: &mut ChildStdin, stdout: &mut BufReader<ChildStdout>, msg: Value) -> Value {
    writeln!(stdin, "{msg}").unwrap();
    let mut line = String::new();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let out: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(out["id"], msg["id"]);
    out
}

#[test]
fn stdio_starts_offline_reconnects_after_revocation_and_never_replays_input() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join(".rssh/mcp-discovery");
    let mut child = Command::new(env!("CARGO_BIN_EXE_rssh-cli"))
        .arg("mcp-proxy")
        .env("RSSH_MCP_DISCOVERY_DIR", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let initialize = rpc(
        &mut stdin,
        &mut stdout,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":PROTOCOL}}),
    );
    assert_eq!(initialize["result"]["protocolVersion"], PROTOCOL);
    writeln!(
        stdin,
        "{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}}"
    )
    .unwrap();
    let tools = rpc(
        &mut stdin,
        &mut stdout,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    );
    assert!(tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "list_terminals"));
    let list = |id| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"list_terminals","arguments":{}}});
    assert_eq!(
        rpc(&mut stdin, &mut stdout, list(3))["error"]["code"],
        -32000
    );
    let (first, server) = start(&dir, "first-token", "first", false, true);
    assert_eq!(
        rpc(&mut stdin, &mut stdout, list(4))["result"]["content"][0]["text"],
        "first"
    );
    server.join().unwrap();
    drop(first);
    assert_eq!(
        rpc(&mut stdin, &mut stdout, list(5))["error"]["code"],
        -32000
    );
    let (second, server) = start(&dir, "second-token", "second", true, false);
    let write = json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"write_terminal","arguments":{"sessionId":"fixture","text":"test"}}});
    assert_eq!(rpc(&mut stdin, &mut stdout, write)["error"]["code"], -32001);
    server.join().unwrap();
    drop(second);
    let (third, server) = start(&dir, "third-token", "third", false, false);
    assert_eq!(
        rpc(&mut stdin, &mut stdout, list(7))["result"]["content"][0]["text"],
        "third"
    );
    server.join().unwrap();
    drop(third);
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
