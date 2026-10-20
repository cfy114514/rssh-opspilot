/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import consoleSource from "../../../src-tauri/src/automation-console.js?raw";

type ConsoleEvent = { target: Element; preventDefault(): void };

// This synthetic DOM deliberately blurs disabled controls, matching the browser
// behavior that made the real console lose keyboard input on every polling tick.
class Element {
  value = "";
  checked = false;
  textContent = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  private isDisabled = false;
  private listeners = new Map<string, ((event: ConsoleEvent) => unknown)[]>();

  constructor(
    readonly tag: string,
    private document: { activeElement: Element | null },
  ) {}

  get disabled() { return this.isDisabled; }
  set disabled(value: boolean) {
    this.isDisabled = value;
    if (value && this.document.activeElement === this) this.document.activeElement = null;
  }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  replaceChildren(...children: Element[]) {
    this.children = children;
    if (this.tag === "select") this.value = children[0]?.value ?? "";
  }
  querySelectorAll() { return this.children; }
  closest() { return this.tag === "button" ? this : null; }
  addEventListener(name: string, listener: (event: ConsoleEvent) => unknown) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  dispatch(name: string, target: Element = this) {
    let prevented = false;
    for (const listener of this.listeners.get(name) ?? []) {
      void listener({ target, preventDefault: () => { prevented = true; } });
    }
    return prevented;
  }
}

type Request = {
  name: string;
  args: Record<string, unknown>;
  settled: boolean;
  resolve(response: unknown): void;
  reject(error: Error): void;
};

const terminals = [
  { sessionId: "session-a", label: "First", type: "ssh" },
  { sessionId: "session-b", label: "Second", type: "local" },
];
const screen = (text: string) => ({
  screen: text, cols: 80, rows: 24, buffer: "normal", output: { cursor: 1 },
});

async function flush() {
  // Fetch, JSON decoding, RPC, tool, and event handlers each await a promise.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fixture() {
  const document = { activeElement: null as Element | null };
  const elements = Object.fromEntries(
    ["terminal", "status", "text", "send", "keys", "screen", "command", "refresh", "auto"]
      .map(id => [id, new Element(id === "terminal" ? "select" : "input", document)]),
  );
  elements.text.disabled = elements.send.disabled = true;
  elements.auto.checked = true;
  elements.keys.children = ["Enter", "Ctrl+C"].map(key => {
    const button = new Element("button", document);
    button.dataset.key = key;
    button.disabled = true;
    return button;
  });
  const requests: Request[] = [];
  const timers: { callback(): unknown; delay: number }[] = [];

  // Execute the exact shipped source with injected browser boundaries, not a
  // copied implementation. No browser runtime or network is needed.
  new Function("document", "location", "history", "fetch", "AbortSignal", "setTimeout", consoleSource)(
    { ...document, get activeElement() { return document.activeElement; },
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => new Element(tag, document),
    },
    { hash: "#token=test-token", pathname: "/console" },
    { replaceState() {} },
    (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return new Promise((resolve, reject) => {
        requests.push({
          name: body.params?.name ?? body.method,
          args: body.params?.arguments ?? {},
          settled: false, resolve, reject,
        });
      });
    },
    { timeout: () => undefined },
    (callback: () => unknown, delay: number) => { timers.push({ callback, delay }); },
  );

  function pending(name: string) {
    const request = requests.find(request => request.name === name && !request.settled);
    if (!request) throw new Error(`No pending ${name} request`);
    return request;
  }
  async function reply(name: string, result: unknown) {
    const request = pending(name);
    request.settled = true;
    request.resolve({ ok: true, json: async () => ({
      result: name === "initialize" ? result : { structuredContent: result },
    }) });
    await flush();
  }
  async function error(name: string, message: string, transport = false) {
    const request = pending(name);
    request.settled = true;
    if (transport) request.reject(new Error(message));
    else request.resolve({ ok: true, json: async () => ({
      result: { isError: true, structuredContent: { error: message } },
    }) });
    await flush();
  }
  async function timer(delay: number) {
    const index = timers.findIndex(timer => timer.delay === delay);
    if (index === -1) throw new Error(`No ${delay}ms timer scheduled`);
    void timers.splice(index, 1)[0].callback();
    await flush();
  }
  async function ready(writable = true) {
    await reply("initialize", {});
    await reply("list_terminals", { terminals, writable });
    await reply("read_terminal", screen("initial output"));
  }
  function submit(text: string) {
    elements.text.value = text;
    expect(elements.command.dispatch("submit")).toBe(true);
  }
  return { elements, document, requests, pending, reply, error, timer, ready, submit };
}

describe("standalone automation console", () => {
  it("keeps the focused command field enabled throughout automatic list and screen reads", async () => {
    const f = fixture();
    await f.ready();
    f.elements.text.value = "echo draft";
    f.elements.text.focus();

    await f.timer(1000);
    expect(f.pending("list_terminals")).toBeDefined();
    expect(f.elements.text.disabled).toBe(false);
    expect(f.elements.send.disabled).toBe(false);
    expect(f.document.activeElement).toBe(f.elements.text);
    await f.reply("list_terminals", { terminals, writable: true });
    expect(f.pending("read_terminal")).toBeDefined();
    expect(f.document.activeElement).toBe(f.elements.text);
    expect(f.elements.keys.children.every(button => !button.disabled)).toBe(true);
    await f.reply("read_terminal", screen("updated output"));

    expect(f.elements.text.disabled).toBe(false);
    expect(f.document.activeElement).toBe(f.elements.text);
    expect(f.elements.text.value).toBe("echo draft");
    expect(f.elements.screen.textContent).toBe("updated output");
  });

  it("accepts Enter while polling and retains a single mutation until its response arrives", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    await f.reply("list_terminals", { terminals, writable: true });
    f.submit("pwd");
    expect(f.pending("write_terminal").args).toEqual({
      sessionId: "session-a", text: "pwd", enter: true,
    });
    f.elements.command.dispatch("submit");
    f.elements.keys.dispatch("click", f.elements.keys.children[0]);
    expect(f.requests.filter(request => request.name === "write_terminal")).toHaveLength(1);
    expect(f.requests.filter(request => request.name === "send_key")).toHaveLength(0);

    await f.reply("read_terminal", screen("stale pre-input output"));
    expect(f.elements.text.disabled).toBe(true);
    expect(f.elements.send.disabled).toBe(true);
    expect(f.elements.terminal.disabled).toBe(true);
    expect(f.elements.keys.children.every(button => button.disabled)).toBe(true);
    expect(f.elements.screen.textContent).toBe("initial output");
    await f.reply("write_terminal", { delivered: true });
    expect(f.elements.text.disabled).toBe(false);
    expect(f.elements.text.value).toBe("");
    await f.timer(200);
    await f.reply("list_terminals", { terminals, writable: true });
    await f.reply("read_terminal", screen("post-input output"));
    expect(f.elements.screen.textContent).toBe("post-input output");
    expect(f.requests.filter(request => request.name === "write_terminal")).toHaveLength(1);
  });

  it("accepts a key during a pending list read without unlocking it on refresh completion", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    f.elements.keys.dispatch("click", f.elements.keys.children[1]);
    expect(f.pending("send_key").args).toEqual({ sessionId: "session-a", key: "Ctrl+C" });
    await f.reply("list_terminals", { terminals, writable: true });
    expect(f.elements.text.disabled).toBe(true);
    f.elements.keys.dispatch("click", f.elements.keys.children[1]);
    expect(f.requests.filter(request => request.name === "send_key")).toHaveLength(1);
    await f.reply("send_key", { delivered: true });
    await f.timer(200);
    await f.reply("list_terminals", { terminals, writable: true });
    await f.reply("read_terminal", screen("interrupted"));
    expect(f.requests.filter(request => request.name === "send_key")).toHaveLength(1);
    expect(f.elements.text.disabled).toBe(false);
  });

  it("ignores a stale selected-terminal read and then observes the latest selection", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    await f.reply("list_terminals", { terminals, writable: true });
    expect(f.pending("read_terminal").args.sessionId).toBe("session-a");
    expect(f.elements.terminal.disabled).toBe(false);
    f.elements.terminal.value = "session-b";
    f.elements.terminal.dispatch("change");
    await f.reply("read_terminal", screen("old terminal output"));
    expect(f.elements.screen.textContent).toBe("initial output");
    await f.reply("list_terminals", { terminals, writable: true });
    expect(f.elements.terminal.value).toBe("session-b");
    expect(f.pending("read_terminal").args.sessionId).toBe("session-b");
    await f.reply("read_terminal", screen("second terminal output"));
    expect(f.elements.screen.textContent).toBe("second terminal output");
    f.submit("hostname");
    expect(f.pending("write_terminal").args.sessionId).toBe("session-b");
  });

  it("keeps failed input for inspection, ignores an older read, and never replays the write", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    await f.reply("list_terminals", { terminals, writable: true });
    f.submit("dangerous-command");
    await f.error("write_terminal", "Delivery outcome unknown");
    const warning = f.elements.status.textContent;
    expect(warning).toContain("Do not retry uncertain input automatically");
    await f.reply("read_terminal", screen("stale output"));
    expect(f.elements.status.textContent).toBe(warning);
    expect(f.elements.text.value).toBe("dangerous-command");
    await f.timer(200);
    await f.reply("list_terminals", { terminals, writable: true });
    await f.reply("read_terminal", screen("observed outcome"));
    await f.timer(1000);
    await f.reply("list_terminals", { terminals, writable: true });
    await f.reply("read_terminal", screen("still observing"));
    expect(f.requests.filter(request => request.name === "write_terminal")).toHaveLength(1);
  });

  it("disables input immediately when polling discovers read-only access or no sessions", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    await f.reply("list_terminals", { terminals, writable: false });
    expect(f.elements.text.disabled).toBe(true);
    expect(f.elements.keys.children.every(button => button.disabled)).toBe(true);
    f.submit("blocked");
    f.elements.keys.dispatch("click", f.elements.keys.children[0]);
    expect(f.requests.some(request => ["write_terminal", "send_key"].includes(request.name))).toBe(false);
    await f.reply("read_terminal", screen("read-only output"));
    expect(f.elements.text.disabled).toBe(true);
    await f.timer(1000);
    await f.reply("list_terminals", { terminals: [], writable: true });
    expect(f.elements.terminal.value).toBe("");
    expect(f.elements.text.disabled).toBe(true);
    expect(f.elements.screen.textContent).toContain("No shared sessions");
  });

  it("keeps access stopped after a failed write even if an older refresh succeeds", async () => {
    const f = fixture();
    await f.ready();
    await f.timer(1000);
    f.submit("possibly-delivered");
    await f.error("write_terminal", "Network lost", true);
    const warning = f.elements.status.textContent;
    await f.reply("list_terminals", { terminals, writable: true });
    expect(f.elements.text.disabled).toBe(true);
    expect(f.elements.terminal.disabled).toBe(true);
    expect(f.elements.status.textContent).toBe(warning);
    const count = f.requests.length;
    await f.timer(200);
    await f.timer(1000);
    f.elements.command.dispatch("submit");
    f.elements.keys.dispatch("click", f.elements.keys.children[0]);
    expect(f.requests).toHaveLength(count);
    expect(f.requests.filter(request => request.name === "write_terminal")).toHaveLength(1);
  });
});
