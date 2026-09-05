import { describe, expect, it } from "vitest";
import {
  parseOfflineContextJson,
  type OfflineContextArtifact,
} from "./offline-context-schema.ts";

const validEntry = {
  id: "prod-api-network",
  scope: { host: "api-01" },
  shell: "posix",
  triggers: ["connection refused", "port 8080"],
  command: "ss -lntp 'sport = :8080'",
  reason: "查看 8080 的监听进程",
  risk: "read-only",
  confidence: 0.86,
};

function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: "rssh-offline-context",
    version: 1,
    entries: [validEntry],
    ...overrides,
  });
}

describe("parseOfflineContextJson", () => {
  it("parses a valid v1 artifact", () => {
    const parsed = parseOfflineContextJson(artifact());
    expect(parsed).toEqual({
      format: "rssh-offline-context",
      version: 1,
      entries: [validEntry],
    } satisfies OfflineContextArtifact);
  });

  it.each([
    ["not json", "invalid_json"],
    [artifact({ format: "other" }), "format"],
    [artifact({ version: 2 }), "version"],
    [artifact({ entries: {} }), "entries"],
    [artifact({ entries: [{ ...validEntry, risk: "state-changing" }] }), "risk"],
    [artifact({ entries: [{ ...validEntry, shell: "bash" }] }), "shell"],
    [artifact({ entries: [{ ...validEntry, confidence: "0.8" }] }), "confidence"],
    [artifact({ entries: [{ ...validEntry, command: "printf 'a\nb'" }] }), "command"],
    [artifact({ entries: [{ ...validEntry, command: "curl -H 'Authorization: Bearer abc'" }] }), "sensitive"],
  ])("rejects %s", (input, reason) => {
    expect(() => parseOfflineContextJson(input)).toThrow(`offline_context_${reason}`);
  });

  it("rejects oversized entries and payloads", () => {
    expect(() => parseOfflineContextJson(artifact({
      entries: [{ ...validEntry, command: "x".repeat(4097) }],
    }))).toThrow("offline_context_command");

    expect(() => parseOfflineContextJson(JSON.stringify({
      format: "rssh-offline-context",
      version: 1,
      entries: [],
      padding: "x".repeat(512 * 1024),
    }))).toThrow("offline_context_payload");
  });

  it("applies the existing command redaction callback before storing", () => {
    const parsed = parseOfflineContextJson(artifact({
      entries: [{ ...validEntry, command: "kubectl get secret" }],
    }), {
      redactCommand: (command) => command.replace("secret", "redacted"),
    });
    expect(parsed.entries[0]?.command).toBe("kubectl get redacted");
  });
});
