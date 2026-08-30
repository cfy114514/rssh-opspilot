import { invoke } from "@tauri-apps/api/core";
import {
  clearNextCommandFeedback,
  invalidateOpsPilotFeedbackCaches,
} from "./next-command-feedback.ts";
import type { OpsPilotInvoke } from "./opspilot-ledger.ts";

export interface OpsPilotMemoryStats {
  readonly sessions: number;
  readonly events: number;
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
}

export async function loadOpsPilotMemoryStats(
  invokeFn: OpsPilotInvoke = invoke,
): Promise<OpsPilotMemoryStats> {
  return invokeFn<OpsPilotMemoryStats>("opspilot_memory_stats");
}

export async function clearOpsPilotMemory(
  invokeFn: OpsPilotInvoke = invoke,
): Promise<void> {
  await invokeFn<void>("opspilot_memory_clear");
  clearNextCommandFeedback();
  invalidateOpsPilotFeedbackCaches();
}
