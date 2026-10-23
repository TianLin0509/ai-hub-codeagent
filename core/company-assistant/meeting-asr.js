'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Optional local runtime. Never installs into the Hub/shared node_modules.
class MeetingAsr {
  constructor(root) { this.root = root; this.phase = ''; this.error = ''; this.child = null; this.pending = new Map(); this.seq = 0; }
  get python() { const portable = path.join(this.root, 'python', 'python.exe'); return fs.existsSync(path.join(this.root, 'portable-ready')) ? portable : path.join(this.root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  get model() { return path.join(this.root, 'model'); }
  status() { return { ready: fs.existsSync(path.join(this.root, 'ready.json')), phase: this.phase, error: this.error }; }
  run(exe, args) {
    if (this.closed) return Promise.reject(new Error('Hub 已关闭，安装已中断'));
    return new Promise((resolve, reject) => {
      const p = spawn(exe, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.installChild = p;
      let tail = ''; const log = fs.createWriteStream(path.join(this.root, 'install.log'), { flags: 'a' });
      for (const stream of [p.stdout, p.stderr]) stream.on('data', b => { log.write(b); tail = (tail + b.toString()).slice(-2000); });
      p.on('error', e => { log.end(); reject(e); });
      p.on('close', code => { log.end(); this.installChild = null; code === 0 ? resolve() : reject(new Error(tail || '语音组件安装未完成')); });
    });
  }
  install() {
    if (this.installing) return this.status();
    this.closed = false; fs.mkdirSync(this.root, { recursive: true }); this.error = ''; this.phase = '准备独立语音环境，首次需要下载';
    this.installing = (async () => {
      if (!fs.existsSync(this.python)) {
        try { await this.run('python', ['-m', 'venv', path.join(this.root, 'venv')]); }
        catch {
          try { await this.run('py', ['-3', '-m', 'venv', path.join(this.root, 'venv')]); }
          catch { if (process.platform !== 'win32') throw new Error('需要 Python 3.10+'); await this.bootstrapPython(); }
        }
      }
      this.phase = '安装本地识别组件，预计数分钟';
      await this.run(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple', 'faster-whisper==1.2.1']);
      this.phase = '下载中文和英文识别模型，约 500 MB，时间取决于网络';
      await this.run(this.python, ['-c', 'from huggingface_hub import snapshot_download; import sys; snapshot_download("Systran/faster-whisper-small",local_dir=sys.argv[1],allow_patterns=["config.json","model.bin","tokenizer.json","vocabulary.*","preprocessor_config.json"])', this.model]);
      await this.run(this.python, ['-c', 'from faster_whisper import WhisperModel; import sys; WhisperModel(sys.argv[1],device="cpu",compute_type="int8",local_files_only=True)', this.model]);
      fs.writeFileSync(path.join(this.root, 'ready.json'), JSON.stringify({ version: 1, at: Date.now() })); this.phase = '';
    })().catch(e => { this.error = '安装未完成，可重试。请检查组件与模型下载网络：' + e.message; this.phase = ''; }).finally(() => { this.installing = null; });
    return this.status();
  }
  async bootstrapPython() {
    this.phase = '下载独立 Python 运行时，不改系统 Python';
    const download = async (url, file) => {
      if (this.closed) throw new Error('安装已中断');
      this.downloadAbort = new AbortController();
      const response = await fetch(url, { signal: this.downloadAbort.signal }); if (!response.ok) throw new Error('下载失败：HTTP ' + response.status);
      const b = Buffer.from(await response.arrayBuffer()); if (this.closed) throw new Error('安装已中断'); fs.writeFileSync(file, b);
    };
    const zip = path.join(this.root, 'python.zip'), dir = path.join(this.root, 'python');
    await download('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', zip);
    const quote = p => "'" + p.replace(/'/g, "''") + "'";
    const command = `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force`;
    await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    fs.writeFileSync(path.join(dir, 'python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
    const pip = path.join(this.root, 'get-pip.py'); await download('https://bootstrap.pypa.io/get-pip.py', pip);
    await this.run(path.join(dir, 'python.exe'), [pip, '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple']);
    fs.writeFileSync(path.join(this.root, 'portable-ready'), '3.12.10');
  }
  ensureWorker() {
    if (this.child) return;
    if (!this.status().ready) throw new Error('本地语音组件尚未准备好；音频已保存，安装后可补转写');
    const script = path.join(this.root, 'worker.py');
    fs.copyFileSync(path.join(__dirname, '../../scripts/meeting-asr-worker.py'), script);
    const p = spawn(this.python, ['-u', script, this.model], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '2' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = p;
    const rejectAll = e => { if (this.child === p) this.child = null; for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(e); } this.pending.clear(); };
    p.on('error', rejectAll); p.on('exit', () => rejectAll(new Error('本地识别进程已停止，音频保留，可重试')));
    p.stderr.on('data', b => { this.workerLog = (this.workerLog || '') + b.toString(); this.workerLog = this.workerLog.slice(-2000); });
    readline.createInterface({ input: p.stdout }).on('line', line => {
      let r; try { r = JSON.parse(line); } catch { return; }
      const q = this.pending.get(r.id); if (!q) return;
      this.pending.delete(r.id); clearTimeout(q.timer); r.error ? q.reject(new Error(r.error)) : q.resolve(r.segments);
    });
  }
  transcribe(file) {
    this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.close(); }, 10 * 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, file }) + '\n');
    });
  }
  close() { this.closed = true; this.downloadAbort?.abort(); if (this.child) this.child.kill(); this.child = null; if (this.installChild) this.installChild.kill(); }
}
module.exports = { MeetingAsr };
