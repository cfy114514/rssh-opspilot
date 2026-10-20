import { invoke } from "@tauri-apps/api/core";
import * as app from "./app.svelte.ts";
import { executeTerminalRequest, type AutomationRequest } from "../terminal/automation.ts";

interface ConnectionInfo { bridgeId: string; endpoint: string; token: string }
let _connection = $state<ConnectionInfo | null>(null);
let _writable = $state(false);
let _busy = $state(false);
let _error = $state<unknown>(null);
let grants = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

export function connection() { return _connection; }
export function writable() { return _writable; }
export function busy() { return _busy; }
export function error() { return _error; }
export function sharedSessions() {
  return app.connectedSessions().filter(s => grants.has(s.sessionId));
}

export async function start(sessionIds: string[], allowInput: boolean) {
  if (_busy || app.isMobile) return;
  if (!sessionIds.length) throw new Error("Select a terminal session");
  _busy = true;
  _error = null;
  const current = ++generation;
  try {
    clearTimeout(timer);
    _connection = null;
    grants = new Set(sessionIds);
    _writable = allowInput;
    const info = await invoke<ConnectionInfo>("automation_start", { writable: allowInput });
    if (current !== generation) {
      await invoke("automation_stop");
      return;
    }
    _connection = info;
    void poll(info, current);
  } catch (error) {
    grants.clear();
    _error = error;
    throw error;
  } finally {
    _busy = false;
  }
}

async function poll(info: ConnectionInfo, current: number) {
  const active = () => generation === current && _connection?.bridgeId === info.bridgeId;
  try {
    if (!active()) return;
    const requests = await invoke<AutomationRequest[]>("automation_poll", { bridgeId: info.bridgeId });
    for (const request of requests) {
      if (!active()) break;
      let result: unknown;
      let isError = false;
      try {
        result = await executeTerminalRequest(request, {
          sessions: sharedSessions,
          terminal: app.automationTerminal,
          writable: _writable,
          active,
        });
      } catch (error) {
        isError = true;
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      if (!active()) break;
      await invoke("automation_reply", { bridgeId: info.bridgeId, reply: { id: request.id, result, isError } });
    }
    if (active()) timer = setTimeout(() => void poll(info, current), 150);
  } catch (error) {
    if (active()) {
      _error = error;
      try { await stop(); } catch (stopError) { console.warn("[automation] stop failed", stopError); }
    }
  }
}

export async function stop() {
  ++generation;
  clearTimeout(timer);
  _connection = null;
  grants.clear();
  _writable = false;
  await invoke("automation_stop");
}

/** Explicit handoff data; never persisted to settings, sync, or localStorage. */
export function connectionConfig() {
  if (!_connection) return "";
  return JSON.stringify({
    transport: "streamable-http",
    url: _connection.endpoint,
    headers: { Authorization: `Bearer ${_connection.token}` },
  }, null, 2);
}
