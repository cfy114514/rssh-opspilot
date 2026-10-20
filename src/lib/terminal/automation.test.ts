import { describe, expect, it, vi } from "vitest";
import { createTerminalOutputJournal, executeTerminalRequest, readAutomationScreen, type AutomationRequest, type AutomationWriteOptions } from "./automation.ts";

describe("terminal output journal", () => {
  it("decodes split UTF-8 and reads only output after a cursor", () => {
    const journal = createTerminalOutputJournal();
    const bytes = new TextEncoder().encode("中");
    journal.append(bytes.slice(0, 1));
    expect(journal.read().cursor).toBe(0);
    journal.append(bytes.slice(1));
    const initial = journal.read(0);
    expect(initial.chunks.map(c => c.text).join("")).toBe("中");
    journal.append(new TextEncoder().encode("next"));
    expect(journal.read(initial.cursor).chunks.map(c => c.text).join("")).toBe("next");
  });

  it("bounds memory and reports output loss and obsolete cursors", () => {
    const journal = createTerminalOutputJournal(5);
    journal.append(new TextEncoder().encode("first"));
    journal.append(new TextEncoder().encode("second"));
    expect(journal.read(0)).toMatchObject({ cursor: 2, truncated: true });
    expect(journal.read(0).chunks).toEqual([{ cursor: 2, text: "econd" }]);
    journal.reset();
    expect(journal.read(2)).toMatchObject({ cursor: 0, reset: true, chunks: [] });
  });
});

describe("parsed terminal screen", () => {
  it("reads the active alternate buffer independently of the user's scroll position", () => {
    const terminal = {
      cols: 80, rows: 2,
      buffer: { active: {
        type: "alternate", length: 4, baseY: 2, viewportY: 0, cursorX: 3, cursorY: 1,
        getLine: (i: number) => ({ translateToString: () => ["old", "history", "你好", "prompt"][i] }),
      } },
    };
    expect(readAutomationScreen(terminal, 2)).toMatchObject({
      screen: "你好\nprompt", startLine: 2, cursor: { x: 3, y: 3 }, buffer: "alternate", viewportY: 0,
    });
  });
});

function fixture() {
  const write = vi.fn(async (_options: AutomationWriteOptions) => {});
  let active = true;
  let sessionId = "session-1";
  const access = {
    sessions: () => [{ sessionId, tabId: "tab-1", label: "host", type: "ssh" }],
    terminal: () => ({ read: () => ({ screen: "$ " }), write }),
    writable: true,
    active: () => active,
  };
  const request = (name: string, args: Record<string, unknown> = {}): AutomationRequest => ({
    id: "request", name, arguments: { sessionId: "session-1", ...args }, expiresAt: Date.now() + 5000,
  });
  return { access, write, request, revoke: () => { active = false; }, reconnect: () => { sessionId = "session-2"; } };
}

describe("terminal operation boundary", () => {
  it("rejects input to unshared, reconnected, expired, or read-only sessions", async () => {
    const f = fixture();
    f.access.writable = false;
    await expect(executeTerminalRequest(f.request("write_terminal", { text: "id" }), f.access)).rejects.toThrow("read-only");
    f.access.writable = true;
    f.reconnect();
    await expect(executeTerminalRequest(f.request("send_key", { key: "Enter" }), f.access)).rejects.toThrow("not shared");
    f.revoke();
    await expect(executeTerminalRequest(f.request("list_terminals"), f.access)).rejects.toThrow("stopped");
    expect(f.write).not.toHaveBeenCalled();
    const g = fixture();
    const expired = { ...g.request("write_terminal", { text: "id" }), expiresAt: 0 };
    await expect(executeTerminalRequest(expired, g.access)).rejects.toThrow("expired");
    expect(g.write).not.toHaveBeenCalled();
  });

  it("awaits delivery, supports Enter and Ctrl+C, and keeps revocation live during writes", async () => {
    const f = fixture();
    const result = await executeTerminalRequest(f.request("write_terminal", { text: "pwd", enter: true }), f.access);
    expect(result).toMatchObject({ delivered: true, commandCompleted: false });
    const options = f.write.mock.calls[0]?.[0] as unknown as { text: string; raw: boolean; isAllowed(): boolean };
    expect(options).toMatchObject({ text: "pwd\r", raw: false });
    expect(options.isAllowed()).toBe(true);
    await executeTerminalRequest(f.request("send_key", { key: "Ctrl+C" }), f.access);
    expect(f.write).toHaveBeenLastCalledWith(expect.objectContaining({ text: "\x03", raw: true }));
    f.revoke();
    expect(options.isAllowed()).toBe(false);
  });

  it("surfaces delivery failures and rejects malformed text and cursor arguments", async () => {
    const f = fixture();
    f.write.mockRejectedValueOnce(new Error("transport closed"));
    await expect(executeTerminalRequest(f.request("write_terminal", { text: "id" }), f.access)).rejects.toThrow("transport closed");
    for (const args of [{ text: "" }, { text: "中".repeat(3000) }, { text: "id", enter: "true" }]) {
      await expect(executeTerminalRequest(f.request("write_terminal", args), f.access)).rejects.toThrow();
    }
    for (const args of [{ lines: 501 }, { lines: 1.5 }, { after: -1 }]) {
      await expect(executeTerminalRequest(f.request("read_terminal", args), f.access)).rejects.toThrow();
    }
    await expect(executeTerminalRequest(f.request("send_key", { key: "__proto__" }), f.access)).rejects.toThrow("Unsupported");
  });
});
