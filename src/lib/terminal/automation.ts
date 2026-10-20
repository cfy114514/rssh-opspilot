/** Bounded, in-memory output journal. Cursors are scoped to a transport session. */
export function createTerminalOutputJournal(limit = 262_144) {
  let chunks: { cursor: number; text: string }[] = [];
  let cursor = 0;
  let size = 0;
  let droppedThrough = 0;
  let decoder = new TextDecoder();
  return {
    reset() {
      chunks = [];
      cursor = size = droppedThrough = 0;
      decoder = new TextDecoder();
    },
    append(bytes: Uint8Array) {
      const text = decoder.decode(bytes, { stream: true });
      if (!text) return;
      const item = { cursor: ++cursor, text: text.slice(-limit) };
      if (text.length > limit) droppedThrough = item.cursor;
      chunks.push(item);
      size += item.text.length;
      while ((size > limit || chunks.length > 1024) && chunks.length > 1) {
        const removed = chunks.shift()!;
        size -= removed.text.length;
        droppedThrough = removed.cursor;
      }
    },
    read(after?: number) {
      return {
        cursor,
        truncated: after !== undefined && after < droppedThrough,
        reset: after !== undefined && after > cursor,
        chunks: after === undefined ? [] : chunks.filter(c => c.cursor > after),
      };
    },
  };
}

interface TerminalBuffer {
  type: string;
  length: number;
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/** Read the parsed active buffer, including alternate-screen TUIs and Unicode. */
export function readAutomationScreen(
  terminal: { cols: number; rows: number; buffer: { active: TerminalBuffer } },
  count = 100,
) {
  const buffer = terminal.buffer.active;
  const startLine = Math.max(0, buffer.length - Math.max(1, Math.min(500, count)));
  const lines: string[] = [];
  let remaining = 131_072;
  for (let i = buffer.length - 1; i >= startLine && remaining > 0; i--) {
    const text = (buffer.getLine(i)?.translateToString(true) ?? "").slice(0, remaining);
    remaining -= text.length + 1;
    lines.unshift(text);
  }
  return {
    cols: terminal.cols, rows: terminal.rows, buffer: buffer.type,
    startLine: buffer.length - lines.length,
    cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
    viewportY: buffer.viewportY,
    screen: lines.join("\n"),
    truncated: remaining <= 0,
  };
}

export interface AutomationReadOptions { lines?: number; after?: number }
export interface AutomationWriteOptions {
  sessionId: string;
  text: string;
  raw: boolean;
  expiresAt: number;
  isAllowed(): boolean;
}

export interface AutomationTerminal {
  read(options: AutomationReadOptions): unknown;
  write(options: AutomationWriteOptions): Promise<void>;
}

export const TERMINAL_KEYS: Record<string, string> = {
  Enter: "\r", "Ctrl+C": "\x03", "Ctrl+D": "\x04", "Ctrl+Z": "\x1a",
  Tab: "\t", Escape: "\x1b", Backspace: "\x7f",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
};

export interface AutomationRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}

export interface SharedTerminal {
  sessionId: string;
  tabId: string;
  label: string;
  type: string;
}

/** Validate at the execution boundary as well as in the MCP schema. */
export async function executeTerminalRequest(
  request: AutomationRequest,
  access: {
    sessions(): SharedTerminal[];
    terminal(tabId: string): AutomationTerminal | undefined;
    writable: boolean;
    active(): boolean;
  },
): Promise<unknown> {
  if (!access.active() || Date.now() >= request.expiresAt) throw new Error("Terminal access stopped or request expired");
  if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) throw new Error("Invalid arguments");
  const args = request.arguments;
  if (request.name === "list_terminals") return { terminals: access.sessions(), writable: access.writable };
  const session = access.sessions().find(s => s.sessionId === args.sessionId);
  if (!session) throw new Error("Terminal session is not shared or has disconnected. Reconnecting requires sharing again.");
  const terminal = access.terminal(session.tabId);
  if (!terminal) throw new Error("Terminal is unavailable");
  if (request.name === "read_terminal") {
    if (args.lines !== undefined && (!Number.isInteger(args.lines) || (args.lines as number) < 1 || (args.lines as number) > 500)) throw new Error("lines must be an integer from 1 to 500");
    if (args.after !== undefined && (!Number.isSafeInteger(args.after) || (args.after as number) < 0)) throw new Error("after must be a nonnegative cursor");
    return { sessionId: session.sessionId, ...terminal.read(args as AutomationReadOptions) as object };
  }
  if (!access.writable) throw new Error("Terminal access is read-only");
  let text: string;
  let raw = false;
  if (request.name === "write_terminal") {
    if (typeof args.text !== "string" || !args.text || new TextEncoder().encode(args.text).length > 8192) throw new Error("text must contain 1 to 8192 UTF-8 bytes");
    if (args.enter !== undefined && typeof args.enter !== "boolean") throw new Error("enter must be a boolean");
    text = args.text + (args.enter === true ? "\r" : "");
  } else if (request.name === "send_key") {
    if (typeof args.key !== "string" || !Object.prototype.hasOwnProperty.call(TERMINAL_KEYS, args.key)) throw new Error("Unsupported terminal key");
    text = TERMINAL_KEYS[args.key];
    // Enter respects the transport's EOL; control bytes remain unmodified.
    raw = args.key !== "Enter";
  } else {
    throw new Error("Unknown terminal tool");
  }
  await terminal.write({
    sessionId: session.sessionId, text, raw, expiresAt: request.expiresAt,
    isAllowed: () => access.active() && access.sessions().some(s => s.sessionId === session.sessionId),
  });
  return { sessionId: session.sessionId, delivered: true, commandCompleted: false };
}
