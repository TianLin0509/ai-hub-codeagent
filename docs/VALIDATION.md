# 验证记录

## v0.2.0（同步上游 1.6.257）

日期：2026-09-29。以下都在维护者本机实际执行；CI 与发布结果以 GitHub Actions 对应运行的终态为准，本文件不把未结束的任务记作通过。

### 导出闸门（上游仓库内执行）

- `node scripts/community/export-community.js`：剥离标记全部处理，全部 JavaScript 语法通过，相对 `require` 与页面引用全部可解析，身份 / 私人服务 / 密钥规则零命中，`scripts/audit-public.js` 通过。
- 上游合并闸门里的 `tests/unit-community-export.test.js` 每次都对当前代码做一次完整导出。

### 独立目录安装与单元测试

- 在导出目录执行 `npm ci`：399 个包，使用自己的 `node_modules`。
- `npm test`：13 项通过，覆盖发行标记、私人入口不存在、hook 以 PowerShell 部署且不改全局权限与状态栏、Codex 信任在无 Python 时写入、数据目录与产品名独立、官方 API 默认值、PowerShell 转发的原样字节与字段解析、缺 CLI 的提示、便携版不需要 Node。

### 真实窗口端到端（`node tests/e2e-community-cdp.js`）

环境：临时 HOME（路径含空格），PATH 只有 Windows 自身，没有 Python、Node、Git。

1. 窗口标题显示 `AI Hub Community v0.2.0（上游 1.6.257）`。
2. 首页四个 CLI 都显示未安装；页面上没有私人模块入口。
3. hook 以 PowerShell 命令部署进临时 `~/.claude/settings.json`；没有写全局权限模式；没有 Node 时不登记状态栏。
4. 没装 Claude CLI 时新建 Claude 会话，表单里直接提示「未找到 Claude Code CLI」，不创建会话。
5. 装上模拟 Claude CLI（`tests/fixtures/fake-claude.ps1`，按 Claude Code 的方式经 Git Bash 执行已登记的 hook 命令）后，用鼠标和键盘新建会话、输入中文消息并回车：消息经 PTY 到达 CLI，SessionStart / UserPromptSubmit / Stop 三个 hook 经 PowerShell 转发，输入框状态变为「刚刚完成上一轮」。

### 真实 Claude Code CLI 对照（维护者本机，一次 haiku 调用）

真实 `claude -p` 在同一次运行里同时触发上游的 Python hook 与社区版的 PowerShell 转发：session-start、prompt、stop 三类真实事件，经 Hub 解析后的字段与 Python 版**逐字段一致**。同一条命令经 `cmd.exe`（Codex 执行 hook 的方式）运行也能送达。没有复制或读取任何登录凭据。

### 证据边界

- 陌生机器上的真实 OAuth 登录、在线模型回复、账号额度、企业网络与软件准入，需要在使用者自己的环境验证。
- 真实 Codex 会话没有在隔离环境里跑：隔离运行需要复制登录凭据，而 Codex 会刷新令牌，可能让原账号失效，所以没有做。Codex 的 hook 登记、信任写入（无 Python）由单元测试覆盖，命令经 `cmd.exe` 的送达由上面的对照覆盖。
- 本轮没有在本机点击 NSIS 安装器图形流程；便携 ZIP 安装由 CI 的 `tests/test-portable-package.ps1` 验证。
