'use strict';
// 助理会话（CodeAgent）调用 welink-cli 的只读包装：只放行查询类子命令，其余直接拒绝（白名单见 welink.js）。
// 用法（Hub 写进助理工作目录的 welink-ro.cmd 会这样调用）：<Hub 程序> welink-ro.js <welink-cli 参数…>
const { run, resolveCli } = require('./welink');

(async () => {
  try {
    const args = process.argv.slice(2);
    // 例外只有 mail autodiscover：只写 welink-cli 自己的本地配置（按邮箱找 Exchange 服务器），助理兜底配置邮件时要用；扫码登录仍只能由用户在页面上点。
    const autodiscover = args[0] === 'mail' && args[1] === 'autodiscover';
    const result = await run(args, { cli: resolveCli({ configured: process.env.CLAUDE_HUB_WELINK_CONFIGURED || '' }), timeoutMs: autodiscover ? 120000 : 60000, allowSetup: autodiscover });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code || 0;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
})();
