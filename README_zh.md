# RSSH OpsPilot

[English](README.md) | [中文](README_zh.md)

**基于 RSSH 的本地优先 SSH 运维 Copilot。**

本公开仓库是 [RSSH](https://github.com/shihuili1218/rssh) 的衍生 fork。
上游的桌面端、移动端、JetBrains、CLI、终端、SFTP、端口转发、同步和安全
能力保持不变；本分支增加面向交互式排障的本地“下一步命令”工作流。

> 连上服务器，直接问"磁盘怎么满了"——AI 提议命令、标注副作用，你点同意它才在终端里执行；敏感信息离机前本地脱敏。
> 
> 桌面 · 手机 · JetBrains · 命令行，一套数据通用。

[![Release](https://img.shields.io/github/v/release/shihuili1218/rssh)](https://github.com/shihuili1218/rssh/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/shihuili1218/rssh/total)](https://github.com/shihuili1218/rssh/releases)
![Platforms](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux%20·%20Android·%20iOS-555)
[![License](https://img.shields.io/github/license/shihuili1218/rssh)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shihuili1218/rssh)

<p align="center">
  <img src="docs/img_local.png" alt="RSSH —— 问一句，AI 提议命令，你点同意才执行" height="180">
  <img src="docs/img_blocks_context_menu.png" alt="彩色命令块与右键菜单" height="180">
  <img src="docs/img_ai_panel.png" alt="RSSH —— AI 面板读终端上下文，提议命令待批准" height="180"> 
</p>

<p align="center"><b><a href="https://github.com/shihuili1218/rssh/releases">⬇️ 下载最新版</a></b> &nbsp;·&nbsp; <a href="docs/article_zh.md">为什么是 RSSH？</a></p>

---

## OpsPilot 新增能力

本分支在现有终端上增加一条安全的本地建议链路：

1. 读取 xterm 已经渲染的命令块和 shell Prompt；
2. LOCAL 规则针对日志、Spark/YARN、HDFS、Git 工作区、Kubernetes、Docker 和目录定位生成最多三条只读建议；
3. 识别到 PowerShell 或 `cmd.exe` Prompt 时使用对应语法；无法确认时保留
   POSIX 默认命令；
4. 只有识别到 Prompt 时才显示建议；输入中的命令前缀会筛选候选；
5. 点击或按 `Tab` 只填入缺少的文本，不会自动按回车执行；
6. 接受/忽略反馈保存在本机，并按当前目标、主机和工作目录分作用域，供后续会话改进排序；
7. 命令观察必须单独选择开启，保存前在本机脱敏，默认关闭；OpsPilot 记忆永不保存终端输出；
8. “询问 AI”和“总结任务”复用 RSSH 现有 AI 面板，并先经过命令块脱敏。

默认仍然是远端零安装：不上传 agent、不改 shell hook、不启动 daemon、不开放
额外端口，也不会偷偷执行 `pwd` 或 `ls`。进入 `vim`、`less`、`top` 等备用缓冲区
时会暂停建议。可在 **设置 → Shell → 下一步命令建议** 中关闭此功能。

### 本地学习与隐私

OpsPilot 默认只把建议反馈写入本机 SQLite。保存脱敏命令文本是独立的选择项，位于
**设置 → Shell → OpsPilot 本地学习**。脱敏规则无法加载或应用时会直接跳过观察；
带有敏感凭据参数的行内命令会在持久化前被拒绝。

本地账本只保存会话元数据、由 Prompt 得到的主机/工作目录、建议 ID，以及在用户明确
开启后保存的脱敏命令。它没有终端输出字段，不从输出猜测成功，也不会伪造退出码。
只保留最新 5,000 个事件。OpsPilot 记忆不会进入配置导出、GitHub 同步、WebDAV 同步
或导入。

同一设置卡片可查看统计并经确认后清空；CLI 提供等价的本地维护命令：

```powershell
rssh opspilot-memory stats
rssh opspilot-memory clear
rssh opspilot-memory clear --yes
```

### 当前安全边界

- LOCAL 建议默认只读，且永不自动执行；
- 接受建议只会插入文本供审核，不追加回车，也不提交命令；
- OpsPilot 命令历史默认关闭，脱敏失败时拒绝记录，本地事件上限为 5,000，且不参与同步或导出；
- AI 读取失败或脱敏策略无法加载时，默认不发送上下文；
- 总结结果只是待审核的 Rules/Context candidate，不会静默修改可信知识或远端主机；
- 当前 fork 复用 RSSH 既有传输层；保留完整 OpenSSH `ProxyJump`、Agent、MFA
  行为的原生 `ssh.exe + ConPTY` 传输是下一阶段工作。

### 开发快速开始

```powershell
npm ci
npm test
npm run build
```

LOCAL predictor 与 Prompt/Context 测试位于
`src/lib/terminal/next-command.test.ts`，终端集成入口是
`src/lib/components/TerminalPane.svelte`。RSSH 的架构和隐私边界见
[`docs/article_arch_en.md`](docs/article_arch_en.md)。

## 为什么选 RSSH

<table>
<tr>
<td width="50%" valign="top">

### 🤖 AI 排障
不是又一个聊天框，它不需要你在服务器上装任何软件，它模拟人类的操作，直接读取终端的输入输出。

<img src="docs/welcome-ai.gif" alt="AI 排障：读终端，提议命令" width="400">

</td>
<td width="50%" valign="top">

### 🎨 彩色命令块
每条命令和它的输出自动成块、左侧按色分隔，一眼找到上一条命令的输出在哪儿。**纯本地渲染**，零远端依赖。

<img src="docs/welcome-blocks.gif" alt="彩色命令块" width="400">

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🐳 动态发现
容器和 Pod 时时刻刻都在变，过去通过 IP 连接服务器的方案已经过时了，RSSH 会动态发现本地生产测试的容器。

<img src="docs/welcome-discovery.gif" alt="动态发现：容器实时出现在 Home" width="400">

</td>
<td width="50%" valign="top">

### 🔐 多平台数据同步
密钥保存在你本地的 keyserver 程序中，连接配置加密后保存在你的 GitHub 私有仓库里面，不需要保存在第三方服务器。

<img src="docs/welcome-sync.gif" alt="安全与同步：密钥进钥匙串，配置加密到 GitHub" width="400">

</td>
</tr>
</table>

---

## 功能

- **SSH** —— 密码、私钥、SSH Agent/Pageant、键盘交互、跳板机（ProxyJump）
- **Telnet** —— 保存连接配置、回显协商、行规程设置、expect/send 登录脚本
- **串口控制台（桌面端）** —— 保存 UART 配置、文本/Hex 模式、流控、登录脚本、DTR/RTS/Break 控制
- **动态发现（Docker/K8S）** —— 通过本机 CLI context 发现 Docker 容器和运行中的 Kubernetes Pod，直接打开临时 exec 终端；[为什么需要动态发现](docs/article_dynamic_discovery_zh.md)
- **终端** —— xterm 仿真、10 000 行回滚、可折叠彩色命令块、正则高亮、搜索
- **多会话工作台（桌面端）** —— 实时预览已连接终端，并向选中的会话广播内容
- **SFTP** —— 远程文件浏览和上传/下载
- **端口转发** —— 本地、远程和动态（SOCKS5），命名配置，实时流量统计
- **本地终端（桌面端）** —— 自动识别 zsh/bash/PowerShell
- **会话录制** —— asciicast v2 格式，变速回放
- **连接与凭据** —— SQLite 存储，可从 `~/.ssh/config` 导入
- **安全与同步** —— Secret 使用 ChaCha20-Poly1305 本地加密，系统可用时由钥匙串保管主密钥；可选择远程同步范围，并加密备份到你自己的 GitHub 仓库或 WebDAV 服务器
- **片段** —— 可复用命令快捷键（Cmd+E）
- **移动端** —— 虚拟键盘栏（Ctrl/Alt/方向键/Tab/Esc）、安全区、栈式导航
- **IDE 插件** —— 在 JetBrains IDE 的工具窗口里运行 RSSH（共享数据目录）

## 安装

从 [Releases](https://github.com/shihuili1218/rssh/releases) 下载：

| 平台                  | 文件                                       | 备注                     |
|---------------------|------------------------------------------|------------------------|
| macOS Apple Silicon | `rssh-{ver}-macos-aarch64.dmg`           |                        |
| macOS Intel         | `rssh-{ver}-macos-x86_64.dmg`            |                        |
| Linux (deb)         | `rssh-{ver}-linux-x86_64.deb`            | Debian/Ubuntu          |
| Linux (rpm)         | `rssh-{ver}-linux-x86_64.rpm`            | Fedora/RHEL            |
| Linux (AppImage)    | `rssh-{ver}-linux-x86_64.AppImage`       | 任意发行版                  |
| Windows             | `rssh-{ver}-windows-x86_64.msi`          | 静默安装：`msiexec /i`      |
| Windows             | `rssh-{ver}-windows-x86_64-setup.exe`    | 图形安装器                  |
| Windows             | `rssh-{ver}-windows-x86_64-portable.zip` | 免安装 GUI + CLI          |
| Android             | `rssh-{ver}-android-universal.apk`       |                        |
| iOS                 |                                          | AppStore，由 [@paradoxie](https://github.com/paradoxie) 维护 |

### IntelliJ / JetBrains 插件

在 JetBrains IDE 的工具窗口里运行完整 RSSH —— 与桌面版共享同一套主机、密钥、设置
（共享 `~/.rssh`）。每个 zip 内置 headless `rssh-server`，自包含、按平台区分：

| 平台                  | 文件                                              |
|---------------------|--------------------------------------------------|
| macOS Apple Silicon | `rssh-{ver}-macos-aarch64-jetbrains-plugin.zip`  |
| macOS Intel         | `rssh-{ver}-macos-x86_64-jetbrains-plugin.zip`   |
| Linux               | `rssh-{ver}-linux-x86_64-jetbrains-plugin.zip`   |
| Windows             | `rssh-{ver}-windows-x86_64-jetbrains-plugin.zip` |

安装：**Settings → Plugins → ⚙ → Install Plugin from Disk…**，选对应平台的 zip 后重启。
打开底部 **RSSH** 工具窗口即可使用；标题栏的 ✕ 停止内置 server。

## 开发

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 协议

MIT，继承自上游 RSSH。原始版权和授权文本保留在 [`LICENSE`](LICENSE) 中，
重新发布时必须一并保留。

上游项目：[shihuili1218/rssh](https://github.com/shihuili1218/rssh)

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
