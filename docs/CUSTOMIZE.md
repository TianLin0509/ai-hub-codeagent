# 从 AI Hub 做自己的公司工作台

结论：先把现成桌面版跑通，再换公司自己的 provider、业务页和品牌。Provider 是与模型服务或 agent 进程对话的适配层；它负责把公司的接口转换成 Hub 能理解的会话、提交和事件。不要一开始就改群聊、协议和持久化三条链路。

## 交给公司 Agent 的开工任务

> 以 https://github.com/TianLin0509/ai-hub-codeagent 的 v0.5.0 为可复现基线，先读 AGENTS.md、docs/ARCHITECTURE.md、docs/CUSTOMIZE.md。为我们建立独立工作分支或新库，保留 MIT LICENSE 和上游来源。先完成安装和现有 GUI/协议回归，然后调查我们内部 agent 的真实接口、认证方式和部署平台，给出适配映射。沿下文顺序实现公司专用工作台；不得捏造内部 API，不得带入个人账号、聊天或网关，不得把未知提交当作成功。每一步交付源码、验证命令、截图和明确边界。

## 先确定是哪一种改造

| 目标 | 建议实现 | 额外代价 |
|---|---|---|
| 自己团队在各自电脑用 | 现有桌面版；独立数据与工作目录；复用自己的 CLI | 最小；登录仍由每位使用者完成 |
| 接公司内部 agent/API | 替换/增加 provider 适配层，保留会话与 UI 契约 | 必须拿到接口样本和测试环境 |
| 改页面、业务入口、品牌 | renderer 改 UI，业务操作仍经 Main 服务 | 需要真实窗口与交互回归 |
| 改成浏览器访问的多人平台 | 单独设计服务端身份、执行器、租户和密钥管理 | 不是改 Electron 端口就能完成；本仓库不具备多租户保证 |

## 第 1 步：可重复基线与独立运行

使用独立依赖副本执行 `install.ps1 -NoShortcut`，随后 `npm test`、`node tests/e2e-community-cdp.js`。GUI 测试使用临时目录和模拟 CLI，不需要公司账号。

安装包可直接用 [examples/company-hub/start.ps1](../examples/company-hub/start.ps1) 指定公司独立数据目录；它只为新子进程设置 `CLAUDE_HUB_DATA_DIR`，不改系统环境或现有 Hub。账号仍由 CLI 管理，并不会随数据目录隔离自动创建新账号。若要隔离 CLI 身份，使用 CLI 支持的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`，再让用户在新位置授权；不要复制凭据。

## 第 2 步：按这条调用链读代码

1. `renderer/workspace-controller.js` / `renderer/meeting-create-modal.js`：表单、模型和工作目录选择。
2. `main/ipc/session-handlers.js` / `main/ipc/meeting-create-handlers.js`：请求校验与建会话/群聊。
3. `core/session-manager.js`：provider 路由、打开/关闭、归属和恢复。
4. `core/pty-prompt-submit.js`：往真实 CLI 的输入框投递消息，并等 hook 的语义确认。
5. `core/claude-hook-integration.js` / `core/codex-hook-integration.js` / `core/hook-payload.js`：CLI 的状态回报如何登记、转发和解析。
6. `main/ipc/prompt-submit-handlers.js`：统一发送、停止和审批入口；不要另造裸终端写入路径。
7. `core/native-agent-journal.js`、`core/session-store.js`：提交、事件与会话存储。
8. `renderer/renderer.js` / `renderer/meeting-room.js`：只消费已确认事件，渲染普通/群聊卡片。

## 第 3 步：内部 Provider 的接口表

先从内部服务拿真实样本，填写下表再编码。没有哪项能力就明确显示不支持，不通过点击 TUI 或假数据补齐。

| Hub 需要的能力 | 公司接口必须回答的问题 | 验证 |
|---|---|---|
| 创建/恢复 session | 原生 ID 是什么？重启后如何恢复同一 ID？ | 重启后身份不变、历史不丢 |
| 提交消息 | 能否携带 clientSubmissionId？超时后如何查询接收结果？ | 未确认不重复发送 |
| 流式事件 | session/turn/item 的关联是什么？顺序/重复如何处理？ | 乱序或重复事件不导致重复回答 |
| 完成/失败 | 如何区分完成、取消、配额拒绝和网络断开？ | 不能用收到文本代替完成证据 |
| 停止 | 停止回执与执行停止是不是同一事件？ | 不在收到确认前显示已停止 |
| 审批/提问 | requestId、答复与超时如何关联？ | 答错身份或过期请求必须拒绝 |
| 模型/权限 | 可用模型目录、推理档位和工具权限从哪里来？ | 不默默降档、不继承个人权限 |
| 认证 | 公司 SSO/token 由谁保管？过期如何通知？ | 密钥不写 renderer、日志或仓库 |

增加 provider 时，至少查看 `core/ai-kinds.js`、`core/model-options.js`、`core/session-manager.js`、账号中心以及两个创建表单。原生会话对象不是稳定插件 API：必须对照现有对象调用实现，不承诺只写一个 JSON 就能接入任意 agent。

## 第 4 步：自己的业务模块

- 业务服务放 `core/`，IPC 放 `main/ipc/`，页面放 `renderer/`；页面先通过服务接口读写，避免直接混入原生进程生命周期。
- 业务默认值由团队配置提供。保持 `community-edition.json` 和公开版边界，不能通过开启个人模块找回已删去的源文件。
- 公司规则放自己项目的 AGENTS.md；记忆的「磁盘存在」「随消息提交」「原生确认」是不同证据，不要改成一律显示已加载。
- 新建任务目录与业务源目录分开；不要扫描或写入用户 home、组织根目录。保留用户原有规则和配置。

## 第 5 步：品牌与发行

独立 fork 至少统一修改 `package.json` 的 name/productName/build.appId、Windows 安装器/ZIP 文件名与图标、`core/windows-shell-integration.js` 的应用标识/快捷方式、UI 标题。版本必须同步 `package.json` 和 lockfile 的两处版本。默认数据路径散布于兼容模块：优先统一到 `core/data-dir.js`，逐处检查 `.ai-hub-community` 引用并加迁移测试；不要只改包名就声称隔离完成。

公开版脚本中的 GitHub owner/repo、发布资产名、固定 tag 也要随 fork 修改。`scripts/install-release.ps1` 的同版本校验与拒绝覆盖应保留。企业正式发行按内部要求签名、分发和审计；当前版本未配置商业代码签名。

## 合并前验收清单

- 空白用户、缺少 CLI、认证过期、模型不可用、无网络分别有可操作提示。
- 单聊和至少两成员群聊：发送、回复、取消、出错、再次发送、退出/恢复。
- 一个原生 session 只有一个 writer；关闭时停止 writer 后释放归属。
- 故障时不伪造成功、不自动换模型、不静默重发未知消息。
- 所有验证使用隔离目录，且不改变现有 Hub 或用户账号。
- 先通过协议夹具，再由公司测试账号确认真实消息；把两类证据分开记录。

代价和边界：本仓库可以提供成熟桌面链路和可运行的回归基线，但无法预知公司的私有接口。Agent 可以代劳安装、代码分析和实现；本人认证、内部网络许可、服务配额仍要由组织与使用者提供。
