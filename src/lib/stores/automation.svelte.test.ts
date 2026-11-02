import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sessions: vi.fn(),
  terminal: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./app.svelte.ts", () => ({
  isMobile: false,
  connectedSessions: mocks.sessions,
  automationTerminal: mocks.terminal,
}));

const info = { bridgeId: "bridge-1", endpoint: "http://127.0.0.1:1234/mcp", token: "temporary-token" };
const session = { sessionId: "session-1", tabId: "tab-1", label: "host", type: "local" };
let store: typeof import("./automation.svelte.ts");
let deliver: (requests: unknown[]) => void;
let active: { connection: typeof info; writable: boolean } | null;

beforeEach(async () => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.sessions.mockReturnValue([session]);
  mocks.terminal.mockReset();
  active = null;
  mocks.invoke.mockImplementation(async (command: string, args?: { writable?: boolean }) => {
    if (command === "automation_start") { active = { connection: info, writable: !!args?.writable }; return info; }
    if (command === "automation_status") return active;
    if (command === "automation_stop") { active = null; return null; }
    if (command === "automation_poll") return new Promise(resolve => { deliver = resolve; });
    return null;
  });
  store = await import("./automation.svelte.ts");
});

afterEach(async () => { store.endMonitoring(); await store.stop(); });

describe("external terminal grant lifetime", () => {
  it("shares connected and newly opened or reconnected terminals while enabled", async () => {
    mocks.sessions.mockReturnValue([session, { ...session, sessionId: "unselected" }]);
    await store.start(false);
    expect(store.sharedSessions()).toHaveLength(2);
    expect(store.writable()).toBe(false);
    mocks.sessions.mockReturnValue([{ ...session, sessionId: "replacement" }]);
    expect(store.sharedSessions()).toEqual([{ ...session, sessionId: "replacement" }]);
    await store.stop();
    expect(store.connection()).toBe(null);
    expect(store.connectionConfig()).toBe("");
  });

  it("joins a bridge enabled by another window", async () => {
    active = { connection: info, writable: true };
    store.beginMonitoring();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.connection()).toEqual(info);
    expect(store.writable()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("automation_poll", { bridgeId: info.bridgeId, sessions: [session] });
  });

  it("discards queued input arriving after access is revoked", async () => {
    const write = vi.fn(async () => {});
    mocks.terminal.mockReturnValue({ read: () => ({}), write });
    await store.start(true);
    await Promise.resolve();
    await Promise.resolve();
    await store.stop();
    deliver([{
      id: "late-input", name: "write_terminal", arguments: { sessionId: session.sessionId, text: "id" }, expiresAt: Date.now() + 1000,
    }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "automation_reply")).toEqual([]);
  });

  it("closes an endpoint that finishes starting after the window stops access", async () => {
    let finishStart!: (value: unknown) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === "automation_start"
      ? new Promise(resolve => { finishStart = resolve; }) : null);
    const starting = store.start(true);
    await store.stop();
    finishStart(info);
    await starting;
    expect(store.connection()).toBe(null);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "automation_stop")).toEqual([["automation_stop", { bridgeId: info.bridgeId }]]);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "automation_poll")).toEqual([]);
  });
});
