'use strict';
// 一键更新的版本清单 latest.json（2026-10-13，公司版）。发版时由 scripts/prepare-release.js 在 CI 里
// 按真正打出来的包生成，GitHub Release 和阿里云放同一份。客户端只信清单里的大小和 sha256。
//
// {
//   "schema": 1, "product": "AI Hub Community", "version": "1.0.1", "publishedAt": "...", "notes": ["..."],
//   "runtime": { "electron": "41.2.0", "native": { "node-pty": "1.1.0" } },
//   "incremental": { "file": "AIHubHuawei-1.0.1-update.gz", "bytes": 7467767, "sha256": "..." },
//   "installer":   { "file": "AIHubHuawei-Setup-1.0.1.exe", "bytes": 94000000, "sha256": "..." }
// }
//
// 增量包只换 app.asar 和 app.asar.unpacked 里不属于依赖的文件；Electron 或原生依赖的版本变了
// （runtime 对不上）就只能走完整安装包。
const fs = require('fs');
const path = require('path');

const SHA = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9._-]{1,120}$/;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error(`版本号无法比较：${a} / ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function checkAsset(asset, label) {
  if (!asset || typeof asset !== 'object') throw new Error(`清单缺少${label}`);
  if (!FILE.test(String(asset.file || ''))) throw new Error(`清单里${label}的文件名不合规`);
  if (!Number.isInteger(asset.bytes) || asset.bytes < 1024 || asset.bytes > 600 * 1024 * 1024) throw new Error(`清单里${label}的大小不在允许范围`);
  if (!SHA.test(String(asset.sha256 || ''))) throw new Error(`清单里${label}的校验值无效`);
  return { file: asset.file, bytes: asset.bytes, sha256: asset.sha256 };
}

function validateManifest(raw) {
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!m || m.schema !== 1) throw new Error('版本清单的格式不认识');
  if (!parseVersion(m.version)) throw new Error('版本清单里的版本号无效');
  const runtime = m.runtime && typeof m.runtime === 'object' ? m.runtime : null;
  if (!runtime || !/^\d+\.\d+\.\d+/.test(String(runtime.electron || ''))) throw new Error('版本清单缺少运行时信息');
  return {
    schema: 1,
    product: String(m.product || ''),
    version: String(m.version).replace(/^v/, ''),
    publishedAt: String(m.publishedAt || ''),
    notes: Array.isArray(m.notes) ? m.notes.map(String).slice(0, 30) : [],
    runtime: { electron: String(runtime.electron), native: runtime.native && typeof runtime.native === 'object' ? { ...runtime.native } : {} },
    incremental: m.incremental ? checkAsset(m.incremental, '增量包') : null,
    installer: checkAsset(m.installer, '完整安装包'),
  };
}

// 本机运行时：Electron 版本 + app.asar.unpacked/node_modules 下各依赖的版本。
function currentRuntime({ resourcesPath = process.resourcesPath, electron = process.versions.electron } = {}) {
  const native = {};
  const dir = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules') : null;
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const candidates = name.startsWith('@') ? fs.readdirSync(path.join(dir, name)).map(n => `${name}/${n}`) : [name];
      for (const pkg of candidates) {
        try { native[pkg] = JSON.parse(fs.readFileSync(path.join(dir, pkg, 'package.json'), 'utf8')).version || ''; } catch (_) {}
      }
    }
  }
  return { electron: String(electron || ''), native };
}

function sameRuntime(a, b) {
  if (!a || !b || a.electron !== b.electron) return false;
  const keys = new Set([...Object.keys(a.native || {}), ...Object.keys(b.native || {})]);
  for (const k of keys) if ((a.native || {})[k] !== (b.native || {})[k]) return false;
  return true;
}

// 该怎么更新：none（已是最新）/ incremental（只换 app.asar）/ full（完整安装包），附一句人话原因。
function planUpdate(manifest, { version, runtime }) {
  if (compareVersions(manifest.version, version) <= 0) return { kind: 'none', reason: `已是最新：v${version}` };
  if (!manifest.incremental) return { kind: 'full', reason: '这一版只提供完整安装包' };
  if (!sameRuntime(manifest.runtime, runtime)) {
    const why = manifest.runtime.electron !== runtime.electron ? `底层运行时从 Electron ${runtime.electron} 升到 ${manifest.runtime.electron}` : '终端组件等原生依赖有变化';
    return { kind: 'full', reason: `${why}，需要完整安装包` };
  }
  return { kind: 'incremental', reason: '只需下载变化的程序文件' };
}

module.exports = { parseVersion, compareVersions, validateManifest, currentRuntime, sameRuntime, planUpdate };
