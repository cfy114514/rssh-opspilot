import type {
  OpsPilotCommandObservation,
  OpsPilotTargetRef,
} from "./opspilot-observation.ts";

export interface OpsPilotInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface OpsPilotSuggestionEvent {
  readonly kind: "suggestion_accepted" | "suggestion_dismissed";
  readonly suggestionId: string;
  readonly host: string | null;
  readonly cwd: string | null;
  readonly cwdSource: "prompt" | "unknown";
  readonly cwdConfidence: number;
}

export interface OpsPilotLedgerClient {
  appendCommand(
    observation: OpsPilotCommandObservation,
    originSuggestionId: string | null,
  ): void;
  appendSuggestion(args: OpsPilotSuggestionEvent): void;
  flush(): Promise<void>;
  end(endedAt?: number): Promise<void>;
}

interface OpsPilotEventPayload {
  readonly id: string;
  readonly sessionId: string;
  readonly sourceBlockId: number | null;
  readonly kind: "command_observed" | "suggestion_accepted" | "suggestion_dismissed";
  readonly host: string | null;
  readonly cwd: string | null;
  readonly cwdSource: "prompt" | "unknown";
  readonly cwdConfidence: number;
  readonly commandRedacted: string | null;
  readonly suggestionId: string | null;
  readonly originSuggestionId: string | null;
  readonly exitCode: number | null;
  readonly exitSource: "unavailable";
  readonly generation?: number;
  readonly occurredAt: number;
}

interface CreateOpsPilotLedgerClientArgs {
  readonly sessionId: string;
  readonly target: OpsPilotTargetRef;
  readonly host: string | null;
  readonly startedAt: number;
  readonly invoke: OpsPilotInvoke;
  readonly now?: () => number;
  readonly createEventId?: () => string;
  readonly warn?: (message: string, error: unknown) => void;
}

export function createOpsPilotLedgerClient(
  args: CreateOpsPilotLedgerClientArgs,
): OpsPilotLedgerClient {
  const now = args.now ?? Date.now;
  const createEventId = args.createEventId ?? (() => crypto.randomUUID());
  const warn = args.warn ?? ((message, error) => console.warn(message, error));

  let queue = Promise.resolve();
  let started = false;
  let generation: number | null = null;
  let startPromise: Promise<number> | null = null;
  let ending = false;
  let endPromise: Promise<void> | null = null;

  const ensureStarted = async (): Promise<number> => {
    if (started && generation !== null) return generation;
    if (startPromise) return startPromise;
    startPromise = args.invoke<number>("opspilot_session_start", {
      session: {
        id: args.sessionId,
        targetKind: args.target.targetKind,
        targetId: args.target.targetId,
        host: args.host,
        startedAt: args.startedAt,
      },
    }).then((value) => {
      generation = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
      started = true;
      return generation;
    }).catch((error) => {
      // A failed start must not poison later events with a permanently
      // rejected promise; the next queued event should be able to retry.
      startPromise = null;
      throw error;
    });
    return startPromise;
  };

  const isMissingSession = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('"code":"opspilot_session_missing"')
      || message === "opspilot_session_missing";
  };

  const isStaleGeneration = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('"code":"opspilot_event_stale_generation"')
      || message === "opspilot_event_stale_generation";
  };

  const appendWithRecovery = async (event: OpsPilotEventPayload): Promise<void> => {
    try {
      await args.invoke("opspilot_event_append", { event });
    } catch (error) {
      if (!isMissingSession(error) && !isStaleGeneration(error)) throw error;
      started = false;
      startPromise = null;
      const restartedGeneration = await ensureStarted();
      if (event.generation !== undefined && event.generation !== restartedGeneration) return;
      await args.invoke("opspilot_event_append", {
        event: event.generation === undefined
          ? { ...event, generation: restartedGeneration }
          : event,
      });
    }
  };

  const enqueueEvent = (
    event: OpsPilotEventPayload,
    generationAtCreation: number | null,
  ): void => {
    if (ending) return;
    queue = queue.then(async () => {
      try {
        const eventGeneration = generationAtCreation ?? await ensureStarted();
        const eventWithGeneration = event.generation === undefined
          ? { ...event, generation: eventGeneration }
          : event;
        await ensureStarted();
        await appendWithRecovery(eventWithGeneration);
      } catch (error) {
        warn("OpsPilot memory append failed", error);
      }
    });
  };

  return {
    appendCommand(observation, originSuggestionId) {
      const generationAtCreation = generation;
      enqueueEvent({
        id: createEventId(),
        sessionId: args.sessionId,
        sourceBlockId: observation.sourceBlockId,
        kind: "command_observed",
        host: observation.host,
        cwd: observation.cwd,
        cwdSource: observation.cwdSource,
        cwdConfidence: observation.cwdConfidence,
        commandRedacted: observation.commandRedacted,
        suggestionId: null,
        originSuggestionId,
        exitCode: observation.exitCode,
        exitSource: observation.exitSource,
        occurredAt: now(),
      }, generationAtCreation);
    },

    appendSuggestion(suggestion) {
      const generationAtCreation = generation;
      enqueueEvent({
        id: createEventId(),
        sessionId: args.sessionId,
        sourceBlockId: null,
        kind: suggestion.kind,
        host: suggestion.host,
        cwd: suggestion.cwd,
        cwdSource: suggestion.cwdSource,
        cwdConfidence: suggestion.cwdConfidence,
        commandRedacted: null,
        suggestionId: suggestion.suggestionId,
        originSuggestionId: null,
        exitCode: null,
        exitSource: "unavailable",
        occurredAt: now(),
      }, generationAtCreation);
    },

    flush() {
      return queue;
    },

    end(endedAt = now()) {
      if (endPromise) return endPromise;
      ending = true;
      endPromise = queue.then(async () => {
        if (!started) return;
        try {
          await args.invoke("opspilot_session_end", {
            sessionId: args.sessionId,
            endedAt,
          });
        } catch (error) {
          warn("OpsPilot memory end failed", error);
        }
      });
      return endPromise;
    },
  };
}
