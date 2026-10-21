'use strict';
// 助理会话（CodeAgent）调用 welink-cli 的只读包装：只放行查询类子命令，其余直接拒绝（白名单见 welink.js）。
// 用法（Hub 写进助理工作目录的 welink-ro.cmd 会这样调用）：<Hub 程序> welink-ro.js <welink-cli 参数…>
const W = require('./welink');
const D = require('./data');
const { resolveNames } = require('./identity');

async function runReadOnly(args, { run = W.run, cli = W.resolveCli({ configured: process.env.CLAUDE_HUB_WELINK_CONFIGURED || '' }), cacheDir = process.env.CLAUDE_HUB_ASSISTANT_DIR } = {}) {
  W.checkArgs(args);
  if (!args.includes('--help') && (args[0] === 'calendar' && args[1] === 'list' || args[0] === 'meeting' && args[1] === 'query-list'))
    throw new Error('按范围查询会议和日程请用本会话的 welink_meetings MCP；它统一处理日期边界、分页和时区。单场详情可用 meeting info 补查。');
  const execute = (a, opts = {}) => run(a, { cli, timeoutMs: 60000, ...opts, allowSetup: false });
  const result = await execute(args);
  if (Number(result.code || 0) !== 0 || args[0] !== 'im' || args[1] !== 'query-history-message') return result;
  const raw = W.parseJsonBig(result.stdout);
  if (!raw || (raw.resultCode !== undefined && String(raw.resultCode) !== '0') || (raw.code !== undefined && !['0', '200'].includes(String(raw.code)))) return result;
  const rows = D.messageRecords(raw);
  if (!rows?.length) return result;
  let identity;
  try { const auth = await execute(['auth', 'status'], { timeoutMs: 5000 }); const state = W.loginState(auth.stdout + '\n' + auth.stderr); if (Number(auth.code || 0) === 0 && state.ok) identity = state.uid; } catch { /* 姓名不可查时保留消息 */ }
  const accounts = rows.map(m => String(m.sender ?? m.sender_account ?? m.senderAccount ?? ''));
  const seeds = new Map(rows.map((m, i) => [accounts[i], m.senderName || m.sender_name || m.native_name || '']));
  const resolution = await resolveNames({ run: execute, cacheDir, identity, accounts, seeds });
  rows.forEach((m, i) => {
    const entry = resolution.entries.get(accounts[i]);
    if (!entry) return;
    // sender 永远保留厂商账号；手机本人识别和其他原始消费者不受显示名影响。
    Object.assign(m, { senderName: entry.name || '', displayName: entry.displayName, nameStatus: entry.status, nameSource: entry.source, nameResolvedAt: entry.resolvedAt || null });
  });
  return { ...result, stdout: JSON.stringify(raw) + '\n' };
}

if (require.main === module) (async () => {
  try {
    const args = process.argv.slice(2);
    // 初始化邮件及登录均由 Hub 主进程维护，Agent 包装只允许查询。
    const result = await runReadOnly(args);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code || 0;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
})();

module.exports = { runReadOnly };
