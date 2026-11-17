import type { OpsPilotInvoke } from "./opspilot-ledger.ts";
import type { OpsPilotTargetKind } from "./opspilot-observation.ts";

export type NextCommandFeedbackOutcome = "accepted" | "dismissed";

export interface NextCommandFeedbackStats {
  accepted: number;
  dismissed: number;
}

const STORAGE_KEY = "rssh.next-command.feedback.v1";
const activeCacheInvalidators = new Set<() => void>();

export interface OpsPilotFeedbackScope {
  targetKind: OpsPilotTargetKind;
  targetId: string;
  host: string | null;
  cwd: string | null;
}

export interface OpsPilotFeedbackStat {
  suggestionId: string;
  accepted: number;
  dismissed: number;
  scopeRank: 1 | 2 | 3;
}

export interface OpsPilotFeedbackCache {
  peek(scope: OpsPilotFeedbackScope): Record<string, NextCommandFeedbackStats> | null;
  load(scope: OpsPilotFeedbackScope): Promise<Record<string, NextCommandFeedbackStats>>;
  clear(): void;
  dispose(): void;
}

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function clearNextCommandFeedback(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Compatibility feedback is best-effort, including explicit local clear.
  }
}

function scopeKey(scope: OpsPilotFeedbackScope): string {
  // Structural JSON avoids separator collisions in user-controlled target IDs.
  return JSON.stringify([
    scope.targetKind,
    scope.targetId,
    scope.host ?? null,
    scope.cwd ?? null,
  ]);
}

function mapFeedbackRows(value: unknown): Record<string, NextCommandFeedbackStats> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, NextCommandFeedbackStats> = {};
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<OpsPilotFeedbackStat>;
    if (typeof row.suggestionId !== "string" || row.suggestionId.length === 0) continue;
    if (!Number.isFinite(row.accepted) || !Number.isFinite(row.dismissed)) continue;
    out[row.suggestionId] = {
      accepted: Math.max(0, Math.floor(Number(row.accepted))),
      dismissed: Math.max(0, Math.floor(Number(row.dismissed))),
    };
  }
  return out;
}

export function createOpsPilotFeedbackCache(
  invoke: OpsPilotInvoke,
): OpsPilotFeedbackCache {
  const cached = new Map<string, Record<string, NextCommandFeedbackStats>>();
  const inFlight = new Map<string, Promise<Record<string, NextCommandFeedbackStats>>>();
  let disposed = false;
  let revision = 0;

  const clear = () => {
    revision += 1;
    cached.clear();
    inFlight.clear();
  };
  activeCacheInvalidators.add(clear);

  const cache: OpsPilotFeedbackCache = {
    peek(scope) {
      return cached.get(scopeKey(scope)) ?? null;
    },

    load(scope) {
      const key = scopeKey(scope);
      const pending = inFlight.get(key);
      if (pending) return pending;

      const requestRevision = revision;
      let request!: Promise<Record<string, NextCommandFeedbackStats>>;
      request = invoke<OpsPilotFeedbackStat[]>("opspilot_feedback_stats", { scope })
        .then((rows) => {
          if (revision !== requestRevision) return cached.get(key) ?? {};
          const mapped = mapFeedbackRows(rows);
          cached.set(key, mapped);
          return mapped;
        })
        .catch((error: unknown) => {
          if (revision !== requestRevision) return cached.get(key) ?? {};
          console.warn("OpsPilot feedback load failed", error);
          cached.delete(key);
          return {};
        })
        .finally(() => {
          if (inFlight.get(key) === request) inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },

    clear,

    dispose() {
      if (disposed) return;
      disposed = true;
      activeCacheInvalidators.delete(clear);
    },
  };
  return cache;
}

export function invalidateOpsPilotFeedbackCaches(): void {
  for (const clear of activeCacheInvalidators) clear();
}
