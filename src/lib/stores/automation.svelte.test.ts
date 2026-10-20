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

beforeEach(async () => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.sessions.mockReturnValue([session]);
  mocks.terminal.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "automation_start") return info;
    if (command === "automation_poll") return new Promise(resolve => { deliver = resolve; });
    return null;
  });
  store = await import("./automation.svelte.ts");
});

afterEach(async () => { await store.stop(); });

describe("external terminal grant lifetime", () => {
  it("shares only selected transport IDs and does not grant replacements after reconnect", async () => {
    mocks.sessions.mockReturnValue([session, { ...session, sessionId: "unselected" }]);
    await store.start([session.sessionId], false);
    expect(store.sharedSessions()).toEqual([session]);
    expect(store.writable()).toBe(false);
    mocks.sessions.mockReturnValue([{ ...session, sessionId: "replacement" }]);
    expect(store.sharedSessions()).toEqual([]);
    await store.stop();
    expect(store.connection()).toBe(null);
    expect(store.connectionConfig()).toBe("");
  });

  it("discards queued input arriving after access is revoked", async () => {
    const write = vi.fn(async () => {});
    mocks.terminal.mockReturnValue({ read: () => ({}), write });
    await store.start([session.sessionId], true);
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
    const starting = store.start([session.sessionId], true);
    await store.stop();
    finishStart(info);
    await starting;
    expect(store.connection()).toBe(null);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "automation_stop")).toHaveLength(2);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "automation_poll")).toEqual([]);
  });
});
