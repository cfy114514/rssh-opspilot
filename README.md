# RSSH OpsPilot

[English](README.md) | [中文](README_zh.md)

**A local-first SSH operations copilot built on RSSH.**

This public repository is a focused derivative fork of
[RSSH](https://github.com/shihuili1218/rssh). The upstream desktop, mobile,
JetBrains, CLI, terminal, SFTP, forwarding, sync, and security capabilities are
kept intact; this branch adds a local next-command workflow for interactive
troubleshooting.

> Connect to a host and just ask "why is the disk full?" — the AI proposes commands, flags their side effects, and runs them in your terminal only after you approve. Sensitive data is redacted locally before anything leaves your machine.
> 
> Desktop · Mobile · JetBrains · CLI — one shared data store.

[![Release](https://img.shields.io/github/v/release/shihuili1218/rssh)](https://github.com/shihuili1218/rssh/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/shihuili1218/rssh/total)](https://github.com/shihuili1218/rssh/releases)
![Platforms](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux%20·%20Android·%20iOS-555)
[![License](https://img.shields.io/github/license/shihuili1218/rssh)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shihuili1218/rssh)

<p align="center">
  <img src="docs/img_local.png" alt="RSSH — ask a question, the AI proposes commands, you approve before they run" height="180">
  <img src="docs/img_blocks_context_menu.png" alt="Color-coded command blocks with their context menu" height="180">
  <img src="docs/img_ai_panel.png" alt="RSSH — the AI panel reads the terminal and proposes commands for approval" height="180">  
</p>

<p align="center"><b><a href="https://github.com/shihuili1218/rssh/releases/latest">⬇️ Download latest</a></b> &nbsp;·&nbsp; <a href="docs/article_en.md">Why RSSH?</a></p>

---

## OpsPilot additions

The fork adds a safe, local-first suggestion loop to the existing terminal:

1. RSSH observes the command blocks and shell prompt already rendered by xterm.
2. A deterministic LOCAL predictor proposes up to three read-only commands for
   common log, network/port, disk-space, memory/process, CPU/load, Spark/YARN,
   HDFS, Git workspace, Kubernetes, Docker, systemd, and directory-orientation situations. Network
   hints use `ss` and `ip` on POSIX shells, `netstat` and `ipconfig` on `cmd.exe`,
   and `Get-NetTCPConnection` and `Get-NetIPConfiguration` in PowerShell. Disk
   hints use the corresponding local filesystem, directory, process, and system
   load inventory commands for each shell. Spark/YARN and HDFS log/size
   pipelines likewise use the detected shell's filtering and sorting syntax;
   visible systemd unit names receive a service-specific status check, and
   visible Kubernetes Pod names receive a bounded recent-log check.
3. Recognized PowerShell and `cmd.exe` prompts receive shell-compatible command
   forms; unknown prompts keep the POSIX-compatible defaults.
4. The palette appears only when a returned prompt is recognized; a typed line
   filters candidates by command prefix, and an explicit prefix can surface a
   bounded local command even when surrounding output has no matching signal.
5. Clicking a suggestion or pressing `Tab` inserts the missing text into the
   terminal but never submits `Enter` automatically.
6. Accepted/dismissed feedback is stored locally and scoped to the current
   target, host, and working directory so later sessions can improve ranking.
7. Optional command observations are redacted locally and are off by default.
   Terminal output is never stored in OpsPilot memory.
8. `Ask AI` and `Summarize` pass redacted blocks to RSSH's existing AI panel.

The default path is zero-install on the remote server: no agent, shell hook,
daemon, extra port, hidden `pwd`, or hidden `ls` command is required. Alternate
buffer programs such as `vim`, `less`, and `top` pause suggestions. The feature
can be disabled in **Settings → Shell → Next-command suggestions**.

### Local learning and privacy

OpsPilot keeps suggestion feedback in the local SQLite database by default.
Saving redacted command text is a separate opt-in under **Settings → Shell →
OpsPilot local learning**. Observation is skipped when redaction cannot be
loaded or applied, and sensitive inline credential patterns are rejected
before persistence.

The local ledger stores session metadata, prompt-derived host/cwd context,
suggestion IDs, and—only when opted in—the redacted command. It has no terminal
output column, never infers success from output, and does not pretend an exit
code is available. The newest 5,000 events are retained. OpsPilot memory is
excluded from configuration export, GitHub sync, WebDAV sync, and import.

Statistics and a confirmed clear action are available in the same settings
card. The CLI exposes the equivalent local maintenance commands:

```powershell
rssh opspilot-memory stats
rssh opspilot-memory clear
rssh opspilot-memory clear --yes
```

### Current safety boundary

- Suggestions are read-only by construction in the LOCAL predictor.
- Suggestions never execute automatically.
- Accepting a suggestion only inserts its text for review; it never appends
  Enter or submits the command.
- OpsPilot command history is off by default, redacted fail-closed, bounded to
  5,000 local events, and excluded from sync/export.
- AI handoff reuses RSSH command-block redaction and fails closed if the policy
  cannot be loaded.
- Session summaries are candidate Rules/Context JSON for human review; they do
  not silently modify trusted knowledge or the remote host.
- The current fork reuses RSSH's existing transport. Native `ssh.exe` +
  ConPTY integration that preserves every OpenSSH `ProxyJump`, Agent, and MFA
  behavior is planned as the next transport milestone.

### Development quick start

```powershell
npm ci
npm test
npm run build
```

The LOCAL predictor and its prompt/context tests are in
`src/lib/terminal/next-command.test.ts`. The main integration point is
`src/lib/components/TerminalPane.svelte`.

The RSSH architecture and privacy boundaries are documented in
[`docs/article_arch_en.md`](docs/article_arch_en.md).

## Why RSSH

<table>
<tr>
<td width="50%" valign="top">

### 🤖 AI triage
Not another chat box. Nothing to install on your servers — it works like a human operator, reading the terminal's input and output directly.

<img src="docs/welcome-ai.gif" alt="AI triage: reads the terminal, proposes commands" width="400">

</td>
<td width="50%" valign="top">

### 🎨 Color-coded command blocks
Every command and its output become a block with a color-coded left edge — spot the last command's output at a glance. **Rendered fully locally**, zero remote dependency.

<img src="docs/welcome-blocks.gif" alt="Color-coded command blocks" width="400">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🐳 Dynamic discovery
Containers and pods change by the minute — connecting to servers by static IP is obsolete. RSSH dynamically discovers the containers in your local dev and test environments.

<img src="docs/welcome-discovery.gif" alt="Dynamic discovery: containers appear live in Home" width="400">

</td>
<td width="50%" valign="top">

### 🔐 Multi-platform data sync
Keys stay in your local OS keyserver; connection configs are encrypted into your own private GitHub repo — nothing sits on a third-party server.

<img src="docs/welcome-sync.gif" alt="Security and sync: keys in keychain, profiles encrypted to GitHub" width="400">

</td>
</tr>
</table>

---

## Features

- **SSH** -- password, private key, SSH agent/Pageant, keyboard-interactive, jump host (ProxyJump)
- **Telnet** -- saved profiles, echo negotiation, line controls, expect/send login scripts
- **Serial Console (desktop)** -- saved UART profiles, text/hex modes, flow control, login scripts, DTR/RTS/break
- **Dynamic Discovery (Docker/K8S)** -- discover Docker containers and running Kubernetes pods through local CLI contexts, then open ephemeral exec terminals
- **Terminal** -- xterm emulation, 10 000-line scrollback, foldable color-coded command blocks, regex highlighting, search
- **Multi-session Workbench (desktop)** -- live terminal previews and selection-aware broadcast across connected sessions
- **SFTP** -- remote file browser and upload/download
- **Port Forwarding** -- local, remote and dynamic (SOCKS5), named configs, real-time stats
- **Local Terminal (desktop)** -- auto-detect zsh/bash/PowerShell
- **Session Recording** -- asciicast v2 format, variable-speed playback
- **Connections & Credentials** -- SQLite storage, import from `~/.ssh/config`
- **Security & Sync** -- secrets encrypted locally with ChaCha20-Poly1305, master key in the platform keychain when available, selective remote sync, encrypted backup to your own GitHub repo or WebDAV server
- **Snippets** -- reusable command shortcuts (Cmd+E)
- **Mobile** -- virtual keybar (Ctrl/Alt/arrows/Tab/Esc), safe area, stack navigation
- **IDE Plugin** -- run RSSH inside JetBrains IDEs in a tool window (shared data dir)

## Install

Download from [Releases](https://github.com/shihuili1218/rssh/releases):

| Platform            | File                                     | Notes                        |
|---------------------|------------------------------------------|------------------------------|
| macOS Apple Silicon | `rssh-{ver}-macos-aarch64.dmg`           |                              |
| macOS Intel         | `rssh-{ver}-macos-x86_64.dmg`            |                              |
| Linux (deb)         | `rssh-{ver}-linux-x86_64.deb`            | Debian/Ubuntu                |
| Linux (rpm)         | `rssh-{ver}-linux-x86_64.rpm`            | Fedora/RHEL                  |
| Linux (AppImage)    | `rssh-{ver}-linux-x86_64.AppImage`       | Any distro                   |
| Windows             | `rssh-{ver}-windows-x86_64.msi`          | Silent install: `msiexec /i` |
| Windows             | `rssh-{ver}-windows-x86_64-setup.exe`    | GUI installer                |
| Windows             | `rssh-{ver}-windows-x86_64-portable.zip` | Portable GUI + CLI           |
| Android             | `rssh-{ver}-android-universal.apk`       |                              |
| iOS                 |                                          | AppStore, by [@paradoxie](https://github.com/paradoxie) |

### IntelliJ / JetBrains plugin

Run the full RSSH UI inside a JetBrains IDE tool window — same hosts, keys and
settings as the desktop app (shared `~/.rssh`). Each zip bundles a headless
`rssh-server`, so it's self-contained and per-OS:

| Platform            | File                                             |
|---------------------|--------------------------------------------------|
| macOS Apple Silicon | `rssh-{ver}-macos-aarch64-jetbrains-plugin.zip`  |
| macOS Intel         | `rssh-{ver}-macos-x86_64-jetbrains-plugin.zip`   |
| Linux               | `rssh-{ver}-linux-x86_64-jetbrains-plugin.zip`   |
| Windows             | `rssh-{ver}-windows-x86_64-jetbrains-plugin.zip` |

Install: **Settings → Plugins → ⚙ → Install Plugin from Disk…**, pick the zip for
your OS and restart. Open the **RSSH** tool window (bottom) to start; the ✕ in its
title bar stops the embedded server.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, inherited from the upstream RSSH repository. The original copyright and
permission notice remains in [`LICENSE`](LICENSE) and must be preserved in
redistributions.

Upstream project: [shihuili1218/rssh](https://github.com/shihuili1218/rssh)

## Friend Link

- [LINUX DO](https://linux.do/)
