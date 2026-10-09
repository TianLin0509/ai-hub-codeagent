# 数据与账号边界

发行文件只包含程序、静态资源、通用文档和测试脚本，不包含任何人的 home 目录、Hub 数据、浏览器 profile、账号、聊天记录或私人 Git 历史。上游的私人模块与私人服务（例如个人投研、学习陪伴、公司内部中转、私人网关）在导出时整体删除，不是在界面上隐藏。

## 运行时的数据在哪里

- 会话、草稿、日志、配置：`%USERPROFILE%\.ai-hub-community`（可用 `CLAUDE_HUB_DATA_DIR` 另指）。
- CLI 凭据由你自己的 Claude / Codex / Gemini / Kimi CLI 管理。账号中心只读取必要的登录状态，并对身份做脱敏显示。
- 网页账号登录使用 Hub 数据目录下的专用浏览器目录。
- API Key 存在本机配置里，没有加密。这个目录不是可以公开分享的备份包，不要提交到 Git 或发给别人。
- 本地历史搜索与记忆文件库按你的操作读取本机的对话与文件。调用模型时，你选中的消息和文件会发给对应的 AI 提供方。

## Hub 写入 CLI 配置的内容

为了让卡片准确显示「运行中 / 已完成」，Hub 会在 CLI 的配置里登记状态回报（hook）：

- `~/.claude/settings.json`：追加 Hub 自己的 hook 条目，已有条目原样保留；只有在你没有设置状态栏时才补一个静默状态栏（需要本机有 Node）。**不修改全局 `permissionMode`**。
- `~/.codex/hooks.json` 与 `~/.codex/config.toml`：追加 Hub 的 hook 条目，并写入与之对应的 `trusted_hash`（等于你在 Codex `/hooks` 里点了一次「信任」），只针对 Hub 自己的条目，不替你信任别的 hook；`[tui]` 里没有 `status_line` 时补一行，用于读取上下文余量。
- hook 转发脚本复制到 `~/.claude/scripts/` 与 `~/.codex/hub-scripts/`。

hook 由系统自带的 Windows PowerShell 执行：没有 `CLAUDE_HUB_SESSION_ID` 的会话（也就是你在终端里单独跑的 CLI）会立即退出，不做任何事。有这个变量时，它只把 CLI 交给 hook 的原始事件转发到本机回环地址 `127.0.0.1` 上的 Hub，不连接任何外部地址。

## 自动执行

Hub 启动的 Claude 会话带 `--permission-mode bypassPermissions`，Codex 会话带 Codex 的免确认参数，AI 可以直接改动工作目录里的文件并运行命令。这只作用于 Hub 启动的会话。请只在愿意交给 AI 的目录里使用，不要把 hook 端口或调试端口暴露到公网。

## 发布前检查

`scripts/audit-public.js` 检查公开文件中的账号文件、真实用户目录路径、邮箱和常见密钥格式。它是发布前的一道检查，不能证明所有未知格式的秘密都不存在。
