'use strict';
// Human-written display copy only. Never used to infer installation or authorship.
const SKILLS = {
  'agent-reach':'搜索网页与社交平台，获取文章、视频和公开资料',
  'chatgpt-web-images':'通过 ChatGPT 网页生成图片，管理队列并下载原图',
  'harness':'将领域需求组织成 Agent 团队与配套技能',
  'review-agent':'只读审查代码变更，列出可落实的问题与修改建议',
  'browser':'操作 Codex 内置浏览器，检查网页与本地应用',
  'cli-creator':'把 API、脚本或服务封装成可复用的命令行工具',
  'claude-md-improver':'检查并改进项目的 CLAUDE.md 规则与记忆文件',
  'codex-cli-runtime':'从 Claude 调用 Codex，执行代码任务与审查',
  'codex-result-handling':'整理 Codex 返回的结果，向用户说明结论',
  'design-review':'实现前审查需求、架构与设计取舍',
  'documents':'创建、修改和批注 Word 文档，并检查排版',
  'presentations':'制作和编辑 PowerPoint 演示文稿',
  'spreadsheets':'处理 Excel 表格、公式、数据分析与图表',
  'figma-use':'读取和编辑 Figma 设计稿',
  'figma-generate-design':'把网页或应用界面转换成 Figma 设计稿',
  'gen-ppt-image':'生成技术报告的 PPT 视觉候选图，选定后再制作幻灯片',
  'hybrid-image-to-ppt':'将幻灯片图片重建为可编辑 PPT，并对照原图验证',
  'imag2ppt':'将幻灯片图片还原为可编辑 PPT 元素',
  'imag2ppt-v2':'识别幻灯片图片文字，重建可编辑 PPT',
  'image-to-ppt-workflow':'从图片或已确认的视觉稿制作 PowerPoint',
  'img2ppt-lite':'把幻灯片图片拆成可编辑文字与可拖拽图案',
  'imagegen':'按描述生成图片，或对现有图片进行编辑',
  'jupyter-notebook':'创建和整理 Jupyter 数据实验笔记本',
  'openai-docs':'查询 OpenAI 产品、Codex 与 API 的官方用法',
  'pdf':'读取、制作和检查 PDF 文档与页面排版',
  'playwright':'自动操作浏览器，测试网页并保存截图',
  'plugin-creator':'创建 Codex 插件，把技能和工具打包分发',
  'plugin-management':'查找和管理插件、账号连接及其权限',
  'post-refactor-verify':'重构后检查行为、回归测试和兼容性',
  'ppt-templates-gen':'从参考页面提炼可复用的 PPT 模板',
  'review':'按任务内容选择代码、设计或其他审阅流程',
  'security-best-practices':'检查代码安全实践并提出改进建议',
  'skill-creator':'创建或更新技能说明、脚本与参考资料',
  'skill-installer':'从技能目录或 GitHub 安装 Codex 技能',
  'smart-ocr':'识别图片和扫描件中的文字',
  'ui-ux-pro-max':'查询界面设计方案、配色、字体和交互规范',
  'brainstorming':'澄清目标并探索实现方案',
  'dispatching-parallel-agents':'将互不依赖的任务分配给多个 Agent',
  'executing-plans':'按既定计划分步实施，并在检查点核对结果',
  'finishing-a-development-branch':'整理开发分支的验证、合并与交付',
  'frontend-design':'设计并实现具有明确视觉风格的前端界面',
  'gpt-5-4-prompting':'为 Codex 编写代码、审查和研究任务提示词',
  'receiving-code-review':'核对审阅意见，判断并实施必要修改',
  'requesting-code-review':'准备变更背景并发起代码审阅',
  'subagent-driven-development':'按计划拆分实现任务并逐项审阅',
  'systematic-debugging':'复现问题、定位根因，再验证修复',
  'test-driven-development':'先写失败测试，再实现功能并整理代码',
  'using-git-worktrees':'为开发任务创建隔离的 Git 工作目录',
  'using-superpowers':'选择并调用 Superpowers 的开发工作流',
  'verification-before-completion':'交付前执行验证，保留实际结果与证据',
  'writing-hookify-rules':'编写 Claude 行为约束与提示规则',
  'writing-plans':'将需求拆成有检查点的实施计划',
  'writing-skills':'编写、测试并维护可复用技能',
  'banner-design':'设计社交媒体、广告和网页横幅',
  'brand':'规划品牌表达、视觉识别与素材规范',
  'design':'设计品牌、界面和视觉素材',
  'design-system':'建立配色、字体与组件规范',
  'logo-design':'设计品牌标识与 Logo 方案',
  'slides':'制作响应式 HTML 演示文稿',
  'ui-styling':'实现界面样式、主题与无障碍组件'
};
const PLUGINS = {
  'claude-md-management':'维护 CLAUDE.md，整理项目规则与会话经验',
  'code-review':'审查 PR 代码，定位潜在问题并给出审阅意见',
  'codex':'在 Claude 中调用 Codex 执行代码任务与审查',
  'commit-commands':'辅助 Git 提交、推送和创建 PR',
  'context7':'查询软件库的文档与使用示例',
  'differential-review':'检查代码变更带来的安全风险',
  'feature-dev':'串联代码探索、架构设计和功能实现审查',
  'frontend-design':'设计并实现前端页面与交互',
  'hookify':'把容易出错的操作转成自动提醒或约束规则',
  'playwright':'使用浏览器自动化检查网页与交互',
  'pr-review-toolkit':'从代码、测试和异常处理等方面审阅 PR',
  'security-guidance':'在开发中提示常见代码安全问题',
  'superpowers':'提供需求澄清、测试驱动、调试和审阅工作流',
  'supply-chain-risk-auditor':'检查项目依赖与软件供应链风险',
  'variant-analysis':'根据已知漏洞模式查找相似问题',
  'gh-cli':'使用 GitHub 命令行处理仓库、Issue 和 PR',
  'git-cleanup':'检查和整理 Git 分支及工作目录',
  'modern-python':'使用现代 Python 工具组织和维护项目',
  'property-based-testing':'通过自动生成输入验证代码应满足的性质',
  'pyright-lsp':'为 Python 代码提供类型分析与语言服务',
  'second-opinion':'为代码或安全问题获取第二份分析意见',
  'sharp-edges':'检查容易误用的 API、配置和设计',
  'browser-use':'在 Codex 内置浏览器中浏览、操作和验证页面'
};
const MCP = {
  'playwright':'自动操作浏览器，检查网页、点击流程与截图',
  'chatgpt-web-images':'通过 ChatGPT 网页生成图片，并下载生成结果',
  'bailian_image':'调用百炼图像生成服务',
  'bailian_video':'调用百炼视频生成服务',
  'bailian_code_interpreter':'调用百炼代码执行与计算服务',
  'bailian_search':'调用百炼搜索服务，检索网络资料',
  'bailian_web_fetch':'调用百炼网页读取服务，提取网页内容',
  'bailian_vertical_search':'调用百炼垂直领域检索服务',
  'bailian_tts':'调用百炼语音合成服务，将文字转为语音',
  'bailian_asr':'调用百炼语音识别服务，将音频转为文字'
};
function summaryFor(row) {
  const name=row.name.toLowerCase().split('@')[0];
  const lookup=map=>Object.hasOwn(map,name)?map[name]:undefined;
  const known=row.type==='mcp'?lookup(MCP):row.type==='plugin'?(lookup(PLUGINS)||lookup(SKILLS)):lookup(SKILLS);
  if(known)return {text:known,source:'Hub 用途简述'};
  const raw=String(row.description||'').replace(/\s+/g,' ').trim();
  if(!raw||/^(标准 MCP 服务器|项目 MCP 服务器|Codex 插件|Claude 插件)$/.test(raw))
    return {text:'尚无用途说明，可在详情中补充简述',source:'待补充'};
  const first=raw.split(/(?:。|\.\s|\sUse when:|\s适用于|\s触发词[:：])/)[0];
  return {text:first.length>100?first.slice(0,99)+'…':first,source:'条目原始说明'};
}
module.exports={summaryFor};
