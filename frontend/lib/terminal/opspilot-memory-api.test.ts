import { beforeEach, describe, expect, it, vi } from "vitest";

const clearLegacy = vi.hoisted(() => vi.fn());
const invalidateCaches = vi.hoisted(() => vi.fn());
vi.mock("./next-command-feedback.ts", () => ({
  clearNextCommandFeedback: clearLegacy,
  invalidateOpsPilotFeedbackCaches: invalidateCaches,
}));

import {
  clearOpsPilotMemory,
  loadOpsPilotMemoryStats,
} from "./opspilot-memory-api.ts";

beforeEach(() => {
  clearLegacy.mockReset();
  invalidateCaches.mockReset();
});

describe("OpsPilot memory API", () => {
  it("loads camelCase statistics with the exact backend command", async () => {
    const invoke = vi.fn(async () => ({
      sessions: 2,
      events: 7,
      oldestAt: 100,
      newestAt: 200,
    }));
    await expect(loadOpsPilotMemoryStats(invoke)).resolves.toEqual({
      sessions: 2,
      events: 7,
      oldestAt: 100,
      newestAt: 200,
    });
    expect(invoke).toHaveBeenCalledWith("opspilot_memory_stats");
  });

  it("invalidates local feedback only after backend clear succeeds", async () => {
    const invoke = vi.fn(async () => undefined);
    await clearOpsPilotMemory(invoke);
    expect(invoke).toHaveBeenCalledWith("opspilot_memory_clear");
    expect(clearLegacy).toHaveBeenCalledTimes(1);
    expect(invalidateCaches).toHaveBeenCalledTimes(1);
  });

  it("propagates explicit failures without pretending local state was cleared", async () => {
    const error = new Error("database busy");
    const invoke = vi.fn(async () => { throw error; });
    await expect(loadOpsPilotMemoryStats(invoke)).rejects.toBe(error);
    await expect(clearOpsPilotMemory(invoke)).rejects.toBe(error);
    expect(clearLegacy).not.toHaveBeenCalled();
    expect(invalidateCaches).not.toHaveBeenCalled();
  });
});
