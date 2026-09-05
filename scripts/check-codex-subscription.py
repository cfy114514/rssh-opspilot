"""Offline wire check for the pinned Codex runtime. No login, real API or secrets.

Run: python scripts/check-codex-subscription.py --codex /absolute/path/to/codex
The fake Responses endpoint must receive exactly one request with zero tools.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--effort", choices=["none","minimal","low","medium","high","xhigh","max","ultra"], default="none")
    args = parser.parse_args()
    import re
    assert re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", args.model)
    binary = Path(args.codex).resolve(strict=True)
    assert subprocess.check_output([str(binary), "--version"], text=True).strip() == "codex-cli 0.153.2", "Unvalidated Codex version"
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            size = int(self.headers.get("content-length", "0"))
            assert 0 < size < 2 * 1024 * 1024
            request = json.loads(self.rfile.read(size))
            requests.append(request)
            item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "OK", "annotations": []}]}
            events = [
                {"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
                {"type": "response.output_text.delta", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "delta": "OK"},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed", "output": [item],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
            ]
            payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="rssh-codex-wire-") as folder:
            root = Path(folder)
            home, work, user = [root / x for x in ("home", "empty", "user")]
            for path in (home, work, user):
                path.mkdir()
            profile = (Path(__file__).resolve().parents[1] / "src-tauri/src/ai/codex_subscription.toml").read_text()
            # Use the exact production tool restrictions, but never read subscription credentials.
            profile = profile.replace('model_provider = "openai"', 'model_provider = "rssh_mock"\nmodel = ' + json.dumps(args.model))
            profile = profile.replace('cli_auth_credentials_store = "keyring"', 'cli_auth_credentials_store = "ephemeral"')
            profile += f'\n[model_providers.rssh_mock]\nname="Local wire check"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n'
            (home / "config.toml").write_text(profile)
            env = {k: os.environ[k] for k in ("SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA") if k in os.environ}
            env.update(CODEX_HOME=str(home), HOME=str(user), USERPROFILE=str(user))
            process = subprocess.Popen([str(binary), "app-server"], cwd=work, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            incoming = queue.Queue()
            def reader():
                for line in process.stdout:
                    incoming.put(json.loads(line))
                incoming.put({"eof": True})
            threading.Thread(target=reader, daemon=True).start()

            def send(request_id, method, params=None):
                value = {"method": method}
                if params is not None:
                    value["params"] = params
                if request_id is not None:
                    value["id"] = request_id
                process.stdin.write(json.dumps(value) + "\n")
                process.stdin.flush()

            def receive(request_id=None):
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    message = incoming.get(timeout=max(0.1, deadline - time.monotonic()))
                    assert not message.get("eof"), "App server exited"
                    assert not ("method" in message and "id" in message), "Unexpected server action"
                    if request_id is not None and message.get("id") == request_id:
                        assert "error" not in message, "App server rejected wire check"
                        return message["result"]
                    if request_id is None and message.get("method") == "turn/completed":
                        return message["params"]["turn"]
                raise TimeoutError("App server did not finish")

            try:
                send(1, "initialize", {"clientInfo": {"name": "rssh_wire_check", "version": "0.1.0"}, "capabilities": {}})
                receive(1)
                send(None, "initialized")
                send(2, "thread/start", {"model": args.model, "modelProvider": "rssh_mock", "ephemeral": True,
                    "cwd": str(work), "approvalPolicy": "never", "sandbox": "read-only",
                    "baseInstructions": "Return text only.", "developerInstructions": "No tools."})
                thread = receive(2)["thread"]
                assert thread["ephemeral"] is True
                send(3, "turn/start", {"threadId": thread["id"], "model": args.model, "effort": args.effort,
                    "input": [{"type": "text", "text": "Reply OK."}]})
                receive(3)
                assert receive()["status"] == "completed"
                send(4, "thread/unsubscribe", {"threadId": thread["id"]})
                receive(4)
                assert len(requests) == 1, "Unexpected inference replay"
                assert requests[0].get("tools", []) == [], "A tool was offered to the model"
                print("PASS: pinned runtime, ephemeral turn, one LOCAL request, zero tools; no account or API used")
            finally:
                process.kill()
                process.wait(timeout=5)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
