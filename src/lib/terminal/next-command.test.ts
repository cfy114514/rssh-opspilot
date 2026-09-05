import {describe, expect, it} from "vitest";
import {parsePromptLine, suggestNextCommands} from "./next-command.ts";

describe("parsePromptLine", () => {
  it("extracts host, cwd, and empty input from a unix prompt", () => {
    expect(parsePromptLine("root@bdp-dc-004:/home/bdp/app/core/logs#")).toEqual({
      prompt: "root@bdp-dc-004:/home/bdp/app/core/logs#",
      input: "",
      shell: "posix",
      host: "bdp-dc-004",
      cwd: "/home/bdp/app/core/logs",
    });
  });

  it("keeps typed input visible so callers can avoid replacing a live line", () => {
    const parsed = parsePromptLine("PS C:\\Users\\alice> Get-Process");
    expect(parsed?.cwd).toBe("C:\\Users\\alice");
    expect(parsed?.input).toBe(" Get-Process");
    expect(parsed?.shell).toBe("powershell");
  });

  it("classifies a drive-letter prompt as cmd", () => {
    expect(parsePromptLine("C:\\Users\\alice>")).toMatchObject({shell: "cmd"});
  });

  it("rejects an arbitrary output line", () => {
    expect(parsePromptLine("ERROR failed to open app.log")).toBeNull();
  });
});

describe("suggestNextCommands", () => {
  it("prefers bounded read-only log triage commands", () => {
    const suggestions = suggestNextCommands({
      cwd: "/home/bdp/app/core/logs",
      promptLine: "root@bdp-dc-004:/home/bdp/app/core/logs#",
      recentBlocks: ["tail -n 20 core.log\nException: connection failed"],
    });
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].command).toContain("grep -nEi");
    expect(suggestions[0].command).toContain("core.log");
    expect(suggestions.every((item) => item.source === "local")).toBe(true);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("falls back to directory orientation without remote probing", () => {
    const suggestions = suggestNextCommands({recentBlocks: []});
    expect(suggestions.map((item) => item.command)).toEqual(["pwd", "ls -lah"]);
    expect(suggestions.some((item) => item.command.includes("ssh"))).toBe(false);
  });

  it("uses PowerShell commands for directory orientation", () => {
    const suggestions = suggestNextCommands({recentBlocks: [], shell: "powershell"});
    expect(suggestions.map((item) => item.command)).toEqual([
      "Get-Location",
      "Get-ChildItem -Force",
    ]);
  });

  it("uses cmd commands for directory orientation", () => {
    const suggestions = suggestNextCommands({recentBlocks: [], shell: "cmd"});
    expect(suggestions.map((item) => item.command)).toEqual(["cd", "dir /A"]);
  });

  it("filters candidates by the exact command prefix while the user is typing", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: [],
      input: "pw",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["pwd"]);
  });

  it("caps the list at three suggestions", () => {
    const suggestions = suggestNextCommands({
      cwd: "/var/log/spark",
      recentBlocks: ["spark application failed", "hdfs namenode error app.log"],
    });
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(new Set(suggestions.map((item) => item.id)).size).toBe(suggestions.length);
  });

  it("uses local feedback to rank a previously accepted suggestion", () => {
    const baseline = suggestNextCommands({
      cwd: "/home/app/logs",
      recentBlocks: ["app.log: ERROR"],
    });
    const accepted = baseline[1];
    const ranked = suggestNextCommands({
      cwd: "/home/app/logs",
      recentBlocks: ["app.log: ERROR"],
      feedback: {[accepted.id]: {accepted: 5, dismissed: 0}},
    });
    expect(ranked[0].id).toBe(accepted.id);
  });

  it("never turns an unknown feedback id into a command suggestion", () => {
    const suggestions = suggestNextCommands({
      promptLine: "ops@prod:/var/log$ ",
      cwd: "/var/log",
      host: "prod",
      recentBlocks: [],
      feedback: {"arbitrary-command": {accepted: 1_000, dismissed: 0}},
    });
    expect(suggestions.some((item) => item.id === "arbitrary-command")).toBe(false);
    expect(suggestions.every((item) => item.source === "local")).toBe(true);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("clamps confidence after extreme feedback counts", () => {
    const baseline = suggestNextCommands({recentBlocks: []});
    const feedback = Object.fromEntries(baseline.map((item, index) => [
      item.id,
      index === 0
        ? {accepted: Number.MAX_SAFE_INTEGER, dismissed: 0}
        : {accepted: 0, dismissed: Number.MAX_SAFE_INTEGER},
    ]));
    const ranked = suggestNextCommands({recentBlocks: [], feedback});
    expect(ranked.every((item) => item.confidence >= 0 && item.confidence <= 1)).toBe(true);
  });
});
