import { describe, expect, it } from "vitest";
import { matchOfflineContext } from "./offline-context-match.ts";
import type { OfflineContextEntry } from "./offline-context-schema.ts";

function entry(overrides: Partial<OfflineContextEntry>): OfflineContextEntry {
  return {
    id: "entry",
    scope: {},
    shell: "any",
    triggers: ["error"],
    command: "printf status",
    reason: "查看状态",
    risk: "read-only",
    confidence: 0.7,
    ...overrides,
  };
}

describe("matchOfflineContext", () => {
  it("uses exact host entries and global fallback without leaking another host", () => {
    const entries = [
      entry({ id: "global", command: "global-check", confidence: 0.6 }),
      entry({ id: "api", scope: { host: "api-01" }, command: "api-check", confidence: 0.6 }),
      entry({ id: "db", scope: { host: "db-01" }, command: "db-check", confidence: 0.99 }),
    ];
    const api = matchOfflineContext(entries, {
      host: "API-01",
      shell: "posix",
      recentBlocks: ["error"],
    });
    expect(api.map((item) => item.command)).toEqual(["api-check", "global-check"]);

    const unknown = matchOfflineContext(entries, {
      shell: "posix",
      recentBlocks: ["error"],
    });
    expect(unknown.map((item) => item.command)).toEqual(["global-check"]);
  });

  it("matches shell and trigger context", () => {
    const entries = [
      entry({ id: "posix", shell: "posix", command: "ss -lntp", triggers: ["connection refused"] }),
      entry({ id: "ps", shell: "powershell", command: "Get-NetTCPConnection", triggers: ["connection refused"] }),
      entry({ id: "other", shell: "posix", command: "free -h", triggers: ["memory pressure"] }),
    ];
    expect(matchOfflineContext(entries, {
      shell: "posix",
      recentBlocks: ["Connection Refused on port 8080"],
    }).map((item) => item.command)).toEqual(["ss -lntp"]);
  });

  it("supports prefix-only matching with Windows case rules", () => {
    const entries = [
      entry({ id: "ps", shell: "powershell", triggers: [], command: "Get-NetTCPConnection -State Listen" }),
      entry({ id: "cmd", shell: "cmd", triggers: [], command: "netstat -ano" }),
      entry({ id: "posix", shell: "posix", triggers: [], command: "Git status" }),
    ];
    expect(matchOfflineContext(entries, {
      shell: "powershell",
      input: "get-net",
      recentBlocks: [],
    }).map((item) => item.command)).toEqual(["Get-NetTCPConnection -State Listen"]);
    expect(matchOfflineContext(entries, {
      shell: "cmd",
      input: "NET",
      recentBlocks: [],
    }).map((item) => item.command)).toEqual(["netstat -ano"]);
    expect(matchOfflineContext(entries, {
      shell: "posix",
      input: "git",
      recentBlocks: [],
    }).map((item) => item.command)).toEqual([]);
  });

  it("requires a trigger or explicit prefix and ranks host-specific matches higher", () => {
    const entries = [
      entry({ id: "global", command: "global-check", confidence: 0.99 }),
      entry({ id: "host", scope: { host: "api-01" }, command: "host-check", confidence: 0.7 }),
      entry({ id: "silent", command: "silent-check", triggers: [], confidence: 1 }),
    ];
    expect(matchOfflineContext(entries, {
      host: "api-01",
      shell: "posix",
      recentBlocks: ["error"],
    }).map((item) => item.command)).toEqual(["host-check", "global-check"]);
    expect(matchOfflineContext(entries, {
      host: "api-01",
      shell: "posix",
      recentBlocks: [],
    }).map((item) => item.command)).toEqual([]);
  });
});
