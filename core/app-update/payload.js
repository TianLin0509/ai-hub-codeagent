'use strict';
// 增量更新包：一个 gzip 文件，里面是「一行 JSON 目录 + 各文件原样字节依次拼接」。
// 目录列出每个文件相对 resources 目录的路径、字节数和 sha256。不用 zip/tar，免得新增依赖；
// 解包时逐个核对 sha256，任何一个不对就整包作废。
//
// 内容：app.asar 本身，加上 app.asar.unpacked 里不属于 node_modules 的文件（打包时被标记成
// 「解包」的少量程序文件，它们跟着程序一起变）。依赖（node_modules）不进增量包：依赖一变就走完整安装包。
// Electron 会把名为 *.asar 的文件当成压缩包拦截（写 app.asar 会报 Invalid package），用它提供的原始文件接口。
//
// schema 2（v3.1.3，2026-10-22）：打包时给出上一版的文件索引，内容没变的解包文件只在目录的
// `unchanged` 里留下路径和 sha256、不再重复打包字节（会议室运行时 76.8MB 常年不变，是省下来的大头）。
// 解包时对 unchanged 逐个核对本机文件：对不上就报 stale-local，调用方改用完整包，绝不半套替换。
// schema 1（没有 unchanged）照旧能解，老版本的客户端也只认 schema 1 的包。
const fs = (() => { try { return require('original-fs'); } catch (_) { return require('fs'); } })();
const path = require('path');
const zlib = require('zlib');
const { createHash } = require('crypto');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const MAX_FILES = 2000;

function listPayloadFiles(resourcesDir) {
  const files = ['app.asar'];
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!(rel === '' && entry.name === 'node_modules')) walk(path.join(dir, entry.name), r); }
      else if (entry.isFile()) files.push(`app.asar.unpacked/${r}`);
    }
  };
  if (fs.existsSync(unpacked)) walk(unpacked, '');
  return files;
}

function safeRel(rel) {
  const s = String(rel || '');
  if (!s || s.length > 400 || /\\|^\/|(^|\/)\.\.(\/|$)|:/.test(s)) return false;
  return s === 'app.asar' || s.startsWith('app.asar.unpacked/') && !s.startsWith('app.asar.unpacked/node_modules/');
}

const HASH = /^[a-f0-9]{64}$/;

function fileHash(file) {
  try { return sha256(fs.readFileSync(file)); } catch (_) { return null; }
}

// 本机这些文件的实际情况：{ok, stale:[{path, reason}]}。preflight 与解包前各核一次。
function verifyLocalFiles(entries, resourcesDir) {
  const stale = [];
  for (const entry of entries || []) {
    if (!entry || !safeRel(entry.path) || !HASH.test(String(entry.sha256 || ''))) { stale.push({ path: String(entry && entry.path), reason: '目录项无效' }); continue; }
    const actual = fileHash(path.join(resourcesDir, ...entry.path.split('/')));
    if (actual === null) stale.push({ path: entry.path, reason: '本机没有这个文件' });
    else if (actual !== entry.sha256) stale.push({ path: entry.path, reason: '本机文件和上一版不一致（可能被改动过）' });
  }
  return { ok: stale.length === 0, stale };
}

function packPayload(resourcesDir, outFile, { previous = null } = {}) {
  const rels = listPayloadFiles(resourcesDir);
  const buffers = rels.map(rel => fs.readFileSync(path.join(resourcesDir, ...rel.split('/'))));
  const entries = rels.map((rel, i) => ({ path: rel, bytes: buffers[i].length, sha256: sha256(buffers[i]) }));
  const prev = previous instanceof Map ? previous : new Map((previous || []).map(item => [item.path, item.sha256]));
  // app.asar 每次都要换，永远进包；其余解包文件只有和上一版逐字节一致时才记进 unchanged。
  const unchanged = prev.size ? entries.filter(e => e.path !== 'app.asar' && prev.get(e.path) === e.sha256) : [];
  const isUnchanged = new Set(unchanged.map(e => e.path));
  const keep = [], keepBuffers = [];
  entries.forEach((e, i) => { if (!isUnchanged.has(e.path)) { keep.push(e); keepBuffers.push(buffers[i]); } });
  const schema = prev.size ? 2 : 1;
  const header = schema === 2 ? { schema, files: keep, unchanged: unchanged.map(e => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })) } : { schema, files: keep };
  const body = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), ...keepBuffers]);
  const gz = zlib.gzipSync(body, { level: 9 });
  fs.writeFileSync(outFile, gz);
  return { file: outFile, bytes: gz.length, sha256: sha256(gz), schema, files: keep, unchanged, index: entries };
}

// 解到 destDir（按相对路径展开）。调用方已核对过整包 sha256。
// 给了 resourcesDir 时会核对 unchanged 里的本机文件；对不上抛 stale-local，调用方改用完整包。
function unpackPayload(gzFile, destDir, { resourcesDir = null } = {}) {
  const body = zlib.gunzipSync(fs.readFileSync(gzFile), { maxOutputLength: 800 * 1024 * 1024 });
  const nl = body.indexOf(0x0a);
  if (nl < 0 || nl > 2 * 1024 * 1024) throw new Error('更新包目录损坏');
  const header = JSON.parse(body.subarray(0, nl).toString('utf8'));
  if (!header || ![1, 2].includes(header.schema) || !Array.isArray(header.files) || !header.files.length || header.files.length > MAX_FILES) throw new Error('更新包目录不认识');
  if (!header.files.some(f => f.path === 'app.asar')) throw new Error('更新包里没有 app.asar');
  const unchanged = header.schema === 2 && Array.isArray(header.unchanged) ? header.unchanged : [];
  if (unchanged.length > MAX_FILES) throw new Error('更新包目录不认识');
  if (resourcesDir && unchanged.length) {
    const check = verifyLocalFiles(unchanged, resourcesDir);
    if (!check.ok) {
      const first = check.stale[0];
      const error = new Error(`本机程序文件和上一版不一致：${first.path}（${first.reason}），需要用完整更新包`);
      error.code = 'stale-local';
      error.stale = check.stale;
      throw error;
    }
  }
  let offset = nl + 1;
  const out = [];
  for (const f of header.files) {
    if (!safeRel(f.path) || !Number.isInteger(f.bytes) || f.bytes < 0 || !HASH.test(String(f.sha256))) throw new Error(`更新包里有不允许的文件：${f.path}`);
    const chunk = body.subarray(offset, offset + f.bytes);
    offset += f.bytes;
    if (chunk.length !== f.bytes || sha256(chunk) !== f.sha256) throw new Error(`更新包里 ${f.path} 校验不一致`);
    const target = path.join(destDir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, chunk);
    out.push({ path: f.path, bytes: f.bytes, sha256: f.sha256 });
  }
  if (offset !== body.length) throw new Error('更新包尾部有多余内容');
  return out;
}

module.exports = { packPayload, unpackPayload, listPayloadFiles, verifyLocalFiles, safeRel, sha256 };
