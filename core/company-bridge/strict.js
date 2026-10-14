'use strict';
// 公司 CodeAgent 的「启动参数只读」开关（默认开）。公司真机的 CodeAgent 若不认 --disallowedTools，
// 可在「家里联动」里关掉，退回只靠说明约束。用数据目录里的一个标记文件，恢复、重拉会话时也能读到。
const fs = require('node:fs');
const path = require('node:path');
const flagFile = () => path.join(require('../data-dir').getHubDataDir(), 'company-bridge', 'readonly-flags-off');
function strictEnabled() { try { return !fs.existsSync(flagFile()); } catch { return true; } }
function setStrict(on) {
  const file = flagFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (on) { try { fs.unlinkSync(file); } catch {} } else fs.writeFileSync(file, 'off\n');
}
module.exports = { strictEnabled, setStrict };
