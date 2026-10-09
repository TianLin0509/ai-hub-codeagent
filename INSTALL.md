# 安装、登录与排障

## 最快路线：便携发布版（免 Node / Git）

普通用户和代装 Agent 优先使用 [AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md) 的固定版本命令。`scripts/install-release.ps1` 自动下载 Windows x64 ZIP、SHA256 校验、按版本安装并启动，支持重复执行、JSON 回执及离线包。不要为了运行发布版先装整套开发环境。

安装目录默认 `%LOCALAPPDATA%\Programs\AIHubCommunity\v0.5.2`。程序包含 `resources/scripts/install-provider.ps1` 和 `resources/guides`，可离线阅读安装/定制文档。可以手动运行其中的 `AI Hub Community.exe`。卸载便携版仅在关闭对应程序后移除该版本目录；用户数据不自动删除。

## 路线 A：源码安装（人和 agent 均可执行）

1. 安装 Node.js 22+ LTS；安装后重开终端。Git 可选，ZIP 下载也能用。
2. clone 或解压到独立目录，不覆盖其他 Hub 安装。
3. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Launch`。

脚本按 lockfile 执行 `npm ci`，检查 Electron，创建 `AI Hub Community` 桌面快捷方式。`-NoShortcut` 跳过快捷方式，`-CheckOnly` 只输出诊断。重复安装保留用户数据，但会重建此目录的 node_modules，安装前先关闭**这个副本**。脚本拒绝通过 node_modules junction/symlink 安装。

首次运行需访问 npm 和 Electron 下载站点。网络受限时使用组织认可的代理或镜像；脚本不会预设作者的代理或下载凭据。安装失败必须看退出码和错误，不把部分下载当成功。

## 路线 B：Windows 安装包

从仓库 Releases 下载已发布的 `AIHubCommunity-Setup-*.exe`，运行后从快捷方式启动。Hub 自带 Electron 运行时，但各 AI CLI 仍需按自己的官方依赖安装。安装包未配置商业代码签名；组织有软件准入策略时按组织流程处理。

## 接入自己的 AI

已有可用 CLI 时不重复安装。至少选一家即可开始单会话；多模型群聊要装好对应成员。

```powershell
# 按需三选一；-WhatIf 可先看将执行的动作
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-provider.ps1 -Provider codex
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-provider.ps1 -Provider claude
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-provider.ps1 -Provider gemini
```

Claude 和 Codex 使用官方原生安装脚本，无需 Node；保留对已有 npm CLI 的兼容。Claude Code 在 Windows 上需要 Git for Windows（Git Bash），首页检测会提示。Gemini 使用官方 npm 包，需要 Node/npm。CLI 版本由执行安装时的官方发布决定；安装脚本不会替已有 CLI 自动升级。Kimi 及其他可选提供方按官方说明安装。

登录首选 Hub 首页「登录 / 检查账号」：

| 提供方 | 官方入口 | 验证 |
|---|---|---|
| Claude Code | `claude auth login` | `claude auth status --json` |
| Codex | `codex login` | `codex login status` |
| Gemini | `gemini`，按 CLI 提示授权 | 本地记录存在仅表示已配置；发一次自己的测试消息确认 |
| Kimi | `kimi login` | 在 CLI/Hub 检查账号状态 |

浏览器回跳不可用时，Codex 可按官方帮助使用 `codex login --device-auth`。设备码、验证码、密码只在用户自己的官方授权流程中处理。Hub 不携带作者的 token；agent 不应从其他机器拷贝 auth.json 或浏览器 profile。

API 方式：账号中心 → 接入配置，自行填 URL、模型和 Key。默认使用官方 API 地址，不预设中转网关。Key 保存在用户本机配置中，不会加密伪装成安全保管库，**不要上传数据目录或 config.json**。支持设置代理，默认不强制本机 7890 端口。

## 验证与运行

```powershell
node scripts/doctor.js
.\start.bat
```

doctor 输出 JSON：退出码 `0` = 源码运行环境齐全；`2` = 缺少必需项；`1` = 诊断本身失败。`providers[].installed` 只表示发现 CLI；`auth: not_checked` 明确没有登录证据。

运行验收：窗口出现、首页能刷新安装检测、账号中心可打开、创建自己的单会话能收到回复。只有最后一步验证了你的真实账号/网络/模型。Agent 如使用仓库的 GUI 测试，应报告「模拟 CLI 通过」，不能冒充在线模型测试。

默认数据：`%USERPROFILE%\.ai-hub-community`；可用 `CLAUDE_HUB_DATA_DIR` 显式隔离。首次不会导入旧 Hub 会话。CLI 登录保留在 CLI 自己的目录中。本机历史搜索和记忆文件库按用户操作读取本机资料；调用模型时，选中的消息和文件会发送给对应提供方。

Hub 启动的 Claude 与 Codex 会话默认自动执行，能直接修改工作目录文件和运行命令；这只作用于 Hub 启动的会话，不改你在终端里单独使用 CLI 时的权限设置。Hub 为了知道会话何时完成，会在 `~/.claude` 与 `~/.codex` 里登记状态回报（hook），完整清单见 [PRIVACY.md](PRIVACY.md)。安装脚本本身不启动 AI 任务。不要把本机 hook/CDP 端口暴露到公网。

## 常见故障

| 现象 | 处理 |
|---|---|
| Node 不满足版本 | 安装 Node.js 22+ LTS，重开终端 |
| Cannot find module / Electron 缺失 | 关闭这个测试副本，在独立源码目录重跑 install.ps1，核实 npm 退出码 |
| node-pty 在本机无法加载 | 不算安装成功；检查 Node/架构与官方构建工具，参考 doctor/启动日志；不要修改别人共享的依赖 |
| CLI 已安装但创建失败 | 检查 PATH、官方 CLI 登录与模型权限；安装后重开 Hub |
| Codex 使用自定义安装目录 | 确认 PATH 指向官方 codex.cmd 或 codex.exe；不要拷贝另一账号的配置 |
| 公司网不能访问 GitHub/npm/AI | 使用批准的代理、镜像或离线源码包；Hub 不会绕过公司策略 |
| 端口冲突 | hook server 会在本机回退端口；测试 CDP 使用独立空闲端口 |
| 原账号失效 | 返回官方授权，不自动反复发消息或验证码 |

卸载只移除本安装目录/应用。用户数据和 CLI 登录默认保留；需要清理时先备份、确认具体目录，agent 不得自动删除。

官方来源（2026-09-20 核对）：[Claude setup](https://code.claude.com/docs/en/setup)、[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[Codex 安装环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)。
