'use strict';
// 助理会话（CodeAgent）调用 welink-cli 的只读包装：只放行查询类子命令，其余直接拒绝（白名单见 welink.js）。
// 用法（Hub 写进助理工作目录的 welink-ro.cmd 会这样调用）：<Hub 程序> welink-ro.js <welink-cli 参数…>
const { run, resolveCli } = require('./welink');

(async () => {
  try {
    const result = await run(process.argv.slice(2), { cli: resolveCli({ configured: process.env.CLAUDE_HUB_WELINK_CONFIGURED || '' }), timeoutMs: 60000 });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code || 0;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
})();
