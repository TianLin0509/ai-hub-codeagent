'use strict';
// 增量更新包：一个 gzip 文件，里面是「一行 JSON 目录 + 各文件原样字节依次拼接」。
// 目录列出每个文件相对 resources 目录的路径、字节数和 sha256。不用 zip/tar，免得新增依赖；
// 解包时逐个核对 sha256，任何一个不对就整包作废。
//
// 内容：app.asar 本身，加上 app.asar.unpacked 里不属于 node_modules 的文件（打包时被标记成
// 「解包」的少量程序文件，它们跟着程序一起变）。依赖（node_modules）不进增量包：依赖一变就走完整安装包。
// Electron 会把名为 *.asar 的文件当成压缩包拦截（写 app.asar 会报 Invalid package），用它提供的原始文件接口。
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

function packPayload(resourcesDir, outFile) {
  const rels = listPayloadFiles(resourcesDir);
  const buffers = rels.map(rel => fs.readFileSync(path.join(resourcesDir, ...rel.split('/'))));
  const header = { schema: 1, files: rels.map((rel, i) => ({ path: rel, bytes: buffers[i].length, sha256: sha256(buffers[i]) })) };
  const body = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), ...buffers]);
  const gz = zlib.gzipSync(body, { level: 9 });
  fs.writeFileSync(outFile, gz);
  return { file: outFile, bytes: gz.length, sha256: sha256(gz), files: header.files };
}

// 解到 destDir（按相对路径展开），返回目录。调用方已核对过整包 sha256。
function unpackPayload(gzFile, destDir) {
  const body = zlib.gunzipSync(fs.readFileSync(gzFile), { maxOutputLength: 800 * 1024 * 1024 });
  const nl = body.indexOf(0x0a);
  if (nl < 0 || nl > 2 * 1024 * 1024) throw new Error('更新包目录损坏');
  const header = JSON.parse(body.subarray(0, nl).toString('utf8'));
  if (!header || header.schema !== 1 || !Array.isArray(header.files) || !header.files.length || header.files.length > MAX_FILES) throw new Error('更新包目录不认识');
  if (!header.files.some(f => f.path === 'app.asar')) throw new Error('更新包里没有 app.asar');
  let offset = nl + 1;
  const out = [];
  for (const f of header.files) {
    if (!safeRel(f.path) || !Number.isInteger(f.bytes) || f.bytes < 0 || !/^[a-f0-9]{64}$/.test(String(f.sha256))) throw new Error(`更新包里有不允许的文件：${f.path}`);
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

module.exports = { packPayload, unpackPayload, listPayloadFiles, safeRel, sha256 };
