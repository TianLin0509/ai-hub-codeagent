# 公司内网：用内部 Code Agent 跑 AI Hub

适用：公司内网不能使用 Claude Code、Codex 等外部 CLI，只有公司自研的编码 CLI（下文称 **Code Agent**，命令 `codeagent`，后端可选 GLM、MiniMax 等模型）。固定基线：**v0.5.5**（上游 1.6.404）。

## 结论

Hub 已经内置「CodeAgent」会话种类，装好 Hub、电脑上能运行 `codeagent` 就能用：新建会话、AI 群聊成员、卡片视图、完成状态、休眠后恢复都与 Claude 会话一致。

两轮实测确认，这个 CLI 的使用界面、配置文件、会话记录和状态回报（hook）都是 Claude Code 的形态，所以 Hub 按 Claude 同类接入，只处理它与 Claude 不同的几处：

| 差异 | Hub 的处理 |
|---|---|
| 配置目录是 `CODEAGENT3_CONFIG_DIR`（默认 `%USERPROFILE%\.cac`），状态文件是 `.cac.json` | 启动会话时把配置目录显式交给 CLI；在 `.cac.json` 里预先信任工作目录 |
| 不认 `--session-id`，启动前无法指定会话身份 | 第一个状态回报到达时，按工作目录和记录所在目录核对后绑定原生会话 ID |
| 不认 `--settings` | Hub 的状态回报登记在配置目录的 `settings.json` 里（只加自己的条目，保留其他工具的） |
| 不带 `--disable-update` 会弹出阻塞的「版本更新提醒」 | 每次启动都带 `--disable-update` 和 `--skip-safe-check` |
| 模型是 `GLM-5.2-WX-Auto`（默认）、`MiniMax-M2.7`；思考档 `low/medium/high/max` | 新建会话的模型和思考档下拉只列这些 |

## 安装

1. 按 [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md) 安装 Hub（便携版免 Node / Git / Python）。内网能访问 GitHub 时用一段命令安装；不能访问时走离线四件套。
2. 确认在新开的 PowerShell 里 `codeagent --version` 能输出版本，`codeagent auth status --json` 里 `loggedIn` 为 `true`。
3. 打开 Hub。首页「连接你的 AI」里应显示「CodeAgent · 已安装」。首次启动时 Hub 会把自己的状态回报条目合并进 `%USERPROFILE%\.cac\settings.json`。

需要改命令名或配置目录时（例如安装在别处），在启动 Hub 前设置环境变量：`AI_HUB_CODEAGENT_COMMAND`（命令名或完整路径）、`AI_HUB_CODEAGENT_CONFIG_DIR`（配置目录）。

## 与同事电脑上其他工具共存

部分同事电脑上装有另一个基于 Code Agent 的桌面工具（例如 CodeTeam），它也往同一份 `settings.json` 登记状态回报。两者互不干扰：

- 每个工具的回报脚本只在自己启动的会话里生效，其余会话直接退出；
- Hub 合并 `settings.json` 时只增改自己的条目（带 `session-hub-hook` 标记），不删除、不改写别人的条目；
- Hub 不在这份文件里写状态栏，也不改全局权限模式；
- 两个工具的本地端口都从 3456 起，占用时会自动换端口。

## 可以直接交给 Code Agent 的验收任务

> 请按 docs/COMPANY-CODE-AGENT.md 的「现场验收」逐项验证 AI Hub v0.5.5 的 CodeAgent 会话。只发清单里写明的极短测试消息，不修改项目文件。每一项写「通过 / 不通过 / 未测」并附原始证据（报错原文、截图里的文字、文件名）。不出现 token、内部地址、姓名工号。

## 现场验收

| # | 操作 | 通过标准 |
|---|---|---|
| 1 | 首页「连接你的 AI」 | CodeAgent 显示已安装 |
| 2 | 打开 `%USERPROFILE%\.cac\settings.json` | 原有条目都在；新增了带 `session-hub-hook` 的条目；没有新增 `statusLine` |
| 3 | 新建普通会话，选 CodeAgent、一个测试目录 | 切到终端视图能看到 `codeagent --disable-update --skip-safe-check --model GLM-5.2-WX-Auto …`，没有升级框和信任框 |
| 4 | 发送「只回复 OK」 | 卡片出现回答，状态变为完成 |
| 5 | 侧栏右键 → 休眠，再点开这个会话 | 终端里敲出 `codeagent --resume <同一个 ID> …`；再发「只回复 OK2」，回答出现在同一会话 |
| 6 | 新建 AI 群聊，成员选两个 CodeAgent（一个 GLM、一个 MiniMax） | 两名成员都有回答 |
| 7 | 新建会话时选 MiniMax-M2.7、思考档 max | 终端命令里是 `--model MiniMax-M2.7 --effort max` |

## 尚待真机确认的点

替身测试（用真 Claude Code 模拟 Code Agent 的差异）已经通过，但以下几项只有真 CLI 能回答，验收时请顺带记录：

- 群聊成员的规则通过 `--append-system-prompt-file <文件>` 传入。若 CLI 报未知参数，群聊会起不来，请贴出报错。
- `--resume <ID>` 是否沿用同一个会话 ID。两种情况 Hub 都能处理，但需要实测结论。
- 在 Code Agent 界面里执行 `/clear` 或 `/new` 后，Hub 不会跟随新会话；这时请从 Hub 新建会话。
- 发送很长的多行消息时，界面是否把内容折叠成「[Pasted …]」，以及 CLI 收到的内容是否完整。

## 做不下去时的失败报告

```text
Hub 版本（窗口标题）：
Code Agent 版本（codeagent --version）：
卡在验收第几项：
实际现象与报错原文：
settings.json 里 Hub 条目是否存在：
已确认的事实 / 推断（分开写）：
```

## 想在内部继续改代码时

相关代码集中在：`core/codeagent-config.js`（命令名、配置目录、模型、hook 事件清单）、`core/session-manager.js` 的 `buildCodeAgentPtyLaunch`（启动命令）、`main.js` 里带 `codeagentIdentityPending` 的状态回报绑定、`core/group-chat-cli-ready-detector.js` 与 `core/terminal-runtime-state.js`（界面文字识别）。测试替身在 `tests/fixtures/codeagent-standin/`，端到端测试是 `tests/e2e-codeagent-standin-real-cli.js`。
