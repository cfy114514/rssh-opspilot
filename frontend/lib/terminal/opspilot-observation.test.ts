import { describe, expect, it } from "vitest";
import {
  extractOpsPilotCommandObservation,
  resolveOpsPilotTarget,
} from "./opspilot-observation.ts";
import type { CommandBlockRedactionSettings } from "./command-block-redaction.ts";

const redaction: CommandBlockRedactionSettings = {
  promptEnabled: true,
  promptReplacement: "anonymous@rssh",
  rules: [{ pattern: "token=[^ ]+", replacement: "token=<REDACTED>" }],
};

describe("resolveOpsPilotTarget", () => {
  it("resolves all four supported targets to stable non-secret ids", () => {
    expect(resolveOpsPilotTarget("ssh", "tab-ssh", { profileId: "profile-1" }))
      .toEqual({ targetKind: "ssh", targetId: "profile-1" });
    expect(resolveOpsPilotTarget("local", "tab-local", {}))
      .toEqual({ targetKind: "local", targetId: "local" });
    expect(resolveOpsPilotTarget("docker_exec", "tab-docker", {
      connectorSpec: JSON.stringify({
        type: "docker_exec",
        context: "desktop-linux",
        container_id: "abc123",
      }),
    })).toEqual({ targetKind: "docker_exec", targetId: "desktop-linux/abc123" });
    expect(resolveOpsPilotTarget("kubectl_exec", "tab-kube", {
      connectorSpec: JSON.stringify({
        type: "kubectl_exec",
        context: "prod",
        namespace: "payments",
        pod: "api-0",
        container: null,
      }),
    })).toEqual({
      targetKind: "kubectl_exec",
      targetId: "prod/payments/api-0/",
    });
  });

  it("falls back to the tab id for missing or malformed stable metadata", () => {
    expect(resolveOpsPilotTarget("ssh", "tab-ssh", {}))
      .toEqual({ targetKind: "ssh", targetId: "tab-ssh" });
    expect(resolveOpsPilotTarget("docker_exec", "tab-docker", {
      connectorSpec: "not-json",
    })).toEqual({ targetKind: "docker_exec", targetId: "tab-docker" });
    expect(resolveOpsPilotTarget("kubectl_exec", "tab-kube", {
      connectorSpec: JSON.stringify({ type: "docker_exec" }),
    })).toEqual({ targetKind: "kubectl_exec", targetId: "tab-kube" });
  });

  it("does not capture serial or telnet sessions in v1", () => {
    expect(resolveOpsPilotTarget("serial", "serial-1", {})).toBeNull();
    expect(resolveOpsPilotTarget("telnet", "telnet-1", {})).toBeNull();
  });
});

describe("extractOpsPilotCommandObservation", () => {
  it("extracts only the command and post-command prompt context", () => {
    expect(extractOpsPilotCommandObservation({
      blockId: 7,
      blockText: "alice@old:/tmp$ curl token=abc /health\nsecret output token=output",
      returnedPromptLine: "alice@app.example:/srv/app$",
      host: "fallback.example",
      historyEnabled: true,
      redactionSettings: redaction,
    })).toEqual({
      sourceBlockId: 7,
      host: "app.example",
      cwd: "/srv/app",
      cwdSource: "prompt",
      cwdConfidence: 0.8,
      commandRedacted: "curl token=<REDACTED> /health",
      commandForOriginMatch: "curl token=abc /health",
      exitCode: null,
      exitSource: "unavailable",
    });
  });

  it("uses the known host but marks cwd unknown when the returned prompt is unrecognized", () => {
    const observation = extractOpsPilotCommandObservation({
      blockId: 8,
      blockText: "$ pwd\n/srv/app",
      returnedPromptLine: "ordinary output",
      host: "known.example",
      historyEnabled: true,
      redactionSettings: redaction,
    });
    expect(observation).toMatchObject({
      host: "known.example",
      cwd: null,
      cwdSource: "unknown",
      cwdConfidence: 0,
    });
  });

  it("fails closed when history or redaction is unavailable", () => {
    const base = {
      blockId: 1,
      blockText: "$ pwd",
      returnedPromptLine: "$",
      host: null,
      historyEnabled: true,
      redactionSettings: redaction,
    };
    expect(extractOpsPilotCommandObservation({ ...base, historyEnabled: false })).toBeNull();
    expect(extractOpsPilotCommandObservation({ ...base, redactionSettings: null })).toBeNull();
    expect(extractOpsPilotCommandObservation({
      ...base,
      redactionSettings: {
        ...redaction,
        rules: [{ pattern: "(?P<name>x)", replacement: "<X>" }],
      },
    })).toBeNull();
  });

  it("rejects whitespace-only, promptless, and sensitive inline commands", () => {
    const observe = (command: string) => extractOpsPilotCommandObservation({
      blockId: 1,
      blockText: `$ ${command}`,
      returnedPromptLine: "$",
      host: null,
      historyEnabled: true,
      redactionSettings: redaction,
    });
    expect(observe("   ")).toBeNull();
    expect(extractOpsPilotCommandObservation({
      blockId: 1,
      blockText: "ordinary output",
      returnedPromptLine: "$",
      host: null,
      historyEnabled: true,
      redactionSettings: redaction,
    })).toBeNull();
    for (const command of [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "sshpass -p secret ssh host",
      "curl --token=abc /health",
      "curl authorization: Bearer abc",
    ]) {
      expect(observe(command), command).toBeNull();
    }
    expect(observe("mkdir -p /srv/app")).not.toBeNull();
  });

  it("caps persisted command text by Unicode scalar values", () => {
    const observation = extractOpsPilotCommandObservation({
      blockId: 1,
      blockText: `$ ${"界".repeat(5_000)}`,
      returnedPromptLine: "$",
      host: null,
      historyEnabled: true,
      redactionSettings: { ...redaction, rules: [] },
    });
    expect(Array.from(observation!.commandRedacted)).toHaveLength(4_096);
    expect(Array.from(observation!.commandForOriginMatch)).toHaveLength(5_000);
  });
});
