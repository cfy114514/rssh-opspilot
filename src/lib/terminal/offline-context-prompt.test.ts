import { describe, expect, it } from "vitest";
import { OFFLINE_CONTEXT_AI_PROMPT } from "./offline-context-prompt.ts";

describe("offline context AI prompt", () => {
  it("pins the machine-readable safety contract", () => {
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain('"format": "rssh-offline-context"');
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain('"version": 1');
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain('"risk": "read-only"');
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain("JSON only");
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain("Do not use a Markdown code fence");
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain("Never include passwords, tokens, private keys, or authorization headers");
    expect(OFFLINE_CONTEXT_AI_PROMPT).toContain("host-specific");
  });
});
