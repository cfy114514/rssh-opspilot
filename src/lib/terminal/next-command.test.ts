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

  it("filters PowerShell candidates case-insensitively", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: [],
      shell: "powershell",
      input: " get-",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["Get-Location", "Get-ChildItem -Force"]);
  });

  it("uses cmd commands for directory orientation", () => {
    const suggestions = suggestNextCommands({recentBlocks: [], shell: "cmd"});
    expect(suggestions.map((item) => item.command)).toEqual(["cd", "dir /A"]);
  });

  it("uses cmd-compatible quoting for wildcard log arguments", () => {
    const suggestions = suggestNextCommands({
      cwd: "C:\\Program Files\\service\\logs",
      recentBlocks: ["ERROR while starting service"],
      shell: "cmd",
    });
    expect(suggestions[0].command).toContain("findstr /I /N");
    expect(suggestions[0].command).toContain(" *.log");
    expect(suggestions[0].command).not.toContain("'*.log'");
    expect(suggestions[1].command).toBe("more *.log");
  });

  it("suggests read-only Git workspace orientation commands", () => {
    const suggestions = suggestNextCommands({
      cwd: "/srv/repository",
      recentBlocks: ["git status --porcelain"],
    });
    expect(suggestions.map((item) => item.command)).toEqual([
      "git status --short",
      "git diff --stat",
    ]);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("filters Git suggestions by a typed command prefix", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["git branch --show-current"],
      input: "git s",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["git status --short"]);
  });

  it("offers a bounded Git history prefix without surrounding context", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "git log",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["git log --oneline -20"]);
  });

  it("suggests read-only Kubernetes orientation commands", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["kubectl describe pod api-7d9c -n production"],
    });
    expect(suggestions.map((item) => item.command)).toEqual([
      "kubectl get pods",
      "kubectl get namespaces",
      "kubectl logs --tail=100 api-7d9c -n production",
    ]);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("filters Kubernetes suggestions by a typed command prefix", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["kubernetes deployment is pending"],
      input: "kubectl get p",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["kubectl get pods"]);
  });

  it("offers a bounded Kubernetes log prefix without surrounding context", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "kubectl logs --t",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["kubectl logs --tail=100 POD_NAME"]);
  });

  it("suggests read-only Docker inventory commands", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["docker container api is restarting"],
    });
    expect(suggestions.map((item) => item.command)).toEqual([
      "docker ps",
      "docker images",
      "docker logs --tail 100 api",
    ]);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("offers a bounded Docker completion for an explicit prefix without context signals", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "docker p",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["docker ps"]);
  });

  it("offers a bounded Docker log prefix without surrounding context", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "docker logs --t",
    });
    expect(suggestions.map((item) => item.command)).toEqual(["docker logs --tail 100 CONTAINER_NAME"]);
  });

  it("suggests read-only systemd service checks", () => {
    const suggestions = suggestNextCommands({
      cwd: "/etc/systemd/system",
      recentBlocks: ["systemctl list-units --type=service"],
    });
    expect(suggestions.map((item) => item.command)).toEqual([
      "systemctl --failed --no-legend",
      "systemctl list-units --type=service --state=running --no-legend",
    ]);
    expect(suggestions.every((item) => item.risk === "read-only")).toBe(true);
  });

  it("prioritizes systemd checks when service failure text also matches log signals", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["systemctl --failed\nfailed: api.service"],
    });
    expect(suggestions[0].command).toBe("systemctl --failed --no-legend");
  });

  it("uses shell-aware read-only commands for network diagnostics", () => {
    const posix = suggestNextCommands({
      recentBlocks: ["connection refused on port 8080"],
    });
    expect(posix.map((item) => item.command)).toEqual(["ss -lntp", "ip addr"]);

    const powershell = suggestNextCommands({
      recentBlocks: ["connection refused on port 8080"],
      shell: "powershell",
    });
    expect(powershell.map((item) => item.command)).toEqual([
      "Get-NetTCPConnection -State Listen",
      "Get-NetIPConfiguration",
    ]);

    const cmd = suggestNextCommands({
      recentBlocks: ["connection refused on port 8080"],
      shell: "cmd",
    });
    expect(cmd.map((item) => item.command)).toEqual(["netstat -ano", "ipconfig"]);
  });

  it("offers shell-aware network prefixes without broad get- pollution", () => {
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "ss",
    }).map((item) => item.command)).toEqual(["ss -lntp"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "cmd",
      input: "net",
    }).map((item) => item.command)).toEqual(["netstat -ano"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "powershell",
      input: "get-net",
    }).map((item) => item.command)).toEqual([
      "Get-NetTCPConnection -State Listen",
      "Get-NetIPConfiguration",
    ]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "powershell",
      input: "get-",
    }).map((item) => item.command)).toEqual(["Get-Location", "Get-ChildItem -Force"]);
  });

  it("offers resource prefixes only in their matching shell", () => {
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "df",
    }).map((item) => item.command)).toEqual(["df -h"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "powershell",
      input: "get-pro",
    }).map((item) => item.command)).toEqual([
      "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
    ]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "cmd",
      input: "task",
    }).map((item) => item.command)).toEqual(["tasklist /FO TABLE"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      shell: "powershell",
      input: "df",
    }).map((item) => item.command)).toEqual([]);
  });

  it("offers bounded platform prefixes without requiring surrounding context", () => {
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "yarn a",
    }).map((item) => item.command)).toEqual(["yarn application -list"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "hdfs dfs -l",
    }).map((item) => item.command)).toEqual(["hdfs dfs -ls -h ."]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "kubectl get n",
    }).map((item) => item.command)).toEqual(["kubectl get namespaces"]);
  });

  it("keeps systemd prefixes and context suggestions in POSIX shells", () => {
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "systemctl --f",
    }).map((item) => item.command)).toEqual(["systemctl --failed --no-legend"]);
    expect(suggestNextCommands({
      recentBlocks: ["ordinary command output"],
      input: "systemctl s",
    }).map((item) => item.command)).toEqual(["systemctl status SERVICE_NAME --no-pager"]);
    expect(suggestNextCommands({
      shell: "powershell",
      recentBlocks: ["systemd service failed"],
      input: "systemctl",
    }).map((item) => item.command)).toEqual([]);
    expect(suggestNextCommands({
      shell: "cmd",
      recentBlocks: ["systemctl service failed"],
      input: "systemctl",
    }).map((item) => item.command)).toEqual([]);
  });

  it("adds a service-specific systemd check when a unit name is visible", () => {
    const suggestions = suggestNextCommands({
      recentBlocks: ["systemctl --failed\nfailed: api-worker@blue.service"],
    });
    expect(suggestions.map((item) => item.command)).toEqual([
      "systemctl --failed --no-legend",
      "systemctl list-units --type=service --state=running --no-legend",
      "systemctl status api-worker@blue.service --no-pager",
    ]);
  });

  it("uses shell-compatible YARN log pipelines", () => {
    expect(suggestNextCommands({
      recentBlocks: ["spark application pending"],
    }).map((item) => item.command)).toEqual([
      "yarn application -list",
      "yarn logs -applicationId APPLICATION_ID | tail -200",
    ]);
    expect(suggestNextCommands({
      shell: "powershell",
      recentBlocks: ["spark application pending"],
    }).map((item) => item.command)).toEqual([
      "yarn application -list",
      "yarn logs -applicationId APPLICATION_ID | Select-Object -Last 200",
    ]);
    expect(suggestNextCommands({
      shell: "cmd",
      recentBlocks: ["spark application pending"],
    }).map((item) => item.command)).toEqual([
      "yarn application -list",
      "yarn logs -applicationId APPLICATION_ID | findstr /I /N \"ERROR Exception failed\"",
    ]);
    expect(suggestNextCommands({
      shell: "powershell",
      recentBlocks: ["ordinary command output"],
      input: "yarn l",
    }).map((item) => item.command)).toEqual([
      "yarn logs -applicationId APPLICATION_ID | Select-Object -Last 200",
    ]);
    expect(suggestNextCommands({
      shell: "cmd",
      recentBlocks: ["ordinary command output"],
      input: "yarn l",
    }).map((item) => item.command)).toEqual([
      "yarn logs -applicationId APPLICATION_ID | findstr /I /N \"ERROR Exception failed\"",
    ]);
  });

  it("uses shell-compatible HDFS size pipelines", () => {
    expect(suggestNextCommands({
      recentBlocks: ["hdfs namenode reports a large directory"],
    }).map((item) => item.command)).toEqual([
      "hdfs dfs -ls -h .",
      "hdfs dfs -du -h . | sort -h | tail -20",
    ]);
    expect(suggestNextCommands({
      shell: "powershell",
      recentBlocks: ["hdfs namenode reports a large directory"],
    }).map((item) => item.command)).toEqual([
      "hdfs dfs -ls -h .",
      "hdfs dfs -du -h . | Sort-Object | Select-Object -Last 20",
    ]);
    expect(suggestNextCommands({
      shell: "cmd",
      recentBlocks: ["hdfs namenode reports a large directory"],
    }).map((item) => item.command)).toEqual([
      "hdfs dfs -ls -h .",
      "hdfs dfs -du -h .",
    ]);
  });

  it("uses shell-aware read-only commands for disk-space diagnostics", () => {
    const posix = suggestNextCommands({
      recentBlocks: ["write failed: no space left on device"],
    });
    expect(posix.map((item) => item.command)).toEqual([
      "df -h",
      "du -sh ./* 2>/dev/null | tail -20",
    ]);

    const powershell = suggestNextCommands({
      recentBlocks: ["disk full on the data volume"],
      shell: "powershell",
    });
    expect(powershell.map((item) => item.command)).toEqual([
      "Get-PSDrive -PSProvider FileSystem",
      "Get-ChildItem -Force | Sort-Object Length -Descending | Select-Object -First 20",
    ]);

    const cmd = suggestNextCommands({
      recentBlocks: ["disk space exhausted"],
      shell: "cmd",
    });
    expect(cmd.map((item) => item.command)).toEqual([
      "wmic logicaldisk get DeviceID,FreeSpace,Size",
      "dir /A",
    ]);
  });

  it("uses shell-aware read-only commands for memory diagnostics", () => {
    const posix = suggestNextCommands({
      recentBlocks: ["service was killed by the OOM killer"],
    });
    expect(posix.map((item) => item.command)).toEqual([
      "free -h",
      "ps aux | sort -nrk 4 | head -20",
    ]);

    const powershell = suggestNextCommands({
      recentBlocks: ["memory pressure is high"],
      shell: "powershell",
    });
    expect(powershell.map((item) => item.command)).toEqual([
      "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize",
      "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20",
    ]);

    const cmd = suggestNextCommands({
      recentBlocks: ["out of memory while starting worker"],
      shell: "cmd",
    });
    expect(cmd.map((item) => item.command)).toEqual([
      "wmic OS get FreePhysicalMemory,TotalVisibleMemorySize",
      "tasklist /FO TABLE",
    ]);
  });

  it("uses shell-aware read-only commands for CPU diagnostics", () => {
    const posix = suggestNextCommands({
      recentBlocks: ["load average is high on the host"],
    });
    expect(posix.map((item) => item.command)).toEqual([
      "uptime",
      "ps -eo pid,ppid,comm,%cpu | sort -nrk 4 | head -20",
    ]);

    const powershell = suggestNextCommands({
      recentBlocks: ["CPU usage is above 95%"],
      shell: "powershell",
    });
    expect(powershell.map((item) => item.command)).toEqual([
      "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
    ]);

    const cmd = suggestNextCommands({
      recentBlocks: ["CPU load is high"],
      shell: "cmd",
    });
    expect(cmd.map((item) => item.command)).toEqual([
      "wmic cpu get LoadPercentage",
      "tasklist /FO TABLE",
    ]);
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
