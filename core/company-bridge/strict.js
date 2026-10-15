'use strict';
// 公司 CodeAgent 会话的权限（落在启动参数 --disallowedTools 上，不只靠说明）。存数据目录里的小文件，恢复、重拉会话时也能读到。
// 2026-10-15 放开成通用助手后默认改为「可跑查询命令、不能用改写工具」；第一版的「连命令行也禁」保留为可选项。
// 旧版的标记文件 readonly-flags-off（只靠说明）继续认。
const fs = require('node:fs');
const path = require('node:path');
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'PowerShell']; // Windows 上的 CodeAgent / Claude 另有 PowerShell 工具
const MODES = Object.freeze({
  'no-edit': { label: '可运行查询命令，禁用改写文件的工具（推荐）', disallowed: EDIT_TOOLS },
  'read-only': { label: '只能读文件：命令行和改写工具都禁用', disallowed: [...SHELL_TOOLS, ...EDIT_TOOLS] },
  'prompt-only': { label: '只靠说明约束（CodeAgent 不认禁用参数时用）', disallowed: [] },
});
const DEFAULT_MODE = 'no-edit';
const dir = () => path.join(require('../data-dir').getHubDataDir(), 'company-bridge');
const legacyOff = () => path.join(dir(), 'readonly-flags-off');
const modeFile = () => path.join(dir(), 'permission-mode');
function mode() {
  try {
    const saved = fs.readFileSync(modeFile(), 'utf8').trim();
    if (MODES[saved]) return saved;
  } catch {}
  try { if (fs.existsSync(legacyOff())) return 'prompt-only'; } catch {}
  return DEFAULT_MODE;
}
function setMode(next) {
  if (!MODES[next]) throw new Error('权限只能是 ' + Object.keys(MODES).join(' / '));
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(modeFile(), next + '\n');
  try { fs.unlinkSync(legacyOff()); } catch {}
}
function disallowedTools() { return MODES[mode()].disallowed; }
// 旧接口：on=启动参数生效（按默认权限），off=只靠说明。
function strictEnabled() { return mode() !== 'prompt-only'; }
function setStrict(on) { setMode(on ? DEFAULT_MODE : 'prompt-only'); }
module.exports = { MODES, DEFAULT_MODE, mode, setMode, disallowedTools, strictEnabled, setStrict };
