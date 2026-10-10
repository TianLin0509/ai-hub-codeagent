# Agent 安装手册：替用户装好并交付可用的 AI Hub

适用：Windows 10/11 x64。固定发布版：**v0.5.6**。先选择「直接使用」或「借鉴开发」，不要把装好文件当成账号已经可用。

## 可以直接交给 Agent 的任务

> 请安装 https://github.com/TianLin0509/ai-hub-codeagent 的 v0.5.6。读取 AGENTS.md 和 docs/AGENT-QUICKSTART.md，按便携安装路线执行，保留本机已有 Hub、CLI 和账号。默认复用现有 CLI；缺少时按我的账号选择 Claude 或 Codex，通过官方安装器补齐。完成下载校验、启动、官方登录状态检查和一条真实消息验收。需要本人授权时打开官方窗口让我完成，不索取密码、验证码或 token。把版本、安装目录、校验值、实际通过/失败项交付给我。公司网络不通时报告具体下载地址和错误，不绕过访问策略。

## 路线 A：直接使用（免 Node / Git / Python / 管理员权限）

在 PowerShell 执行下面这一段。脚本固定在 tag，不跟随 main 漂移；默认安装到用户自己的 LocalAppData，创建桌面入口并启动。

```powershell
$setup = Join-Path $env:TEMP ('ai-hub-install-' + [guid]::NewGuid() + '.ps1')
Invoke-WebRequest -UseBasicParsing 'https://github.com/TianLin0509/ai-hub-codeagent/releases/download/v0.5.6/install-release.ps1' -OutFile $setup
powershell -NoProfile -ExecutionPolicy Bypass -File $setup -Version v0.5.6
```

已有 AI CLI 时到此不再安装其他工具。完全没有 CLI、希望使用 Codex 时，最后一行添加 `-Provider codex`；Claude 添加 `-Provider claude`。两者调用官方原生安装器，不依赖 Node。Gemini 需要另行具备 Node/npm，再使用 `-Provider gemini`。不自动升级已有 CLI、不自动选择较低模型。

Agent 无人值守安装文件时添加 `-NoLaunch -NoShortcut -ResultPath <绝对路径到安装结果.json>`；检查退出码 **0** 和 JSON `ok:true`。`launchRequested` 只表示已发起启动；`auth` / `model` 仍为 `not_checked`，不得当成在线成功。脚本失败返回 **1**；PowerShell 参数解析错误也必须视为失败，不沿用旧结果文件。

完整参数：`-Version` 固定版本；`-Destination` 安装根；`-Provider existing|codex|claude|gemini`；`-NoLaunch`；`-NoShortcut`；`-PackagePath` + `-ChecksumPath` 离线输入；`-ResultPath` 机器可读回执。

重复执行会验证现有版本再复用。不同版本安装在不同子目录，旧版本不删除；同版本已改动或未知目录拒绝覆盖。默认数据在 `%USERPROFILE%\.ai-hub-community`，版本升级不搬动它。安装器首次启动会清除父 Hub 的数据目录、测试夹具和会话控制环境，避免从另一个 Hub 内代装时串用数据；自定义目录请使用公司启动示例显式指定。回退程序前先备份数据，新旧版本数据格式不承诺永久兼容。

## 路线 B：公司网络受限的离线交付

从同一个 Release 取得并通过公司批准渠道转入：

- `install-release.ps1`
- `AIHubCommunity-0.5.6-win-x64.zip`
- `SHA256SUMS.txt`
- 可选：`AIHubCommunity-source-0.5.6.zip`，用于借鉴源码

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-release.ps1 -Version v0.5.6 -PackagePath .\AIHubCommunity-0.5.6-win-x64.zip -ChecksumPath .\SHA256SUMS.txt -NoLaunch -NoShortcut
```

离线模式本身不联网；不要添加 `-Provider`，否则可能触发 CLI 联网安装。Hub 的模型服务仍需要公司批准的网络与用户自己的账号。SHA256 校验用于确认下载内容与 GitHub 发布清单一致，不替代企业代码签名或软件准入。

## 最小验收（逐项执行，不省略）

1. 系统为 Windows x64；安装脚本退出 0；保存 `installation.json` 和可选 JSON 回执。核对 Release 的 `release-manifest.json` 中版本、sourceSha、资产摘要。
2. 启动回执里的 executable；首页应出现版本和 CLI 检测。没有 CLI 时给出「待安装」，不得说已经可以聊天。
3. 首页 → 登录 / 检查账号 → 对应 CLI 检查登录。已有有效授权直接复用；没有授权则打开官方登录，用户自己完成，再检查。网页登录与 CLI 登录不同。
4. 新建普通会话，选已安装/授权的 provider、用户允许的工作目录和账户实际有权访问的模型。发送「只回复安装验收通过，不修改文件」；看到实际回复和终态后才算在线验收。
5. 关闭这个测试窗口，再打开同一会话，检查同一原生身份和先前消息。群聊按需要再验收，两名成员都应有回复。
6. 交付：`版本 / 源提交 / 校验值 / 程序位置 / 数据位置 / CLI 版本 / 登录状态 / 真实消息结果 / 未通过项`。绝不把密码、token、完整账号配置放入报告。

只有模拟 CLI 测试通过时写「GUI 通过，真实模型未测」。禁止为了绿灯替用户换模型、换账号，或者反复重发状态未知的消息。

## 定位失败

| 失败位置 | 下一步 |
|---|---|
| GitHub 下载失败 | 记录 URL、HTTP 状态；转用批准代理或上述离线四件套 |
| SHA256 mismatch | 停止执行该包，从同一 Release 重新下载 ZIP 和清单，不绕过校验 |
| Node / Python 缺失 | 便携 Hub 不需要 Node 或 Python，状态回报用系统自带的 PowerShell；源码开发或 Gemini CLI 才需要 Node |
| Claude 会话起不来 | Claude Code 在 Windows 上需要 Git for Windows（Git Bash）；首页检测会给出提示 |
| CLI 待安装 | `resources/scripts/install-provider.ps1 -Provider codex` 或 `claude`；完成后首页重新检测 |
| CLI 安装完成但不能工作 | 执行官方 `--version`，再检查登录；企业策略、旧版本、模型权限分别定位 |
| 账号未登录 | 打开官方登录让本人完成；不复制其他机器凭据 |
| 模型拒绝/额度不足 | 明确报告提供方错误，由用户选择其可用模型或处理账户 |
| 公司 agent 只能访问内部模型 | 进入 [COMPANY-CODE-AGENT.md](COMPANY-CODE-AGENT.md)，给 Hub 加内部 Agent 会话种类；不能把内部账号当作 Claude/Codex 授权 |

## 装不上时的诊断报告

任何一步失败，不要反复重试同一条命令。按顺序收集下面的证据，整理成报告交给用户（用户会转给分享者远程定位）：

1. 安装回执：重跑一次安装并加 `-NoLaunch -NoShortcut -ResultPath "$env:TEMPi-hub-install-result.json"`，记录退出码和该 JSON 全文。
2. 环境：`[Environment]::OSVersion.VersionString`、`$env:PROCESSOR_ARCHITECTURE`、`$PSVersionTable.PSVersion`、`$ExecutionContext.SessionState.LanguageMode`（公司策略常把它设成受限模式）。
3. 网络：对失败的下载地址执行 `Invoke-WebRequest -UseBasicParsing -Method Head <URL>`，记录 HTTP 状态或错误原文；记录是否设置了 `HTTPS_PROXY`。
4. CLI：对每个要用的 CLI 执行 `where.exe <名字>` 与 `<名字> --version`；登录状态只用官方状态命令查询（Claude `claude auth status --json`，Codex `codex login status`）。
5. Hub 自检：源码安装执行 `node scripts/doctor.js`；便携安装启动后截一张首页「连接你的 AI」区域的图（截图前确认没有账号邮箱、token 等私人信息）。

报告模板：

```text
AI Hub 版本：（窗口标题或 installation.json 里的版本）
卡在哪一步：下载 / 校验 / 解压 / 启动 / CLI 安装 / 登录 / 发送消息
错误原文：
已收集的证据：（上面 1–5 的结果，去掉私人信息）
判断：（已验证的原因 与 推断 分开写）
建议下一步：（谁来做什么：换网络 / 装 CLI / 本人登录 / 联系分享者）
```

不要为了让安装「看起来成功」去关闭校验、拷贝别人的凭据、改系统策略或换成作者的账号与网关。

## 路线 C：借鉴或定制

下载同版本源码 ZIP，或者 clone 后 checkout `v0.5.6`。先读 [ARCHITECTURE.md](ARCHITECTURE.md)，再按 [CUSTOMIZE.md](CUSTOMIZE.md) 的任务模板建立自己的分支或仓库。安装包的 `resources/guides` 内也包含说明，离线可以读。
