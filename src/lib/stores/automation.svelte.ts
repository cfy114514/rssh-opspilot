import { invoke } from "@tauri-apps/api/core";
import * as app from "./app.svelte.ts";
import { executeTerminalRequest, type AutomationRequest } from "../terminal/automation.ts";

interface ConnectionInfo { bridgeId: string; endpoint: string; token: string }
interface Status { connection: ConnectionInfo; writable: boolean }
let _connection = $state<ConnectionInfo | null>(null);
let _writable = $state(false);
let _busy = $state(false);
let _error = $state<unknown>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let monitoring = false;
let running = false;

export function connection() { return _connection; }
export function writable() { return _writable; }
export function busy() { return _busy; }
export function error() { return _error; }
export function sharedSessions() { return _connection ? app.connectedSessions() : []; }

/** Every window joins the active bridge, including windows opened after enablement. */
export function beginMonitoring() {
  if (monitoring || app.isMobile) return;
  monitoring = true;
  void poll();
}
export function endMonitoring() {
  monitoring = false;
  ++generation;
  clearTimeout(timer);
  _connection = null;
  _writable = false;
}

export async function start(allowInput: boolean) {
  if (_busy || app.isMobile) return;
  _busy = true;
  _error = null;
  const current = ++generation;
  try {
    const info = await invoke<ConnectionInfo>("automation_start", { writable: allowInput });
    if (current !== generation) {
      await invoke("automation_stop", { bridgeId: info.bridgeId });
      return;
    }
    _connection = info;
    _writable = allowInput;
    if (!monitoring) monitoring = true;
    clearTimeout(timer);
    void poll();
  } catch (error) {
    _error = error;
    throw error;
  } finally { _busy = false; }
}

async function poll() {
  if (!monitoring || running) return;
  running = true;
  const current = generation;
  try {
    const status = await invoke<Status | null>("automation_status");
    if (!monitoring || generation !== current) return;
    _connection = status?.connection ?? null;
    _writable = status?.writable ?? false;
    if (!status) return;
    const id = status.connection.bridgeId;
    const requests = await invoke<AutomationRequest[]>("automation_poll", { bridgeId: id, sessions: app.connectedSessions() });
    for (const request of requests) void execute(request, id, current);

  } catch (error) {
    if (monitoring && generation === current) {
      _error = error;
      _connection = null;
      _writable = false;
    }
  } finally {
    running = false;
    if (monitoring) timer = setTimeout(() => void poll(), 150);
  }
}

async function execute(request: AutomationRequest, id: string, current: number) {
  const active = () => monitoring && generation === current && _connection?.bridgeId === id;
  if (!active()) return;
  let result: unknown;
  let isError = false;
  try {
    result = await executeTerminalRequest(request, {
      sessions: sharedSessions, terminal: app.automationTerminal, writable: _writable, active,
    });
  } catch (error) {
    isError = true;
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  if (!active()) return;
  try { await invoke("automation_reply", { bridgeId: id, reply: { id: request.id, result, isError } }); }
  catch (error) { if (active()) _error = error; }
}

export async function stop() {
  ++generation;
  clearTimeout(timer);
  const bridgeId = _connection?.bridgeId;
  _connection = null;
  _writable = false;
  try { if (bridgeId) await invoke("automation_stop", { bridgeId }); }
  finally { if (monitoring && !running) timer = setTimeout(() => void poll(), 150); }
}

/** Explicit handoff data; never persisted to settings, sync, or localStorage. */
export function connectionConfig() {
  if (!_connection) return "";
  return JSON.stringify({ transport: "streamable-http", url: _connection.endpoint,
    headers: { Authorization: `Bearer ${_connection.token}` } }, null, 2);
}
