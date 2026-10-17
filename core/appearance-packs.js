'use strict';
// Artwork is data only. Downloaded packs never contain scripts, paths or HTML.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkManifests, downloadWithFallback } = require('./app-update/downloader');

const ARTWORK_KEYS = Object.freeze(['claude', 'codex', 'gemini', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax']);
const ICON_STYLES = Object.freeze([
  { id: 'brand', name: '品牌原色' }, { id: 'round', name: '圆形徽章' },
  { id: 'tile', name: '方形贴纸' }, { id: 'mono', name: '黑白极简' },
  { id: 'night', name: '深色铭牌' }, { id: 'portrait', name: '跟随头像' },
]);
const MAX_PACK_BYTES = 12 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const DEFAULT_PREFERENCES = Object.freeze({ pack: 'default', overrides: {}, icons: 'brand', iconOverrides: {} });
const SOURCES = Object.freeze([
  { id: 'github', name: 'GitHub', manifest: 'https://github.com/TianLin0509/ai-hub-codeagent/releases/download/appearance-v1/catalog.json', files: 'https://github.com/TianLin0509/ai-hub-codeagent/releases/download/appearance-v1/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.lt-stockpartner.tech/hub-update/appearance/catalog.json', files: 'https://me.lt-stockpartner.tech/hub-update/appearance/' },
]);
function validImage(value) {
  if (typeof value !== 'string' || value.length > 1300000) return false;
  // Portable pack payloads use PNG. Uploaded JPEG/WebP are normalized by Chromium first.
  const m = /^data:image\/(png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return false;
  const b = Buffer.from(m[2], 'base64');
  if (b.length < 45 || b.toString('base64') !== m[2]) return false;
  return b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii', 12, 16) === 'IHDR'
    && b.readUInt32BE(16) > 0 && b.readUInt32BE(16) <= 2048 && b.readUInt32BE(20) > 0 && b.readUInt32BE(20) <= 2048;
}
function validatePack(raw) {
  if (!raw || raw.schema !== 1 || typeof raw.id !== 'string' || !ID.test(raw.id) || raw.id === 'default' || typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error('头像包标识或版本无效');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) throw new Error('头像包名称无效');
  const avatars = {};
  for (const key of ARTWORK_KEYS) {
    if (!validImage(raw.avatars?.[key])) throw new Error(`${key} 头像缺失或格式无效`);
    avatars[key] = raw.avatars[key];
  }
  return { schema: 1, id: raw.id, version: raw.version, name: raw.name, description: String(raw.description || '').slice(0, 200), avatars };
}
function validateCatalog(raw) {
  if (!raw || raw.schema !== 1 || typeof raw.version !== 'string' || !VERSION.test(raw.version) || !Array.isArray(raw.packs) || raw.packs.length > 100) throw new Error('头像目录格式无效');
  const ids = new Set();
  const packs = raw.packs.map(p => {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id) || ids.has(p.id) || typeof p.version !== 'string' || !VERSION.test(p.version) || p.file !== `${p.id}-${p.version}.json`
      || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_PACK_BYTES || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('头像包清单字段无效');
    ids.add(p.id);
    return { id: p.id, version: p.version, file: p.file, bytes: p.bytes, sha256: p.sha256, name: String(p.name || p.id).slice(0, 60), description: String(p.description || '').slice(0, 200) };
  });
  return { schema: 1, version: raw.version, packs };
}
function compareVersion(a, b) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}
function readJson(file, max = MAX_PACK_BYTES) {
  if (fs.statSync(file).size > max) throw new Error('文件超过允许大小');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
// Bound the response body too: a proxy can send headers and then stop forever.
function boundedCatalogFetch(fetchImpl, timeoutMs = 12000) {
  return async (url, options) => {
    const ac = new AbortController();
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, ac.signal]) });
    return { ok: response.ok, status: response.status, headers: response.headers, text: async () => {
      let timer, reader;
      try {
        return await Promise.race([
          new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('头像目录正文读取超时，请重试')); }, timeoutMs); }),
          (async () => {
            if (!response.body?.getReader) throw new Error('服务器没有返回头像目录');
            reader = response.body.getReader();
            const chunks = []; let total = 0;
            for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 128 * 1024) throw new Error('头像目录超过允许大小'); chunks.push(Buffer.from(value)); }
            return Buffer.concat(chunks).toString('utf8');
          })(),
        ]);
      } finally { clearTimeout(timer); ac.abort(); if (reader) void reader.cancel().catch(() => {}); }
    } };
  };
}
function createAppearanceStore({ dataDir, bundledDir = path.join(__dirname, '../renderer/assets/appearance-packs'), sources = SOURCES, fetchImpl = globalThis.fetch, emit = () => {}, decodeImage, catalogBodyTimeoutMs = 12000 }) {
  const root = path.join(dataDir, 'appearance');
  const prefsFile = path.join(root, 'preferences.json');
  const customFile = path.join(root, 'custom.json');
  const catalogFile = path.join(root, 'catalog.json');
  const packs = new Map(), custom = {};
  let catalog = null, preferences = { ...DEFAULT_PREFERENCES, overrides: {}, iconOverrides: {} };
  let state = { phase: 'idle', sources: sources.map(({ id, name }) => ({ id, name })), checks: [], attempts: [] };
  let checking = null, downloading = null, abort = null;
  const notify = patch => { state = { ...state, ...patch }; emit('appearance:state', state); return state; };
  for (const dir of [bundledDir, path.join(root, 'packs')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => /^[a-z0-9-]+-\d+\.\d+\.\d+\.json$/.test(f)).slice(0, 200)) {
      try {
        const pack = validatePack(readJson(path.join(dir, file)));
        if (decodeImage) for (const image of Object.values(pack.avatars)) decodeImage(image);
        // User-installed packs are read after bundled ones, so equal versions stay consistent across restarts.
        if (!packs.has(pack.id) || compareVersion(pack.version, packs.get(pack.id).version) >= 0) packs.set(pack.id, pack);
      } catch (error) { state.warnings = [...(state.warnings || []), `${file}：${error.message}`]; }
    }
  }
  try {
    const raw = readJson(customFile, 64 * 1024 * 1024);
    for (const [id, value] of Object.entries(raw)) if (/^custom-[a-f0-9]{64}$/.test(id) && validImage(value)) custom[id] = value;
  } catch (_) {}
  try { catalog = validateCatalog(readJson(catalogFile, 128 * 1024)); } catch (_) {}
  function validRef(ref) { return ref === 'default' || packs.has(ref) || Object.hasOwn(custom, ref); }
  function normalizePreferences(raw) {
    const result = { pack: packs.has(raw?.pack) ? raw.pack : 'default', icons: ICON_STYLES.some(s => s.id === raw?.icons) ? raw.icons : 'brand', overrides: {}, iconOverrides: {} };
    for (const key of ARTWORK_KEYS) {
      if (validRef(raw?.overrides?.[key])) result.overrides[key] = raw.overrides[key];
      if (validRef(raw?.iconOverrides?.[key])) result.iconOverrides[key] = raw.iconOverrides[key];
    }
    return result;
  }
  try { preferences = normalizePreferences(readJson(prefsFile, 16000)); } catch (_) {}
  function snapshot() { return { preferences, packs: [...packs.values()], custom: { ...custom }, catalog, state, iconStyles: ICON_STYLES }; }
  function savePreferences(value) {
    preferences = normalizePreferences(value);
    atomicJson(prefsFile, preferences);
    const usedCustom = {};
    for (const ref of [...Object.values(preferences.overrides), ...Object.values(preferences.iconOverrides)]) if (Object.hasOwn(custom, ref)) usedCustom[ref] = custom[ref];
    const change = { preferences, custom: usedCustom };
    emit('appearance:preferences', change);
    return change;
  }
  function saveCustom(image) {
    if (!validImage(image)) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片');
    const id = `custom-${crypto.createHash('sha256').update(image).digest('hex')}`;
    if (Object.keys(custom).length >= 48) {
      const used = new Set([...Object.values(preferences.overrides), ...Object.values(preferences.iconOverrides)]);
      for (const old of Object.keys(custom)) if (!used.has(old)) delete custom[old];
    }
    custom[id] = image;
    atomicJson(customFile, custom);
    return { id, image };
  }
  async function check() {
    if (checking) return checking;
    if (downloading) return state;
    checking = (async () => {
      notify({ phase: 'checking', error: null, checks: [], attempts: [], progress: null });
      const results = await checkManifests({ sources, fetchImpl: boundedCatalogFetch(fetchImpl, catalogBodyTimeoutMs), validate: validateCatalog });
      const best = results.filter(r => r.ok).sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))[0];
      const checks = results.map(({ id, name, ok, reason, blocked, url }) => ({ id, name, ok, reason, blocked, url }));
      if (!best) return notify({ phase: 'error', checks, error: '暂时无法获取头像目录，已安装的头像仍可使用。可以稍后重试或导入头像包。' });
      catalog = best.manifest;
      atomicJson(catalogFile, catalog);
      return notify({ phase: 'available', checks, catalog, error: null });
    })().finally(() => { checking = null; });
    return checking;
  }
  function install(raw, expected) {
    const pack = validatePack(raw);
    if (expected && (pack.id !== expected.id || pack.version !== expected.version)) throw new Error('头像包与所选目录不一致');
    if (packs.has(pack.id) && compareVersion(pack.version, packs.get(pack.id).version) < 0) throw new Error('已安装的头像包更新，无需安装旧版本');
    if (decodeImage) for (const image of Object.values(pack.avatars)) decodeImage(image);
    atomicJson(path.join(root, 'packs', `${pack.id}-${pack.version}.json`), pack);
    packs.set(pack.id, pack);
    emit('appearance:changed', snapshot());
    return snapshot();
  }
  async function download(id) {
    if (downloading) throw new Error('正在下载另一套头像，请等待完成');
    const entry = catalog?.packs.find(p => p.id === id);
    if (!entry) throw new Error('请先检查更新，再选择要下载的头像');
    abort = new AbortController();
    downloading = (async () => {
      notify({ phase: 'downloading', activeId: id, error: null, attempts: [], progress: null });
      const dest = path.join(root, 'downloads', entry.file);
      const activeAbort = abort;
      const cancellableFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, activeAbort.signal]) });
      const result = await downloadWithFallback({ sources, version: entry.version, expect: entry, dest, fetchImpl: cancellableFetch, signal: abort.signal,
        onProgress: progress => notify({ progress }), onAttempt: attempts => notify({ attempts }) });
      if (!result.ok) return notify({ phase: result.cancelled ? 'cancelled' : 'error', error: result.cancelled ? '下载已取消，可以重新下载' : '下载失败，可重试；原有头像没有改变。' });
      install(readJson(dest), entry);
      return notify({ phase: 'installed', error: null, installedId: id });
    })().catch(error => notify({ phase: 'error', error: error.message })).finally(() => { downloading = null; abort = null; });
    return downloading;
  }
  return { snapshot, savePreferences, saveCustom, check, download, install, cancel: () => abort?.abort() };
}
module.exports = { ARTWORK_KEYS, ICON_STYLES, MAX_PACK_BYTES, SOURCES, DEFAULT_PREFERENCES, validImage, validatePack, validateCatalog, compareVersion, readJson, boundedCatalogFetch, createAppearanceStore };
