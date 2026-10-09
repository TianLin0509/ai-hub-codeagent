'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
class HubBrowserSetup {
  constructor({ root, env = process.env }) { this.root = root; this.env = env; this.progress = null; this.flight = null; }
  args() {
    const isolated = this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR;
    if (!isolated) throw new Error('社区版未附带本机生图与中转工具，可在账号中心直接登录网页');
    const base = path.join(this.root, 'tool-fixtures');
    const pool = path.join(base, 'ChatGPTWebImagesPool');
    const bridge = path.join(base, 'ChatGPTBridge/config.json');
    const playwright = require.resolve('playwright');
    return [path.resolve(__dirname, '../scripts/hub-browser-setup.py'), '--root', this.root, '--repo', path.resolve(__dirname, '..'), '--pool', pool, '--bridge', bridge, '--playwright', playwright];
  }
  run(choices) {
    const args = this.args();
    if (choices) args.push('--choices', JSON.stringify(choices));
    const python = path.join(os.homedir(), 'AppData/Local/Programs/Python/Python312/python.exe');
    return new Promise((resolve, reject) => {
      const child = spawn(fs.existsSync(python) ? python : 'python', args, { env: { ...this.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '', result, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (this.progress) this.progress.stage = '接入仍在进行，请保留窗口等待安全收尾'; }, 90000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try { const value = JSON.parse(line); if (value.stage && this.progress) this.progress.stage = value.stage; if (typeof value.ok === 'boolean') result = value; }
          catch { /* stdout may include a Python warning; only a valid final result succeeds */ }
        }
      });
      child.stderr.resume();
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); code === 0 && result?.ok ? resolve(result) : reject(Error(result?.error || (timedOut ? '接入未完成，请检查工具状态后重试' : '工具接入未返回有效结果'))); });
    });
  }
  async discover() { const result = await this.run(); return { groups: result.groups, progress: this.progress }; }
  start(choices) {
    if (this.flight) return this.progress;
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 20 || Object.values(choices).some(i => !['main', 'alt'].includes(i))) throw Error('请选择工具对应的 ChatGPT 账号');
    const isolated = this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR;
    const gitEntry = path.resolve(__dirname, '../.git');
    if (!isolated && fs.existsSync(gitEntry) && fs.statSync(gitEntry).isFile()) throw Error('请先将此版本合入主目录，再接入真实工具；不会将生产工具绑定到临时工作树');
    this.progress = { status: 'running', stage: '正在核对工具与队列状态' };
    this.flight = Promise.resolve().then(() => this.run(choices)).then(result => { this.progress = { status: 'complete', stage: '已统一接入专属 Chrome', backup: result.backup }; })
      .catch(e => { this.progress = { status: 'failed', stage: '接入未完成', error: e.message }; }).finally(() => { this.flight = null; });
    return this.progress;
  }
}
module.exports = { HubBrowserSetup };
