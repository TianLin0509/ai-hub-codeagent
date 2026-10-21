# AI HUB-Huawei · 内测先锋版（CodeAgent）

把公司内网的 **Code Agent CLI** 放进一个 Windows 桌面工作台：单独会话、多 AI 群聊、卡片视图、休眠恢复、历史检索、自动命名。这是 AI Hub 的公司版（产品名 AI HUB-Huawei，内测先锋版），当前 **v3.1.0**，同步自上游 **1.6.571**（具体提交见 `community-edition.json`）。

与公开社区版是同一套代码，区别只在默认行为面向公司内网：

- **装了 Code Agent 就默认用它**：新建会话默认选中 CodeAgent 并排第一位，新建群聊默认两名 CodeAgent 成员（GLM-5.2-WX-Auto 与 MiniMax-M2.7）。
- **新文件夹默认信任、默认免确认执行**：启动时带 `--skip-safe-check` 并预先写入信任；权限模式默认 `bypassPermissions`；带 `--disable-update`，不会被升级提示挡住。
- **模型跟着本机 CodeAgent 走**：模型列表读本机 CodeAgent 配置（GLM、MiniMax、DeepSeek 等，按各人权限）；会话里点输入框下方的模型即可切换，Hub 会用新模型接着原会话重开 CodeAgent，对话记录保留。界面按回答实际用的模型显示，头像和侧栏图标也随模型变化。
- **PowerShell 终端**：启动中心里除了 CodeAgent，还能直接新建一个 PowerShell 终端会话。
- **恢复任意目录的历史会话**：启动中心 →「恢复会话」→ CodeAgent，列出所有目录的 CodeAgent 历史（CodeAgent 自带的 `/resume` 只列当前目录），点一条就在它原来的目录里接着聊。
- **不需要任何外部 API Key**：会话和群聊的自动命名用 Code Agent 自己的单次问答模式完成。
- 浅色主题下，CodeAgent 终端整体为深色，与 CLI 自身的黑底一致。
- 账号页不会自动读取本机已登录的其他 CLI 账号，需要时自己点「检查 / 登录」。

## 安装（离线包，推荐）

从发布页下载这三个文件（或由同事转来的离线包里取）：`install-release.ps1`、`AIHubHuawei-3.1.0-win-x64.zip`、`SHA256SUMS.txt`，放在同一个文件夹里，在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-release.ps1 -Version v3.1.0 `
  -PackagePath .\AIHubHuawei-3.1.0-win-x64.zip -ChecksumPath .\SHA256SUMS.txt -DisableGpu
```

- 安装到 `%LOCALAPPDATA%\Programs\AIHubCommunity\v3.1.0`，**不需要管理员权限**，旧版本和用户数据都保留。
- `-DisableGpu` 是兼容渲染：部分电脑用显卡渲染时窗口会全黑。加上它之后，桌面快捷方式自带兼容参数，并在 `%USERPROFILE%\.ai-hub-community\gpu-disabled.json` 留一个标记（删掉这个文件即恢复显卡渲染）。
- 装好后从桌面快捷方式「AI HUB-Huawei」打开。窗口标题会显示版本号，报告问题时请带上这一行。

前提：命令行里能运行 `codeagent --version`，并且 `codeagent auth status --json` 显示已登录。

## 一键更新（v1.0.1 起）

装好 v1.0.1 之后，以后的版本不用再下载整包：

- 启动约 20 秒后在后台查一次新版本（之后每 6 小时一次）。同一个新版本只自动弹窗提醒一次；关掉后左下角「设置」上留一个红点，从设置菜单点开「有新版本」后红点消失。也可以随时在设置菜单里点「检查更新」。
- 更新弹窗里能看到当前版本 → 新版本、发布说明、更新包大小。下载时显示当前用的下载源、进度、速度和剩余时间。
- 下载源按顺序尝试：先 GitHub，再阿里云。每个源下完都核对大小和校验值；被公司代理换成网页、404、长时间没数据、校验不一致，都会写明原因并自动换下一个源。全部失败时给出发布页链接，可以手动下载安装包。
- 一般只下载约 7 MB 的程序文件（整包约 90 MB）。点「立即重启」后约 5 秒完成替换并自动重新打开；替换失败会自动恢复原来的版本，并在重新打开后告诉你原因。底层运行时变化的版本会改为下载完整安装包。
- 从 v1.0.0 升级到 v1.0.1 需要装一次完整包（v1.0.0 还没有这个功能）。

## 让 Agent 代装与验收

把这段话发给你的 Code Agent：

> 请按 AI Hub 公司版 v3.1.0 的 README 用离线包安装（带 -DisableGpu），然后读 docs/COMPANY-CODE-AGENT.md 的「现场验收」，逐项验证 CodeAgent 会话：新建、卡片显示回答、休眠后恢复、Hub 关闭重开后恢复、两名 CodeAgent 成员的群聊。只发极短的测试消息，不修改项目文件，报告每项通过或不通过并附原始证据。

源码包里另有自动验收脚本 `tests/acceptance-codeagent-real.js`（14 项，用真实 Code Agent 跑），用法见脚本开头注释。

## 和同事电脑上其他工具共存

Hub 会把自己的状态回报合并进 `~/.cac/settings.json`。它只增改自己的条目（带 `session-hub-hook` 标记），不删除、不改写其他工具的条目；它的回报脚本只在 Hub 启动的会话里生效，其余会话直接退出。

## 文档

- [Code Agent 适配说明与现场验收](docs/COMPANY-CODE-AGENT.md)
- [安装、登录与排障](INSTALL.md) · [Agent 安装手册](docs/AGENT-QUICKSTART.md) · [架构与复用地图](docs/ARCHITECTURE.md) · [数据边界](PRIVACY.md)

MIT 开源。AI 服务的账号、订阅与用量由使用者自己提供。
