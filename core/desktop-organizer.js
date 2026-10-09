'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const storageRoots = require('./storage-roots');
const { copyThenRemove } = require('./cross-volume-move');
const run = promisify(execFile);
const launcher = name => /\.(lnk|url|bat|cmd)$/i.test(name);
const inside = (root, value) => { const rel = path.relative(root, value); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function windowsDesktopEntries() {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory') | Select-Object -Unique); $items=@($roots | ForEach-Object { $root=$_; Get-ChildItem -LiteralPath $root -Force | ForEach-Object { [pscustomobject]@{root=$root; name=$_.Name; hidden=[bool]($_.Attributes -band ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)); link=[bool]($_.Attributes -band [IO.FileAttributes]::ReparsePoint)} } }); [pscustomobject]@{roots=$roots;items=$items} | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim() || '[]');
}
// 归档与历史产物都落在产物根（AI_HUB_ARTIFACTS_ROOT，默认 ~/AI-Artifacts）下；它可能与桌面不在同一盘。
function createDesktopOrganizer({ home = os.homedir(), testRoot, artifactsRoot } = {}) {
  const artifacts = testRoot ? path.join(testRoot, 'AI-Artifacts') : path.resolve(artifactsRoot || storageRoots.artifactsRoot({ home }));
  const archive = testRoot ? path.join(testRoot, 'Desktop-Archive') : path.join(artifacts, 'Desktop-Archive');
  const roots = testRoot ? [path.join(testRoot, 'Desktop'), path.join(testRoot, 'PublicDesktop')] : null;
  let plan = null, desktopRoots = roots;
  async function entries() {
    if (!roots) { const data = await windowsDesktopEntries(); desktopRoots = data.roots; return data.items; }
    const rows = [];
    for (const root of roots) {
      await fs.mkdir(root, { recursive: true });
      for (const name of await fs.readdir(root)) rows.push({ root, name, hidden: name.startsWith('.') || name === 'desktop.ini' });
    }
    return rows;
  }
  async function scan() {
    const rows = await entries();
    const id = randomUUID();
    const batch = new Date().toISOString().replace(/[:.]/g, '-') + '-' + id;
    const items = [], retained = [];
    for (const row of rows) {
      const source = path.join(row.root, row.name), stat = await fs.lstat(source);
      if (row.hidden || row.link || stat.isSymbolicLink() || row.name.startsWith('.')) { retained.push(row.name); continue; }
      const isLauncher = launcher(row.name);
      const target = row.name === 'claude-artifacts' && stat.isDirectory()
        ? path.join(artifacts, '历史桌面产物', batch, row.name)
        : path.join(archive, batch, isLauncher ? '启动入口' : '桌面资料', path.basename(row.root), row.name);
      items.push({ key: randomUUID(), name: row.name, source, target, kind: isLauncher ? '启动入口' : stat.isDirectory() ? '文件夹' : '文件', selected: !isLauncher,
        fingerprint: [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':') });
    }
    plan = { ok: true, id, batch, archive, artifacts, items, retained };
    return plan;
  }
  async function lock(action) {
    await fs.mkdir(archive, { recursive: true });
    const lockDir = path.join(archive, '.organizer-lock');
    try { await fs.mkdir(lockDir); } catch (e) { if (e.code === 'EEXIST') throw new Error('桌面整理被其他操作占用；如上次意外退出，请检查归档记录后再处理锁目录'); throw e; }
    try { return await action(); } finally { await fs.rmdir(lockDir); }
  }
  async function save(receipt, file) {
    const temp = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  }
  async function move(source, target) {
    if (await exists(target)) throw new Error('目标已存在，已保留原文件');
    for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (await exists(parent)) { const stat = await fs.lstat(parent); if (stat.isSymbolicLink()) throw new Error('目标目录含链接，已保留原文件'); }
    }
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error('目录链接已保留');
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Files use an exclusive hard link; folder destinations have a unique batch UUID.
    // Desktop (C:) and the artifacts root (may be D:) can sit on different volumes:
    // hard links and rename then fail with EXDEV, so fall back to an exclusive copy + delete.
    if (stat.isFile()) {
      try { await fs.link(source, target); }
      catch (e) { if (e.code !== 'EXDEV') throw e; await copyThenRemove(source, target); return; }
      try { await fs.unlink(source); } catch (e) { await fs.unlink(target); throw e; }
    } else if (stat.isDirectory()) {
      try { await fs.rename(source, target); }
      catch (e) { if (e.code !== 'EXDEV') throw e; await copyThenRemove(source, target); }
    } else throw new Error('此项目不是普通文件或文件夹');
  }
  async function execute({ id, keys } = {}) {
    if (!plan || id !== plan.id) throw new Error('预览已过期，请重新扫描');
    if (!Array.isArray(keys) || !keys.length) throw new Error('请选择需要收走的项目');
    const chosen = new Set(keys), snapshot = plan;
    if (keys.some(key => !snapshot.items.some(item => item.key === key))) throw new Error('清单不匹配，请重新扫描');
    return lock(async () => {
      plan = null;
      const receipt = { version: 1, batch: snapshot.batch, createdAt: new Date().toISOString(), rows: snapshot.items.filter(item => chosen.has(item.key)).map(item => ({ ...item, status: 'pending' })) };
      const file = path.join(archive, snapshot.batch + '.json');
      await save(receipt, file);
      for (const row of receipt.rows) {
        try {
          const stat = await fs.lstat(row.source);
          if ([stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':') !== row.fingerprint) throw new Error('预览后项目有变化，请重新扫描');
          await move(row.source, row.target); row.status = 'moved';
        } catch (e) { row.status = 'skipped'; row.error = e.message; }
        await save(receipt, file);
      }
      return { ok: true, receipt: file, moved: receipt.rows.filter(row => row.status === 'moved').length, rows: receipt.rows };
    });
  }
  async function undo() {
    return lock(async () => {
      const files = (await fs.readdir(archive)).filter(name => /^\d{4}-.*\.json$/.test(name)).sort().reverse();
      let receipt, file;
      for (const name of files) {
        const candidate = JSON.parse(await fs.readFile(path.join(archive, name), 'utf8'));
        if (candidate.rows.some(row => row.status === 'moved' || row.status === 'pending')) { receipt = candidate; file = path.join(archive, name); break; }
      }
      if (!receipt) throw new Error('没有可以撤销的整理记录');
      if (!desktopRoots) await entries();
      const allowed = desktopRoots;
      let restored = 0;
      for (const row of receipt.rows) {
        if (!['moved', 'pending'].includes(row.status)) continue;
        if (!allowed.some(root => path.dirname(row.source).toLowerCase() === root.toLowerCase()) || !(inside(archive, row.target) || inside(artifacts, row.target))) throw new Error('整理记录中的路径不合法');
        try {
          if (row.status === 'pending' && !(await exists(row.target))) { row.status = 'skipped'; continue; }
          await move(row.target, row.source); row.status = 'restored'; restored++; delete row.error;
        } catch (e) { row.error = e.message; }
        await save(receipt, file);
      }
      await save(receipt, file);
      return { ok: true, receipt: file, restored, rows: receipt.rows };
    });
  }
  return { scan, execute, undo, archive, artifacts };
}
module.exports = { createDesktopOrganizer, inside };
