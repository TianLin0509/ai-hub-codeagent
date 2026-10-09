'use strict';
// GH_BROWSER invokes this helper. Only GitHub's device authorization page is
// accepted; credentials and codes stay in the official CLI and website.
async function main(argv = process.argv.slice(2), chrome) {
  if (argv.length !== 1) throw Error('GitHub 授权地址无效');
  const url = new URL(argv[0]);
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.pathname.replace(/\/$/, '') !== '/login/device') throw Error('GitHub 授权地址无效');
  await (chrome || new (require('../core/hub-chrome').HubChrome)()).openWebsite('main', 'githubDevice');
}
if (require.main === module) main().catch(() => { process.stderr.write('无法打开 Hub 专属 Chrome，请先结束其中的网页任务，再在账号页重试 GitHub 授权。\n'); process.exitCode = 1; });
module.exports = { main };
