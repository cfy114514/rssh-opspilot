import { describe, expect, it, vi } from "vitest";
import { createTerminalOutputJournal, executeTerminalRequest, prepareAutomationInput, readAutomationScreen, type AutomationRequest, type AutomationWriteOptions } from "./automation.ts";

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

  it("preserves the loss boundary when an oversized chunk evicts older output", () => {
    const journal = createTerminalOutputJournal(5);
    journal.append(new TextEncoder().encode("old"));
    const previousCursor = journal.read().cursor;
    journal.append(new TextEncoder().encode("123456789"));
    expect(journal.read(previousCursor)).toEqual({
      cursor: 2, truncated: true, reset: false,
      chunks: [{ cursor: 2, text: "56789" }],
    });
    expect(journal.read(2)).toMatchObject({ truncated: false, chunks: [] });
    journal.append(new TextEncoder().encode("!"));
    expect(journal.read(2)).toMatchObject({ truncated: false, chunks: [{ cursor: 3, text: "!" }] });
  });
});

describe("automation transport input", () => {
  it.each([
    ["del", "\x7f"],
    ["bs", "\x08"],
    ["csi3", "\x1b[3~"],
  ])("honors the serial/Telnet %s Backspace mode", async (backspace, expected) => {
    const f = fixture();
    f.write.mockImplementation(async options => {
      const text = prepareAutomationInput(options, { inputNewline: "crlf", backspace }, false);
      expect(Array.from(new TextEncoder().encode(text))).toEqual(Array.from(new TextEncoder().encode(expected)));
    });
    await executeTerminalRequest(f.request("send_key", { key: "Backspace" }), f.access);
    expect(f.write).toHaveBeenCalledOnce();
  });

  it.each([["cr", "\r"], ["lf", "\n"], ["crlf", "\r\n"]])("preserves %s Enter normalization", (inputNewline, expected) => {
    expect(prepareAutomationInput({ text: "\r", raw: false }, { inputNewline, backspace: "bs" }, false)).toBe(expected);
  });

  it("keeps other control bytes and literal text unchanged", () => {
    const stream = { inputNewline: "cr", backspace: "bs" };
    for (const text of ["\x03", "\x04", "\x1a", "\t", "\x1b"]) {
      expect(prepareAutomationInput({ text, raw: true }, stream, false)).toBe(text);
    }
    expect(prepareAutomationInput({ text: "literal\x7f", raw: false }, stream, false)).toBe("literal\x7f");
    expect(prepareAutomationInput({ text: "\x7f", raw: true }, null, false)).toBe("\x7f");
  });

  it("preserves application cursor-key encoding", () => {
    for (const direction of ["A", "B", "C", "D"]) {
      const options = { text: `\x1b[${direction}`, raw: true };
      expect(prepareAutomationInput(options, null, false)).toBe(options.text);
      expect(prepareAutomationInput(options, null, true)).toBe(`\x1bO${direction}`);
    }
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
