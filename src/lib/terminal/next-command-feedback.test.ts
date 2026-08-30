import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNextCommandFeedback,
  createOpsPilotFeedbackCache,
  invalidateOpsPilotFeedbackCaches,
  type OpsPilotFeedbackScope,
} from "./next-command-feedback.ts";

const scope: OpsPilotFeedbackScope = {
  targetKind: "ssh",
  targetId: "profile-1",
  host: "app.example",
  cwd: "/srv/app",
};

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  invalidateOpsPilotFeedbackCaches();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpsPilot feedback cache", () => {
  it("deduplicates one in-flight request per normalized structural scope and maps rows", async () => {
    let resolve!: (rows: unknown[]) => void;
    const pending = new Promise<unknown[]>((done) => { resolve = done; });
    const invoke = vi.fn(() => pending);
    const cache = createOpsPilotFeedbackCache(invoke);

    const first = cache.load(scope);
    const second = cache.load({ ...scope });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("opspilot_feedback_stats", { scope });
    resolve([
      { suggestionId: "local-a", accepted: 3, dismissed: 1, scopeRank: 3 },
      { suggestionId: "local-b", accepted: 0, dismissed: 2, scopeRank: 2 },
    ]);

    await expect(first).resolves.toEqual({
      "local-a": { accepted: 3, dismissed: 1 },
      "local-b": { accepted: 0, dismissed: 2 },
    });
    await expect(second).resolves.toEqual({
      "local-a": { accepted: 3, dismissed: 1 },
      "local-b": { accepted: 0, dismissed: 2 },
    });
    expect(cache.peek(scope)).toEqual({
      "local-a": { accepted: 3, dismissed: 1 },
      "local-b": { accepted: 0, dismissed: 2 },
    });
    invoke.mockResolvedValueOnce([]);
    await cache.load(scope);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps authoritative scopes collision-safe", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce([{ suggestionId: "local-a", accepted: 1, dismissed: 1 }])
      .mockResolvedValueOnce([]);
    const cache = createOpsPilotFeedbackCache(invoke);
    const other = { ...scope, cwd: "/srv/app/logs" };
    await cache.load(scope);
    await cache.load(other);

    expect(cache.peek(scope)).toEqual({ "local-a": { accepted: 1, dismissed: 1 } });
    expect(cache.peek(other)).toEqual({});
  });

  it("clears active caches globally but leaves a disposed cache detached", async () => {
    const row = [{ suggestionId: "local-a", accepted: 1, dismissed: 0 }];
    const active = createOpsPilotFeedbackCache(vi.fn(async () => row));
    const disposed = createOpsPilotFeedbackCache(vi.fn(async () => row));
    await active.load(scope);
    await disposed.load(scope);
    disposed.dispose();

    invalidateOpsPilotFeedbackCaches();
    expect(active.peek(scope)).toBeNull();
    expect(disposed.peek(scope)).toEqual({ "local-a": { accepted: 1, dismissed: 0 } });
    active.clear();
    expect(active.peek(scope)).toBeNull();
  });

  it("does not let an in-flight response repopulate an invalidated cache", async () => {
    let resolve!: (rows: unknown[]) => void;
    const pending = new Promise<unknown[]>((done) => { resolve = done; });
    const invoke = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce([]);
    const cache = createOpsPilotFeedbackCache(invoke);

    const stale = cache.load(scope);
    invalidateOpsPilotFeedbackCaches();
    resolve([{ suggestionId: "local-a", accepted: 3, dismissed: 0, scopeRank: 3 }]);

    await expect(stale).resolves.toEqual({});
    expect(cache.peek(scope)).toBeNull();
    await cache.load(scope);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of ranking with cached feedback when loading fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = vi.fn()
      .mockResolvedValueOnce([{ suggestionId: "local-a", accepted: 1, dismissed: 0 }])
      .mockRejectedValueOnce(new Error("database unavailable"));
    const cache = createOpsPilotFeedbackCache(invoke);
    await cache.load(scope);

    await expect(cache.load(scope)).resolves.toEqual({});
    expect(cache.peek(scope)).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      "OpsPilot feedback load failed",
      expect.any(Error),
    );
  });
});

describe("legacy feedback cleanup", () => {
  it("removes the localStorage compatibility record", () => {
    localStorage.setItem("rssh.next-command.feedback.v1", "legacy");
    clearNextCommandFeedback();
    expect(localStorage.getItem("rssh.next-command.feedback.v1")).toBeNull();
  });
});
