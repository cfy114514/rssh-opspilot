import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpsPilotTerminalController } from "./opspilot-terminal-controller.ts";
import type { OpsPilotCommandObservation } from "./opspilot-observation.ts";
import type { NextCommandSuggestion } from "./next-command.ts";
import type { OpsPilotFeedbackScope } from "./next-command-feedback.ts";

const target = { targetKind: "ssh", targetId: "profile-1" } as const;
const scope: OpsPilotFeedbackScope = {
  ...target,
  host: "app.example",
  cwd: "/srv/app",
};
const suggestion: NextCommandSuggestion = {
  id: "local-a",
  command: "pwd",
  reason: "定位目录",
  risk: "read-only",
  confidence: 0.7,
  source: "local",
};

function observation(commandForOriginMatch: string, sourceBlockId = 1): OpsPilotCommandObservation {
  return {
    sourceBlockId,
    host: scope.host,
    cwd: scope.cwd,
    cwdSource: "prompt",
    cwdConfidence: 0.8,
    commandRedacted: commandForOriginMatch,
    commandForOriginMatch,
    exitCode: null,
    exitSource: "unavailable",
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpsPilot terminal controller", () => {
  it("allocates a fresh local ledger id and ends the previous ledger on reconnect", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const ids = ["ledger-a", "ledger-b"];
    const controller = createOpsPilotTerminalController({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return undefined as never;
      },
      createSessionId: () => ids.shift()!,
      createEventId: (() => { let id = 0; return () => `event-${++id}`; })(),
    });

    controller.connect({ target, host: scope.host, startedAt: 10 });
    controller.recordCommand(observation("pwd", 1));
    await vi.waitFor(() => expect(calls.some((call) =>
      call.command === "opspilot_event_append")).toBe(true));
    controller.connect({ target, host: scope.host, startedAt: 20 });
    controller.recordCommand(observation("ls", 2));
    await controller.disconnect(30);
    await vi.waitFor(() => expect(calls.filter((call) =>
      call.command === "opspilot_session_end")).toHaveLength(2));

    expect(calls.filter((call) => call.command === "opspilot_session_start")
      .map((call) => (call.args?.session as { id: string }).id))
      .toEqual(["ledger-a", "ledger-b"]);
    expect(calls.filter((call) => call.command === "opspilot_session_end")
      .map((call) => call.args?.sessionId))
      .toEqual(["ledger-a", "ledger-b"]);
  });

  it("records feedback persistently", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const controller = createOpsPilotTerminalController({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return undefined as never;
      },
      createSessionId: () => "ledger-a",
      createEventId: () => "event-a",
    });
    controller.connect({ target, host: scope.host, startedAt: 10 });
    controller.recordSuggestion({
      suggestion,
      outcome: "accepted",
      scope,
      originSuggestionId: null,
    });

    await controller.disconnect(20);
    const event = calls.find((call) =>
      call.command === "opspilot_event_append")?.args?.event as Record<string, unknown>;
    expect(event).toMatchObject({
      kind: "suggestion_accepted",
      suggestionId: suggestion.id,
      commandRedacted: null,
    });
  });

  it("ignores compatibility localStorage weights when loading authoritative feedback", async () => {
    localStorage.setItem("rssh.next-command.feedback.v1", JSON.stringify({
      [suggestion.id]: { accepted: 9, dismissed: 0 },
    }));
    const controller = createOpsPilotTerminalController({
      invoke: async (command) => command === "opspilot_feedback_stats"
        ? [] as never
        : undefined as never,
      createSessionId: () => "ledger-a",
    });
    const rerank = vi.fn();

    await controller.refreshFeedback({
      scope,
      revision: 1,
      currentRevision: () => 1,
      rerank,
    });
    expect(rerank).toHaveBeenCalledWith({});
    await controller.dispose();
  });

  it("attributes only the next exact observed command to an accepted suggestion", async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = createOpsPilotTerminalController({
      invoke: async (command, args) => {
        if (command === "opspilot_event_append") {
          events.push(args?.event as Record<string, unknown>);
        }
        return undefined as never;
      },
      createSessionId: () => "ledger-a",
      createEventId: (() => { let id = 0; return () => `event-${++id}`; })(),
    });
    controller.connect({ target, host: scope.host, startedAt: 10 });

    controller.recordSuggestion({ suggestion, outcome: "accepted", scope, originSuggestionId: null });
    controller.recordCommand(observation("pwd", 1));
    controller.recordSuggestion({ suggestion: { ...suggestion, command: "ls" }, outcome: "accepted", scope, originSuggestionId: null });
    controller.recordCommand(observation("ls -lah", 2));
    controller.recordCommand(observation("ls", 3));
    await controller.disconnect(20);

    const commands = events.filter((event) => event.kind === "command_observed");
    expect(commands.map((event) => event.originSuggestionId)).toEqual([
      suggestion.id,
      null,
      null,
    ]);
  });

  it("drops stale scoped feedback results after the context revision changes", async () => {
    let resolveStats!: (rows: unknown[]) => void;
    const controller = createOpsPilotTerminalController({
      invoke: (command) => {
        if (command === "opspilot_feedback_stats") {
          return new Promise((resolve) => { resolveStats = resolve; }) as never;
        }
        return Promise.resolve(undefined as never);
      },
      createSessionId: () => "ledger-a",
    });
    let revision = 4;
    const rerank = vi.fn();
    const refresh = controller.refreshFeedback({
      scope,
      revision,
      currentRevision: () => revision,
      rerank,
    });
    revision = 5;
    resolveStats([{ suggestionId: suggestion.id, accepted: 4, dismissed: 0, scopeRank: 3 }]);
    await refresh;
    expect(rerank).not.toHaveBeenCalled();
    await controller.dispose();
  });
});
