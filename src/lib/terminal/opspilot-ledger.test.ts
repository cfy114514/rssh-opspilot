import { describe, expect, it, vi } from "vitest";
import { createOpsPilotLedgerClient, type OpsPilotInvoke } from "./opspilot-ledger.ts";
import type { OpsPilotCommandObservation } from "./opspilot-observation.ts";

function commandObservation(sourceBlockId: number): OpsPilotCommandObservation {
  return {
    sourceBlockId,
    host: "app.example",
    cwd: "/srv/app",
    cwdSource: "prompt",
    cwdConfidence: 0.8,
    commandRedacted: `echo redacted-${sourceBlockId}`,
    commandForOriginMatch: `echo raw-${sourceBlockId}`,
    exitCode: null,
    exitSource: "unavailable",
  };
}

function createLedger(
  invoke: OpsPilotInvoke,
  warn = vi.fn(),
) {
  let event = 0;
  return {
    ledger: createOpsPilotLedgerClient({
      sessionId: "session-1",
      target: { targetKind: "ssh", targetId: "profile-1" },
      host: "app.example",
      startedAt: 100,
      invoke,
      now: () => 200 + event,
      createEventId: () => `event-${++event}`,
      warn,
    }),
    warn,
  };
}

describe("createOpsPilotLedgerClient", () => {
  it("starts lazily once and emits camelCase command and suggestion events in order", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const { ledger } = createLedger(async (command, args) => {
      calls.push({ command, args });
      return undefined as never;
    });

    expect(calls).toEqual([]);
    ledger.appendCommand(commandObservation(10), "suggestion-1");
    ledger.appendSuggestion({
      kind: "suggestion_accepted",
      suggestionId: "suggestion-2",
      host: "app.example",
      cwd: "/srv/app",
      cwdSource: "prompt",
      cwdConfidence: 0.8,
    });
    await ledger.flush();

    expect(calls).toEqual([
      {
        command: "opspilot_session_start",
        args: { session: {
          id: "session-1",
          targetKind: "ssh",
          targetId: "profile-1",
          host: "app.example",
          startedAt: 100,
        } },
      },
      {
        command: "opspilot_event_append",
        args: { event: {
          id: "event-1",
          sessionId: "session-1",
          sourceBlockId: 10,
          kind: "command_observed",
          host: "app.example",
          cwd: "/srv/app",
          cwdSource: "prompt",
          cwdConfidence: 0.8,
          commandRedacted: "echo redacted-10",
          suggestionId: null,
          originSuggestionId: "suggestion-1",
          exitCode: null,
          exitSource: "unavailable",
          occurredAt: 201,
        } },
      },
      {
        command: "opspilot_event_append",
        args: { event: {
          id: "event-2",
          sessionId: "session-1",
          sourceBlockId: null,
          kind: "suggestion_accepted",
          host: "app.example",
          cwd: "/srv/app",
          cwdSource: "prompt",
          cwdConfidence: 0.8,
          commandRedacted: null,
          suggestionId: "suggestion-2",
          originSuggestionId: null,
          exitCode: null,
          exitSource: "unavailable",
          occurredAt: 202,
        } },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("commandForOriginMatch");
    expect(JSON.stringify(calls)).not.toContain("echo raw-10");
  });

  it("does not start the next append until the previous append settles", async () => {
    let releaseFirst!: () => void;
    const firstAppend = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    let appendCount = 0;
    const { ledger } = createLedger(async (command) => {
      calls.push(command);
      if (command === "opspilot_event_append" && ++appendCount === 1) await firstAppend;
      return undefined as never;
    });

    ledger.appendCommand(commandObservation(1), null);
    ledger.appendCommand(commandObservation(2), null);
    await vi.waitFor(() => expect(calls).toEqual([
      "opspilot_session_start",
      "opspilot_event_append",
    ]));
    releaseFirst();
    await ledger.flush();
    expect(calls).toEqual([
      "opspilot_session_start",
      "opspilot_event_append",
      "opspilot_event_append",
    ]);
  });

  it("warns once for a failed append, keeps flush best-effort, and continues", async () => {
    let appendCount = 0;
    const calls: string[] = [];
    const { ledger, warn } = createLedger(async (command) => {
      calls.push(command);
      if (command === "opspilot_event_append" && ++appendCount === 1) {
        throw new Error("disk full");
      }
      return undefined as never;
    });

    ledger.appendCommand(commandObservation(1), null);
    ledger.appendCommand(commandObservation(2), null);
    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(calls.filter((command) => command === "opspilot_event_append")).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("OpsPilot memory append failed", expect.any(Error));
  });

  it("restarts a cleared active session and retries the first fresh event once", async () => {
    const calls: string[] = [];
    let appendCount = 0;
    const { ledger, warn } = createLedger(async (command) => {
      calls.push(command);
      if (command === "opspilot_event_append" && ++appendCount === 1) {
        throw new Error('__rssh_err__|{"code":"opspilot_session_missing","params":{}}');
      }
      return undefined as never;
    });

    ledger.appendCommand(commandObservation(1), null);
    await ledger.flush();

    expect(calls).toEqual([
      "opspilot_session_start",
      "opspilot_event_append",
      "opspilot_session_start",
      "opspilot_event_append",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends after queued events, only after a start, and remains idempotent", async () => {
    const coldCalls: string[] = [];
    const cold = createLedger(async (command) => {
      coldCalls.push(command);
      return undefined as never;
    }).ledger;
    await cold.end(300);
    expect(coldCalls).toEqual([]);

    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const { ledger } = createLedger(async (command, args) => {
      calls.push({ command, args });
      return undefined as never;
    });
    ledger.appendCommand(commandObservation(1), null);
    const first = ledger.end(300);
    const second = ledger.end(999);
    await Promise.all([first, second]);

    expect(calls.map((call) => call.command)).toEqual([
      "opspilot_session_start",
      "opspilot_event_append",
      "opspilot_session_end",
    ]);
    expect(calls.at(-1)?.args).toEqual({ sessionId: "session-1", endedAt: 300 });
  });
});
