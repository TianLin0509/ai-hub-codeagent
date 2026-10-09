# AI Hub Community — Agent 安装与开发手册

这里是给用户安装公开版、或给团队借鉴代码的入口。先读 README.md、docs/AGENT-QUICKSTART.md；开发时读 INSTALL.md、docs/ARCHITECTURE.md 和 docs/CUSTOMIZE.md。

## 安装任务

1. 确认 Windows x64、独立目标目录；保留已有 Hub 与用户数据。直接运行选择便携发布版，不要求 Node、Git 或 Python。源码开发才需 Node.js 22+。Claude Code 自身在 Windows 上需要 Git for Windows。
2. 按 docs/AGENT-QUICKSTART.md 运行固定版本 `install-release.ps1`；无人值守用 `-NoLaunch -NoShortcut -ResultPath <结果路径>`。同时检查退出码和 JSON，禁止绕过校验。源码路线用 `install.ps1 -NoShortcut`。
3. 启动后检查首页安装检测；源码路线额外执行 `node scripts/doctor.js`。不要把 `ready` 或安装 JSON `ok` 解释成模型可用。
4. 复用本机已经安装的 CLI；缺失时运行 `scripts/install-provider.ps1 -Provider codex|claude|gemini`。这是官方工具安装，会联网。
5. 启动 Hub，打开账号中心的官方登录入口；用户自己完成身份确认。密码、验证码、token 不进 prompt、日志、仓库或截图。
6. 核实窗口和 hook listener，然后在用户允许的项目中发一条测试消息。最后报告已验证、未验证、失败原因；不要自动改模型、换账号、反复重发未知提交。装不上时按 docs/AGENT-QUICKSTART.md 的「装不上时的诊断报告」整理证据交给用户。

无 Node 时可使用组织认可方式安装 Node.js LTS（例如已可用的 winget），保留操作结果。下载受网络策略限制时如实报告，不用作者账号或私人网关兜底。

## 开发任务

- 正常修改在独立 branch/worktree；不要改用户正在运行的目录。主干合并按当前用户授权执行。
- 文件/运行数据/账号目录互相分离；不提交 `.env`、config.json、auth.json、Cookie、session、日志或截图中的私人内容。
- 代码运行边界：Main 管理会话/归属/IPC；renderer 管界面。Claude/Codex 在 PTY 里运行真实 CLI，状态以 CLI hook 为准（`core/claude-hook-integration.js`、`core/codex-hook-integration.js`），发 prompt 一律走 `session:send-prompt` 的提交闭环（`core/pty-prompt-submit.js`），不要把文本和回车拼成一次写入。
- GUI 验证：`node tests/e2e-community-cdp.js`。它创建临时 home/data、独立 CDP 和模拟 Claude CLI（`tests/fixtures/fake-claude.ps1`），用鼠标键盘操作；只关闭自己启动的进程。
- 基础验证：`npm test`、`node scripts/audit-public.js`、改动文件 `node --check`。实际运行命令和失败也要记入报告。
- 安装/构建只能用本副本独立的 node_modules；遇到 junction 不得 npm ci/install/dist。不得批量杀 electron.exe。
- 发布使用干净文件集与新历史；由 `.github/workflows/ci.yml` 验证和打包。不得假称未完成的云构建已通过。

## 给公司平台的接入顺序

内网只有公司自研编码 CLI 时，按 docs/COMPANY-CODE-AGENT.md 先探测再新增会话种类。其他平台化改造：先移植 provider 驱动和生命周期契约，再移植 IPC 与 UI，最后接入你们自己的认证/网关。禁止把本机单用户桌面 Hub 直接当成多租户服务。看 docs/ARCHITECTURE.md 的路径表和 docs/DISTRIBUTION.md 的差异说明。
