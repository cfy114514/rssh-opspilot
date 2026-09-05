import { describe, expect, it } from "vitest";
import {
  codexDefaultModel,
  codexDefaultReasoningEffort,
  type ModelInfo,
} from "./types.ts";

describe("codex catalog defaults", () => {
  it("defaults to Luna only when the catalog contains the exact Luna id", () => {
    const luna: ModelInfo = {
      id: "gpt-5.6-luna",
      display_name: "Luna",
      supported_reasoning_efforts: [],
      default_reasoning_effort: null,
    };
    expect(codexDefaultModel([luna, { ...luna, id: "gpt-5.6-sol" }])).toBe("gpt-5.6-luna");
    expect(codexDefaultModel([{ ...luna, id: "gpt-5.6-sol" }])).toBe("");
  });

  it("prefers none, then the lowest known supported effort", () => {
    const model = (supported_reasoning_efforts: string[]): ModelInfo => ({
      id: "gpt-test",
      display_name: null,
      supported_reasoning_efforts,
      default_reasoning_effort: "high",
    });
    expect(codexDefaultReasoningEffort(model(["high", "none", "low"]))).toBe("none");
    expect(codexDefaultReasoningEffort(model(["high", "medium"]))).toBe("medium");
    expect(codexDefaultReasoningEffort(model(["vendor-effort"]))).toBeNull();
  });
});
