import {
  createOpsPilotFeedbackCache,
  type NextCommandFeedbackOutcome,
  type NextCommandFeedbackStats,
  type OpsPilotFeedbackCache,
  type OpsPilotFeedbackScope,
} from "./next-command-feedback.ts";
import {
  createOpsPilotLedgerClient,
  type OpsPilotInvoke,
  type OpsPilotLedgerClient,
} from "./opspilot-ledger.ts";
import type {
  OpsPilotCommandObservation,
  OpsPilotTargetRef,
} from "./opspilot-observation.ts";
import type { NextCommandSuggestion } from "./next-command.ts";

export interface OpsPilotTerminalController {
  connect(args: {
    target: OpsPilotTargetRef;
    host: string | null;
    startedAt: number;
  }): void;
  disconnect(endedAt?: number): Promise<void>;
  recordCommand(observation: OpsPilotCommandObservation): void;
  recordSuggestion(args: {
    suggestion: NextCommandSuggestion;
    outcome: NextCommandFeedbackOutcome;
    scope: OpsPilotFeedbackScope;
    originSuggestionId: string | null;
  }): void;
  refreshFeedback(args: {
    scope: OpsPilotFeedbackScope;
    revision: number;
    currentRevision: () => number;
    rerank: (feedback: Record<string, NextCommandFeedbackStats>) => void;
  }): Promise<void>;
  dispose(): Promise<void>;
}

interface CreateOpsPilotTerminalControllerArgs {
  readonly invoke: OpsPilotInvoke;
  readonly createSessionId?: () => string;
  readonly createEventId?: () => string;
  readonly now?: () => number;
  readonly warn?: (message: string, error: unknown) => void;
  readonly feedbackCache?: OpsPilotFeedbackCache;
}

export function createOpsPilotTerminalController(
  args: CreateOpsPilotTerminalControllerArgs,
): OpsPilotTerminalController {
  const createSessionId = args.createSessionId ?? (() => crypto.randomUUID());
  const feedbackCache = args.feedbackCache ?? createOpsPilotFeedbackCache(args.invoke);
  let ledger: OpsPilotLedgerClient | null = null;
  let pendingAccepted: { id: string; command: string } | null = null;

  const disconnect = async (endedAt?: number): Promise<void> => {
    const current = ledger;
    ledger = null;
    pendingAccepted = null;
    if (current) await current.end(endedAt);
  };

  return {
    connect(connection) {
      if (ledger) void ledger.end(connection.startedAt);
      pendingAccepted = null;
      ledger = createOpsPilotLedgerClient({
        sessionId: createSessionId(),
        target: connection.target,
        host: connection.host,
        startedAt: connection.startedAt,
        invoke: args.invoke,
        now: args.now,
        createEventId: args.createEventId,
        warn: args.warn,
      });
    },

    disconnect,

    recordCommand(observation) {
      const accepted = pendingAccepted;
      pendingAccepted = null;
      const originSuggestionId = accepted?.command === observation.commandForOriginMatch
        ? accepted.id
        : null;
      ledger?.appendCommand(observation, originSuggestionId);
    },

    recordSuggestion(record) {
      ledger?.appendSuggestion({
        kind: record.outcome === "accepted"
          ? "suggestion_accepted"
          : "suggestion_dismissed",
        suggestionId: record.suggestion.id,
        host: record.scope.host,
        cwd: record.scope.cwd,
        cwdSource: record.scope.cwd === null ? "unknown" : "prompt",
        cwdConfidence: record.scope.cwd === null ? 0 : 0.8,
      });
      if (record.outcome === "accepted") {
        pendingAccepted = {
          id: record.suggestion.id,
          command: record.suggestion.command,
        };
      }
      void record.originSuggestionId;
    },

    async refreshFeedback(refresh) {
      const authoritative = await feedbackCache.load(refresh.scope);
      if (refresh.currentRevision() !== refresh.revision) return;
      refresh.rerank(authoritative);
    },

    async dispose() {
      await disconnect();
      feedbackCache.dispose();
    },
  };
}
