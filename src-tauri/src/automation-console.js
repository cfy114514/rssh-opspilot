/* This page uses the same MCP tools as external clients, never a second shell. */
"use strict";
const byId = id => document.getElementById(id);
const select = byId("terminal");
const status = byId("status");
const token = new URLSearchParams(location.hash.slice(1)).get("token");
// Credentials never enter query strings, referrers, localStorage, or server logs.
history.replaceState(null, "", location.pathname);
let sequence = 0;
let writable = false;
let refreshing = false;
let refreshPending = false;
let submitting = false;
let interaction = 0;
let stopped = false;

async function rpc(method, params) {
  if (!token || stopped) throw new Error("Access stopped. Reopen this console from RSSH. / 请从 RSSH 重新打开控制台。");
  let response;
  try { response = await fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(12000),
  }); } catch (error) { stopped = true; throw error; }
  if (!response.ok) {
    stopped = true;
    throw new Error(`Access unavailable (${response.status}). Reopen from RSSH. / 请从 RSSH 重新开启接入。`);
  }
  const message = await response.json();
  if (message.error) throw new Error(message.error.message);
  return message.result;
}

async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(result.structuredContent?.error || result.content?.map(c => c.text || "").join("\n") || "Terminal request failed");
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function controls() {
  select.disabled = submitting || stopped;
  const disabled = submitting || stopped || !writable || !select.value;
  byId("text").disabled = disabled;
  byId("send").disabled = disabled;
  byId("keys").querySelectorAll("button").forEach(button => { button.disabled = disabled; });
}

async function refresh() {
  if (stopped) return;
  if (refreshing || submitting) { refreshPending = true; return; }
  refreshing = true;
  refreshPending = false;
  const revision = interaction;
  try {
    const { terminals, writable: canWrite } = await tool("list_terminals");
    if (stopped) return;
    const previous = select.value;
    select.replaceChildren(...terminals.map(session => {
      const option = document.createElement("option");
      option.value = session.sessionId;
      option.textContent = `${session.label} · ${session.type}`;
      return option;
    }));
    if (terminals.some(t => t.sessionId === previous)) select.value = previous;
    writable = canWrite;
    controls();
    if (revision !== interaction) { refreshPending = true; return; }
    if (!select.value) {
      byId("screen").textContent = "No shared sessions / 没有共享的会话";
      status.textContent = "Select and share a session in RSSH / 请在 RSSH 中选择共享会话";
      return;
    }
    const sessionId = select.value;
    const result = await tool("read_terminal", { sessionId, lines: 150 });
    // A read started before input or a selection change must not replace newer state.
    if (stopped || revision !== interaction || sessionId !== select.value) return;
    byId("screen").textContent = result.screen;
    status.textContent = `${writable ? "Input enabled / 已允许输入" : "Read-only / 只读"} · ${result.cols}×${result.rows} · ${result.buffer} · cursor ${result.output.cursor}`;
  } catch (error) {
    if (stopped || revision === interaction) status.textContent = error.message;
  } finally {
    refreshing = false;
    controls();
    if (refreshPending && !submitting && !stopped) void refresh();
  }
}

async function input(name, args) {
  if (submitting || stopped || !writable || !select.value) return;
  const sessionId = select.value;
  submitting = true;
  interaction++;
  controls();
  try {
    await tool(name, { sessionId, ...args });
    if (name === "write_terminal") byId("text").value = "";
    if (!stopped) status.textContent = "Input delivered; observing output / 输入已送达，正在读取输出";
  } catch (error) {
    status.textContent = `${error.message}\nDo not retry uncertain input automatically. / 输入结果不确定时请先检查终端，不要自动重试。`;
  } finally { submitting = false; controls(); }
  // Do not replay input on errors; the next read observes what actually happened.
  setTimeout(refresh, 200);
}

byId("command").addEventListener("submit", event => {
  event.preventDefault();
  const text = byId("text").value;
  if (text) void input("write_terminal", { text, enter: true });
});
byId("keys").addEventListener("click", event => {
  const key = event.target.closest("button")?.dataset.key;
  if (key) void input("send_key", { key });
});
byId("refresh").addEventListener("click", refresh);
select.addEventListener("change", () => { interaction++; void refresh(); });

async function start() {
  try {
    await rpc("initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "rssh-browser-console", version: "1" },
    });
    await refresh();
    const tick = async () => {
      if (stopped) { controls(); return; }
      if (byId("auto").checked) await refresh();
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  } catch (error) { stopped = true; status.textContent = error.message; controls(); }
}
void start();
