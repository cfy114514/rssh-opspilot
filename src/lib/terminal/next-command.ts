import {detectPrompt} from "./prompt.ts";

/** Context already visible in the local terminal. No remote probe is needed. */
export interface NextCommandContext {
  readonly promptLine?: string;
  /** Current line input after the prompt, used only for local prefix filtering. */
  readonly input?: string;
  /** Shell family inferred from the visible prompt when available. */
  readonly shell?: NextCommandShell;
  readonly cwd?: string;
  readonly host?: string;
  readonly recentBlocks: readonly string[];
  readonly feedback?: Readonly<Record<string, {accepted: number; dismissed: number}>>;
}

export type NextCommandShell = "posix" | "cmd" | "powershell";

export type NextCommandRisk = "read-only" | "state-changing" | "destructive";

export interface NextCommandSuggestion {
  readonly id: string;
  readonly command: string;
  readonly reason: string;
  readonly risk: NextCommandRisk;
  readonly confidence: number;
  readonly source: "local";
}

export interface PromptContext {
  readonly prompt: string;
  readonly input: string;
  readonly shell: NextCommandShell;
  readonly host?: string;
  readonly cwd?: string;
}

function shellForPrompt(prompt: string): NextCommandShell {
  if (/^PS(?:\s|$)/i.test(prompt)) return "powershell";
  if (/^(?:[A-Za-z]:\\|\\\\)/.test(prompt)) return "cmd";
  return "posix";
}

/**
 * Parse only a line that the caller has already identified as the current
 * terminal line. `detectPrompt` supplies the conservative shell-family gate;
 * the heuristics below only extract host/path metadata from that match.
 */
export function parsePromptLine(line: string): PromptContext | null {
  const match = detectPrompt(line);
  if (!match) return null;

  const prompt = line.slice(0, match.end);
  const input = line.slice(match.end);
  let host: string | undefined;
  let cwd: string | undefined;

  // Unix user@host:/path$ and bracket prompts such as [root@host /path]#.
  const unix = prompt.match(/^[^\s@:\r\n]+@([^\s:\r\n]+)(?::([^#$%>\r\n]*))?[#$%>]/);
  if (unix) {
    host = unix[1];
    cwd = unix[2]?.trim() || undefined;
  }
  const bracket = prompt.match(/^\[[^\]\r\n]*@([^\s\]]+)(?:\s+([^\]]+))?\][#$%>]/);
  if (bracket) {
    host = bracket[1];
    cwd = bracket[2]?.trim() || undefined;
  }

  // PowerShell's default prompt is `PS C:\\Users\\alice>`.
  const powershell = prompt.match(/^PS\s+(.+)>$/i);
  if (powershell) cwd = powershell[1].trim();

  // A common fish/zsh form is `host /path ❯` or `host:/path$`.
  if (!cwd) {
    const path = prompt.match(/(?:^|\s)(~?\/[^#$%>\r\n]*|[A-Za-z]:\\[^>\r\n]*)[#$%>❯➜➤λ]?$/);
    cwd = path?.[1]?.trim() || undefined;
  }

  return {prompt, input, shell: shellForPrompt(prompt), host, cwd};
}

function shellQuote(value: string, shell: NextCommandShell): string {
  if (shell === "cmd") {
    // cmd.exe does not treat single quotes as argument delimiters. Preserve
    // the wildcard used by the read-only log suggestions and quote paths that
    // contain cmd metacharacters with double quotes instead.
    if (/^[A-Za-z0-9_./\\~:@%+=,*?-]+$/.test(value)) return value;
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  if (/^[A-Za-z0-9_./~:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandId(command: string): string {
  // Stable, non-secret id for UI feedback and deduplication.
  let hash = 2166136261;
  for (let i = 0; i < command.length; i++) {
    hash ^= command.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16)}`;
}

function addSuggestion(
  out: NextCommandSuggestion[],
  command: string,
  reason: string,
  confidence: number,
): void {
  if (out.some((item) => item.command === command)) return;
  out.push({
    id: commandId(command),
    command,
    reason,
    risk: "read-only",
    confidence: Math.max(0, Math.min(1, confidence)),
    source: "local",
  });
}

type PrefixCompletion = {
  readonly command: string;
  readonly reason: string;
  readonly confidence: number;
  readonly shells?: readonly NextCommandShell[];
  readonly minPrefixLength?: number;
};

const PREFIX_COMPLETIONS: readonly PrefixCompletion[] = [
  {command: "git status --short", reason: "确认当前工作区改动", confidence: 0.64},
  {command: "git diff --stat", reason: "快速查看改动规模", confidence: 0.60},
  {command: "kubectl get pods", reason: "查看当前命名空间中的 Pod 状态", confidence: 0.64},
  {command: "kubectl get namespaces", reason: "查看可用的 Kubernetes 命名空间", confidence: 0.60},
  {command: "docker ps", reason: "查看当前运行中的容器", confidence: 0.64},
  {command: "docker images", reason: "查看本机已有的容器镜像", confidence: 0.60},
  {command: "systemctl --failed --no-legend", reason: "查看失败的 systemd 服务", confidence: 0.64},
  {
    command: "systemctl list-units --type=service --state=running --no-legend",
    reason: "查看正在运行的 systemd 服务",
    confidence: 0.60,
  },
  {command: "ss -lntp", reason: "查看正在监听的 TCP 端口", confidence: 0.64, shells: ["posix"], minPrefixLength: 2},
  {command: "ip addr", reason: "查看本机网络接口地址", confidence: 0.60, shells: ["posix"], minPrefixLength: 2},
  {command: "netstat -ano", reason: "查看 Windows 连接和监听端口", confidence: 0.64, shells: ["cmd"], minPrefixLength: 3},
  {command: "ipconfig", reason: "查看 Windows 网络接口配置", confidence: 0.60, shells: ["cmd"], minPrefixLength: 3},
  {
    command: "Get-NetTCPConnection -State Listen",
    reason: "查看 PowerShell 监听端口",
    confidence: 0.64,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {
    command: "Get-NetIPConfiguration",
    reason: "查看 PowerShell 网络接口配置",
    confidence: 0.60,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {command: "df -h", reason: "查看文件系统剩余空间", confidence: 0.64, shells: ["posix"], minPrefixLength: 2},
  {command: "free -h", reason: "查看可用和总内存", confidence: 0.64, shells: ["posix"], minPrefixLength: 2},
  {command: "uptime", reason: "查看系统运行时间和负载", confidence: 0.60, shells: ["posix"], minPrefixLength: 3},
  {
    command: "ps -eo pid,ppid,comm,%cpu | sort -nrk 4 | head -20",
    reason: "查看 CPU 占用最高的进程",
    confidence: 0.64,
    shells: ["posix"],
    minPrefixLength: 2,
  },
  {
    command: "Get-PSDrive -PSProvider FileSystem",
    reason: "查看 PowerShell 文件系统剩余空间",
    confidence: 0.64,
    shells: ["powershell"],
    minPrefixLength: 6,
  },
  {
    command: "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize",
    reason: "查看 PowerShell 可用和总物理内存",
    confidence: 0.64,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {
    command: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20",
    reason: "查看占用内存最多的进程",
    confidence: 0.64,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {
    command: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
    reason: "查看累计 CPU 时间最多的进程",
    confidence: 0.64,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {
    command: "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1",
    reason: "采样 PowerShell 总 CPU 使用率",
    confidence: 0.60,
    shells: ["powershell"],
    minPrefixLength: 7,
  },
  {command: "wmic logicaldisk get DeviceID,FreeSpace,Size", reason: "查看 Windows 各磁盘剩余空间", confidence: 0.64, shells: ["cmd"], minPrefixLength: 4},
  {command: "wmic OS get FreePhysicalMemory,TotalVisibleMemorySize", reason: "查看 Windows 可用和总物理内存", confidence: 0.64, shells: ["cmd"], minPrefixLength: 4},
  {command: "wmic cpu get LoadPercentage", reason: "查看 Windows CPU 负载", confidence: 0.60, shells: ["cmd"], minPrefixLength: 4},
  {command: "tasklist /FO TABLE", reason: "查看当前进程列表", confidence: 0.64, shells: ["cmd"], minPrefixLength: 4},
];

function logCandidate(context: NextCommandContext, text: string): string {
  const matches = [...text.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.log)\b/gi)]
    .map((match) => match[1])
    .filter(Boolean);
  if (matches.length > 0) return matches[matches.length - 1];
  if (context.cwd?.toLowerCase().includes("log")) return "*.log";
  return "app.log";
}

/**
 * Deterministic LOCAL predictor. It intentionally emits only bounded,
 * read-only commands and never executes or probes a server. The later ONLINE
 * provider can consume the same context/suggestion contract.
 */
export function suggestNextCommands(context: NextCommandContext): NextCommandSuggestion[] {
  const recent = context.recentBlocks.slice(-4).join("\n");
  const haystack = `${context.cwd ?? ""}\n${context.promptLine ?? ""}\n${recent}`.toLowerCase();
  const shell = context.shell ?? "posix";
  const prefix = context.input?.trimStart() ?? "";
  const caseInsensitive = shell === "cmd" || shell === "powershell";
  const comparablePrefix = caseInsensitive ? prefix.toLocaleLowerCase() : prefix;
  const suggestions: NextCommandSuggestion[] = [];

  const log = shellQuote(logCandidate(context, recent), shell);
  const systemdSignals = /\bsystemctl(?:\s|$)|\bsystemd\b/.test(haystack);
  if (systemdSignals) {
    addSuggestion(suggestions, "systemctl --failed --no-legend", "查看失败的 systemd 服务", 0.82);
    addSuggestion(
      suggestions,
      "systemctl list-units --type=service --state=running --no-legend",
      "查看正在运行的 systemd 服务",
      0.75,
    );
  }
  const networkSignals = /connection refused|address already in use|\bport\s+\d+|\blistening\b|\bsocket\b|\b(?:ss|netstat|ipconfig)\b|get-nettcpconnection|network/.test(haystack);
  if (networkSignals) {
    if (shell === "powershell") {
      addSuggestion(suggestions, "Get-NetTCPConnection -State Listen", "查看 PowerShell 监听端口", 0.82);
      addSuggestion(suggestions, "Get-NetIPConfiguration", "查看 PowerShell 网络接口配置", 0.75);
    } else if (shell === "cmd") {
      addSuggestion(suggestions, "netstat -ano", "查看 Windows 连接和监听端口", 0.82);
      addSuggestion(suggestions, "ipconfig", "查看 Windows 网络接口配置", 0.75);
    } else {
      addSuggestion(suggestions, "ss -lntp", "查看正在监听的 TCP 端口", 0.82);
      addSuggestion(suggestions, "ip addr", "查看本机网络接口地址", 0.75);
    }
  }
  const diskSignals = /no space left|disk full|out of space|filesystem full|disk usage|disk space|storage full|enospc|quota exceeded/.test(haystack);
  if (diskSignals) {
    if (shell === "powershell") {
      addSuggestion(suggestions, "Get-PSDrive -PSProvider FileSystem", "查看 PowerShell 文件系统剩余空间", 0.82);
      addSuggestion(
        suggestions,
        "Get-ChildItem -Force | Sort-Object Length -Descending | Select-Object -First 20",
        "查看当前目录中体积最大的项目",
        0.75,
      );
    } else if (shell === "cmd") {
      addSuggestion(suggestions, "wmic logicaldisk get DeviceID,FreeSpace,Size", "查看 Windows 各磁盘剩余空间", 0.82);
      addSuggestion(suggestions, "dir /A", "查看当前目录内容和文件体积", 0.75);
    } else {
      addSuggestion(suggestions, "df -h", "查看文件系统剩余空间", 0.82);
      addSuggestion(suggestions, "du -sh ./* 2>/dev/null | tail -20", "查看当前目录中占用空间较大的项目", 0.75);
    }
  }
  const memorySignals = /out of memory|oom(?:\s+killer|\s+killed)?|memory pressure|memory exhausted|insufficient memory|cannot allocate memory|killed process/.test(haystack);
  if (memorySignals) {
    if (shell === "powershell") {
      addSuggestion(
        suggestions,
        "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize",
        "查看 PowerShell 可用和总物理内存",
        0.82,
      );
      addSuggestion(
        suggestions,
        "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20",
        "查看占用内存最多的进程",
        0.75,
      );
    } else if (shell === "cmd") {
      addSuggestion(suggestions, "wmic OS get FreePhysicalMemory,TotalVisibleMemorySize", "查看 Windows 可用和总物理内存", 0.82);
      addSuggestion(suggestions, "tasklist /FO TABLE", "查看当前进程列表", 0.75);
    } else {
      addSuggestion(suggestions, "free -h", "查看可用和总内存", 0.82);
      addSuggestion(suggestions, "ps aux | sort -nrk 4 | head -20", "查看占用内存最多的进程", 0.75);
    }
  }
  const cpuSignals = /high cpu|cpu usage|cpu load|load average|load is high|system load|cpu saturation|processor usage|high processor/.test(haystack);
  if (cpuSignals) {
    if (shell === "powershell") {
      addSuggestion(
        suggestions,
        "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1",
        "采样 PowerShell 总 CPU 使用率",
        0.82,
      );
      addSuggestion(
        suggestions,
        "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
        "查看累计 CPU 时间最多的进程",
        0.75,
      );
    } else if (shell === "cmd") {
      addSuggestion(suggestions, "wmic cpu get LoadPercentage", "查看 Windows CPU 负载", 0.82);
      addSuggestion(suggestions, "tasklist /FO TABLE", "查看当前进程列表", 0.75);
    } else {
      addSuggestion(suggestions, "uptime", "查看系统运行时间和负载", 0.82);
      addSuggestion(suggestions, "ps -eo pid,ppid,comm,%cpu | sort -nrk 4 | head -20", "查看 CPU 占用最高的进程", 0.75);
    }
  }
  const logSignals = /\.log\b|\blogs?\b|error|exception|failed|caused by|stack trace/.test(haystack);
  if (!systemdSignals && !networkSignals && !diskSignals && !memorySignals && !cpuSignals && logSignals) {
    if (shell === "powershell") {
      addSuggestion(
        suggestions,
        `Select-String -Path ${log} -Pattern 'error|exception|failed|caused by' | Select-Object -Last 100`,
        "扫描最近日志中的错误与异常链",
        0.91,
      );
      addSuggestion(suggestions, `Get-Content -Tail 100 ${log}`, "先查看最新日志尾部", 0.84);
      addSuggestion(suggestions, `Get-Content -Wait -Tail 100 ${log}`, "持续跟踪后续日志输出", 0.76);
    } else if (shell === "cmd") {
      addSuggestion(
        suggestions,
        `findstr /I /N "error exception failed caused by" ${log}`,
        "扫描最近日志中的错误与异常链",
        0.91,
      );
      addSuggestion(suggestions, `more ${log}`, "分页查看日志内容", 0.78);
    } else {
      addSuggestion(
        suggestions,
        `grep -nEi 'error|exception|failed|caused by' ${log} | tail -100`,
        "扫描最近日志中的错误与异常链",
        0.91,
      );
      addSuggestion(suggestions, `tail -n 100 ${log}`, "先查看最新日志尾部", 0.84);
      addSuggestion(suggestions, `tail -F ${log}`, "持续跟踪后续日志输出", 0.76);
    }
  }

  if (suggestions.length < 3 && /spark|yarn application|application[_ -]?id/.test(haystack)) {
    addSuggestion(suggestions, "yarn application -list", "查看当前 YARN 应用及状态", 0.83);
    addSuggestion(suggestions, "yarn logs -applicationId <application_id> | tail -200", "按应用汇总最近日志", 0.78);
  }

  if (suggestions.length < 3 && /hdfs|namenode|datanode|data[ -]?node/.test(haystack)) {
    addSuggestion(suggestions, "hdfs dfs -ls -h .", "确认当前 HDFS 目录内容", 0.82);
    addSuggestion(suggestions, "hdfs dfs -du -h . | sort -h | tail -20", "定位当前目录的大对象", 0.75);
  }

  if (suggestions.length < 3 && /\bgit(?:\s|$)|\.git(?:[\\/]|$)/.test(haystack)) {
    addSuggestion(suggestions, "git status --short", "确认当前工作区改动", 0.82);
    addSuggestion(suggestions, "git diff --stat", "快速查看改动规模", 0.75);
  }

  if (suggestions.length < 3 && /\bkubectl(?:\s|$)|\bkubernetes\b|\bk8s\b/.test(haystack)) {
    addSuggestion(suggestions, "kubectl get pods", "查看当前命名空间中的 Pod 状态", 0.82);
    addSuggestion(suggestions, "kubectl get namespaces", "查看可用的 Kubernetes 命名空间", 0.75);
  }

  if (suggestions.length < 3 && /\bdocker(?:\s|$)|docker[_ -]?exec/.test(haystack)) {
    addSuggestion(suggestions, "docker ps", "查看当前运行中的容器", 0.82);
    addSuggestion(suggestions, "docker images", "查看本机已有的容器镜像", 0.75);
  }

  // Once the user has typed an explicit command prefix, supplement contextual
  // suggestions with the bounded read-only command catalog. This keeps empty
  // prompts contextual while allowing `docker p`/`kubectl get p` to complete
  // even when the surrounding output contains no recognizable signal.
  if (prefix) {
    for (const candidate of PREFIX_COMPLETIONS) {
      if (candidate.shells && !candidate.shells.includes(shell)) continue;
      if (candidate.minPrefixLength !== undefined && prefix.length < candidate.minPrefixLength) continue;
      const comparableCommand = caseInsensitive
        ? candidate.command.toLocaleLowerCase()
        : candidate.command;
      if (comparableCommand.startsWith(comparablePrefix)) {
        addSuggestion(suggestions, candidate.command, candidate.reason, candidate.confidence);
      }
    }
  }

  if (suggestions.length === 0) {
    if (shell === "powershell") {
      addSuggestion(suggestions, "Get-Location", "确认当前工作目录", context.cwd ? 0.72 : 0.62);
      addSuggestion(suggestions, "Get-ChildItem -Force", "查看当前目录的文件与时间", 0.59);
    } else if (shell === "cmd") {
      addSuggestion(suggestions, "cd", "确认当前工作目录", context.cwd ? 0.72 : 0.62);
      addSuggestion(suggestions, "dir /A", "查看当前目录的文件与时间", 0.59);
    } else {
      addSuggestion(suggestions, "pwd", "确认当前工作目录", context.cwd ? 0.72 : 0.62);
      addSuggestion(suggestions, "ls -lah", "查看当前目录的文件与时间", 0.59);
    }
  }

  const feedback = context.feedback ?? {};
  const ranked = suggestions.map((item) => {
    const stats = feedback[item.id];
    if (!stats) return item;
    const adjustment = Math.min(0.12, stats.accepted * 0.04) - Math.min(0.12, stats.dismissed * 0.025);
    return {...item, confidence: Math.max(0, Math.min(1, item.confidence + adjustment))};
  });
  ranked.sort((a, b) => b.confidence - a.confidence);
  const visible = prefix
    ? ranked.filter((item) => {
      const command = caseInsensitive ? item.command.toLocaleLowerCase() : item.command;
      const input = caseInsensitive ? prefix.toLocaleLowerCase() : prefix;
      return command.startsWith(input);
    })
    : ranked;
  return visible.slice(0, 3);
}
