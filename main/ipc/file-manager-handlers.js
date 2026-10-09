'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const { checkedPath, walkFiles, fileOperation } = require('../../core/file-manager-service');
const { createFolderActivityService } = require('../../core/file-manager-activity');
// 社区版不附带中转工具；交付目标保留同一接口，调用时如实报告不可用。
const unavailable = { ok: false, error: '社区版未包含这个交付工具' };
const runChatgptBridge = async () => unavailable;
const resolveChatgptBridgeRuntime = () => ({ error: unavailable.error });
const parseBridgeOutput = () => unavailable;

function registerFileManagerIpc(ipcMain, deps = {}) {
  const electron = deps.electron || require('electron');
  const exec = deps.execFile || promisify(execFile);
  const jobs = new Map();
  const queue = [];
  let working = false;
  const jobDir = path.join(deps.dataDir || process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.ai-hub-community'), 'file-transfers');
  const handle = (name, fn) => ipcMain.handle(`file-manager:${name}`, async (event, payload = {}) => {
    try { return await fn(payload || {}, event); }
    catch (error) { return { ok: false, error: error.message, code: error.code || 'operation_failed' }; }
  });
  async function pathsFrom(p) {
    if (!Array.isArray(p.paths) || !p.paths.length || p.paths.length > 200) throw new Error('请选择 1–200 项');
    return Promise.all([...new Set(p.paths)].map(value => checkedPath(p.root, value)));
  }
  handle('scan', async p => {
    const result = await walkFiles(p.root, { query: String(p.query || '') });
    // since：只回传该时刻之后修改的文件（「本会话改动」），避免把整棵树搬过 IPC。
    if (Number.isFinite(p.since) && p.since > 0) result.entries = result.entries.filter(entry => entry.mtimeMs >= p.since);
    if (p.recent) result.entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (Number.isInteger(p.limit) && p.limit > 0 && result.entries.length > p.limit) {
      result.entries = result.entries.slice(0, p.limit);
      result.truncated = true;
    }
    return result;
  });
  const folderActivity = deps.folderActivity || createFolderActivityService();
  handle('folder-activity', p => folderActivity.lookup(p));
  handle('operation', p => fileOperation(p, electron.shell));
  handle('copy', async p => {
    const paths = await pathsFrom(p);
    if (p.kind === 'files') {
      const fakeClipboard = require('../../core/e2e-desktop-sandbox').activeFakeClipboard();
      if (fakeClipboard) { fakeClipboard.writeFiles(paths); return { ok: true }; }
      if (process.platform !== 'win32') throw new Error('文件剪贴板当前仅支持 Windows');
      const literals = paths.map(value => `'${value.replace(/'/g, "''")}'`).join(',');
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Set-Clipboard -LiteralPath @(${literals})`], { windowsHide: true, timeout: 15000 });
    } else if (p.kind === 'image') {
      if (paths.length !== 1) throw new Error('请选择一张图片');
      const picture = electron.nativeImage.createFromPath(paths[0]);
      if (picture.isEmpty()) throw new Error('该格式不能复制为图片');
      electron.clipboard.writeImage(picture);
    } else {
      let text;
      if (p.kind === 'content') {
        if (paths.length !== 1) throw new Error('请选择一个文本文件');
        const s = await fs.promises.stat(paths[0]);
        if (!s.isFile() || s.size > 5 * 1024 * 1024) throw new Error('文本文件上限为 5 MiB');
        text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.promises.readFile(paths[0]));
        if (text.includes('\0')) throw new Error('该文件不是 UTF-8 文本');
      } else text = paths.map(value => p.kind === 'relative' ? path.relative(p.root, value) : p.kind === 'name' ? path.basename(value) : value).join('\n');
      electron.clipboard.writeText(text);
    }
    return { ok: true };
  });
  function save(job) {
    fs.mkdirSync(jobDir, { recursive: true });
    const target = path.join(jobDir, `${job.id}.json`);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(job), 'utf8');
    fs.renameSync(temp, target);
  }
  const lockPath = job => path.join(jobDir, `${crypto.createHash('sha256').update(job.key).digest('hex')}.lock`);
  function release(job) {
    const target = lockPath(job);
    try {
      if (fs.readFileSync(target, 'utf8') === job.id) fs.unlinkSync(target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function runAttachment(paths) {
    const runtime = resolveChatgptBridgeRuntime();
    if (runtime.error) return { ok: false, ...runtime };
    try {
      const result = await exec(runtime.pythonPath, [path.join(__dirname, '../../scripts/chatgpt-file-draft.py'), '--bridge', runtime.bridgePath, ...paths],
        { windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
      return parseBridgeOutput(result.stdout, result.stderr, 0);
    } catch (error) { return parseBridgeOutput(error.stdout, error.stderr, error.code || 1); }
  }
  async function drain() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        if (job.state !== 'queued') continue;
        try {
          job.state = 'running'; save(job);
          for (const file of job.paths) await checkedPath(job.root, file);
          const result = job.target === 'company'
            ? await deps.runCompanyDrop(job.paths, deps.companyDropOptions)
            : await (deps.runAttachment || runAttachment)(job.paths);
          job.result = result;
          job.state = job.target === 'company' && result?.success === true ? 'completed'
            : job.target === 'chatgpt' && result?.ok === true && result?.prepared === true ? 'prepared'
              : ['timeout', 'invalid_response', 'browser_timeout', 'browser_transient', 'public_verify_failed', 'output_limit', 'attachment_prepare_failed', 'browser_command_failed'].includes(result?.code) ? 'unknown' : 'failed';
          job.error = result?.error || '';
        } catch (error) { job.state = 'unknown'; job.error = error.message; }
        job.finishedAt = Date.now();
        try {
          save(job);
          if (!['unknown', 'prepared', 'completed'].includes(job.state)) release(job);
        } catch (error) { job.error = `${job.error}\n记录保存失败：${error.message}`.trim(); }
      }
    } finally { working = false; }
  }
  handle('transfer', async p => {
    if (!['company', 'chatgpt'].includes(p.target)) throw new Error('未知交付目标');
    const paths = await pathsFrom(p);
    if (p.target === 'chatgpt') {
      if (paths.length > 10) throw new Error('每次最多准备 10 个附件');
      for (const file of paths) {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error('ChatGPT 附件需要文件；请先把目录压缩');
        if (stat.size > 20 * 1024 * 1024) throw new Error('当前附件准备上限为每个文件 20 MiB');
      }
    }
    const fingerprints = [];
    for (const file of paths) { const s = await fs.promises.stat(file); fingerprints.push([file.toLowerCase(), s.size, s.mtimeMs]); }
    const key = JSON.stringify([p.target, ...fingerprints.sort((a, b) => a[0].localeCompare(b[0]))]);
    const duplicate = [...jobs.values()].find(job => job.key === key && ['queued', 'running', 'unknown', 'prepared', 'completed'].includes(job.state));
    if (duplicate) return { ok: true, job: duplicate, duplicate: true };
    const job = { id: crypto.randomUUID(), key, root: p.root, paths, target: p.target, state: 'queued', createdAt: Date.now(), pid: process.pid };
    fs.mkdirSync(jobDir, { recursive: true });
    try { fs.writeFileSync(lockPath(job), job.id, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previousId = fs.readFileSync(lockPath(job), 'utf8');
      if (!/^[a-f0-9-]+$/i.test(previousId)) throw new Error('交付锁损坏，请核实记录后处理');
      const previous = JSON.parse(fs.readFileSync(path.join(jobDir, `${previousId}.json`), 'utf8'));
      return { ok: true, duplicate: true, job: { ...previous, state: ['running', 'queued'].includes(previous.state) ? 'unknown' : previous.state } };
    }
    try { save(job); } catch (error) { release(job); throw error; }
    jobs.set(job.id, job); queue.push(job);
    setImmediate(() => { void drain(); });
    return { ok: true, job };
  });
  handle('jobs', async () => {
    const disk = [];
    try {
      for (const name of (await fs.promises.readdir(jobDir)).filter(n => /^[a-f0-9-]+\.json$/i.test(n))) {
        try {
          const value = JSON.parse(await fs.promises.readFile(path.join(jobDir, name), 'utf8'));
          if (!jobs.has(value.id)) {
            // Another Hub may own it; never resume or resend on this process's behalf.
            if (['running', 'queued'].includes(value.state)) value.state = 'unknown';
            disk.push(value);
          }
        } catch (error) { disk.push({ id: name, state: 'failed', error: `记录读取失败：${error.message}`, paths: [] }); }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ok: true, jobs: [...jobs.values(), ...disk].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) };
  });
  handle('cancel-transfer', async p => {
    const job = jobs.get(p.id);
    if (!job || job.state !== 'queued') throw new Error('仅等待中的任务可以取消；处理中请等待结果');
    job.state = 'cancelled'; save(job); release(job); return { ok: true };
  });
  handle('resolve-transfer', async p => {
    if (!/^[a-f0-9-]+$/i.test(p.id || '')) throw new Error('无效记录');
    const job = jobs.get(p.id) || JSON.parse(fs.readFileSync(path.join(jobDir, `${p.id}.json`), 'utf8'));
    if (['queued', 'running'].includes(job.state)) {
      let ownerAlive = true;
      try { process.kill(job.pid, 0); } catch (error) { if (error.code === 'ESRCH') ownerAlive = false; else throw error; }
      if (ownerAlive) throw new Error('原 Hub 仍在运行，请先在原 Hub 核实任务');
      job.state = 'unknown';
    }
    if (!['unknown', 'prepared', 'completed'].includes(job.state)) throw new Error('只能确认待核实或已完成的任务');
    job.state = 'resolved'; job.resolvedAt = Date.now(); job.resolution = '用户已在目标端核实';
    save(job); release(job); jobs.set(job.id, job); return { ok: true };
  });
  handle('open-chatgpt', () => (deps.runBridge || runChatgptBridge)(['open']));
}

module.exports = { registerFileManagerIpc };
