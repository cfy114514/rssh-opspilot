import {describe, expect, it} from "vitest";
import {parsePromptLine, suggestNextCommands} from "./next-command.ts";

describe("parsePromptLine", () => {
  it("extracts host, cwd, and empty input from a unix prompt", () => {
    expect(parsePromptLine("root@bdp-dc-004:/home/bdp/app/core/logs#")).toEqual({
      prompt: "root@bdp-dc-004:/home/bdp/app/core/logs#",
      input: "",
      host: "bdp-dc-004",
      cwd: "/home/bdp/app/core/logs",
    });
  });

  it("keeps typed input visible so callers can avoid replacing a live line", () => {
    const parsed = parsePromptLine("PS C:\\Users\\alice> Get-Process");
    expect(parsed?.cwd).toBe("C:\\Users\\alice");
    expect(parsed?.input).toBe(" Get-Process");
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
});
