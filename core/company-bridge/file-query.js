'use strict';
// 直查读文件（2026-10-20 用户：「查询公司电脑上的相关文件（例如 txt），把 AirView 文本拿到本地帮 wireless-sim 的设计」）。
// 和 diag.js 一样：公司 Hub 主进程直接读盘，不经 CodeAgent、不排队、不占并行名额；只读，永不写、不改、不删。
//
//   家里 → 公司：{ type:'hub-admin', op:'files', action:'list'|'search'|'read', params, id, gen }
//   公司 → 家里：一条 hub-admin-status（phase:'files'），内容 gzip + base64url。
//
// 能读的范围（fileRoots）：设置里的「仿真结果目录」+「代码位置」+「额外可读目录」，去重后最多 20 个。
//   一律用 realpath 后的真实路径判断是否落在某个根里面（挡 ../ 和符号链接绕出去）；根目录自己也读不到时如实回报。
// 文本一律可读（2026-10-20 用户：不要后缀白名单，文件都该能读）：不再挑后缀，只留三类拒绝——
//   凭据文件名（.netrc/.npmrc/id_rsa…）、密钥证书后缀（.key/.pem/.pfx…）、二进制与打包产物后缀（.pth/.pyc/.xlsx…）；
//   二进制（含 NUL 字节）再兜一层拒绝；凭据按公司账号实值 + 常见的 key=value / 私钥块样式隐去，正文其余部分原样带回。
// 每次动作写审计日志 logs/company-files.log，界面给一条不打断的轻提示；开关是设置里的 allowRemoteFiles。
const fs = require('node:fs');
const path = require('node:path');

const ACTIONS = ['list', 'search', 'read'];
const LABEL = { list: '列目录', search: '找文件', read: '读文件' };

// 一次动作能带回来的上限（单条消息 6 万字节，留足余量）
const MAX_LIST = 500, DEFAULT_LIST = 200;
const MAX_MATCHES = 200, DEFAULT_MATCHES = 50;
const MAX_READ_LINES = 4000, DEFAULT_READ_LINES = 600;
const MAX_READ_CHARS = 60000, DEFAULT_READ_CHARS = 30000;
const MAX_DEPTH = 4;
// 扫描预算（和 diag.js 的结果目录扫描同一套思路：网络盘、休眠盘不能把主进程拖住）
const SCAN_BUDGET_MS = 4000, SCAN_HARD_MS = 6000, SCAN_OP_MS = 3000, SCAN_MAX_ENTRIES = 30000;
// 单个文件读多大：超过就不整份读进内存，按行窗口读
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROOTS = 20;
const MIN_INTERVAL_MS = 10000;
// 限频按动作算：找文件要扫盘，慢一些；读一小段很快。
const INTERVALS = { read: 5000, list: 10000, search: 20000 };

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '$recycle.bin', 'system volume information', 'appdata', 'windows', '$windows.~ws', '$windows.~bt']);

// 一律不给读的后缀：密钥 / 证书单列一类，报错时能说清楚是哪种
const DENY_SECRET_EXT = new Set(['.key', '.pem', '.pfx', '.p12', '.jks', '.keystore', '.kdbx', '.ppk', '.der', '.crt', '.cer', '.asc', '.gpg', '.pgp']);
// 二进制 / 打包产物：通道只传文本，给了也解不出来，按后缀先挡掉（漏网的靠 NUL 字节那一层）
const BINARY_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.a', '.lib', '.class', '.jar', '.war', '.ear', '.whl', '.egg', '.node', '.wasm',
  '.pyc', '.pyo', '.pyd', '.pth', '.pt', '.ckpt', '.safetensors', '.onnx', '.npy', '.npz', '.h5', '.mat',
  '.sqlite', '.db', '.bin', '.pak', '.iso', '.zip', '.7z', '.rar', '.gz', '.tar', '.xz', '.bz2',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.webp',
  '.mp3', '.wav', '.flac', '.mp4', '.avi', '.mov', '.wmv', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf']);
const DENY_EXT = new Set([...DENY_SECRET_EXT, ...BINARY_EXT]);
// 一律不给读的文件名（各家 CLI 的凭据）
const DENY_NAME = new Set(['.netrc', '_netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json',
  '.git-credentials', 'auth.json', '.htpasswd', 'shadow', '.env', '.env.local', '.env.production', '.env.development', '.credentials.json']);

const round1 = n => Math.round(Number(n) * 10) / 10;
const mb = b => Math.round((Number(b) || 0) / 1048576);
const short = (s, n = 120) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const errText = e => short(e && e.message || e, 200);

// 每次 readdir / stat 最多等 3 秒
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(what + ' 超过 ' + ms / 1000 + ' 秒'), { code: 'ETIMEOUT' })), ms);
  t.unref?.();
})]);

// ---- 能读的根目录 ----
function fileRoots(bridge) {
  const s = bridge.settings() || {};
  const raw = [...(Array.isArray(s.resultDirs) ? s.resultDirs : []), ...(Array.isArray(s.codeRoots) ? s.codeRoots : []), ...(Array.isArray(s.readRoots) ? s.readRoots : [])];
  const seen = new Set(), out = [];
  for (const d of raw) {
    const t = String(d || '').trim();
    if (!t) continue;
    const k = t.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out.slice(0, MAX_ROOTS);
}

const isUnc = p => /^\\\\/.test(String(p)) || /^\/\//.test(String(p));
// 取真实路径：UNC 上用 realpath 会卡在网络上，不解析（同 2026-10-19 个人配置目录的取舍）
function realOf(p) {
  const abs = path.resolve(p);
  if (isUnc(abs)) return abs;
  try { return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); } catch { return abs; }
}
function normKey(p) { return String(p).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase(); }
function inside(child, root) {
  const c = normKey(child), r = normKey(root);
  return c === r || c.startsWith(r + '\\');
}

// 把用户给的路径落到某个根里面；返回 { root, full, rel }，不在任何根里就抛错
function resolveIn(roots, wanted, { mustExist = true } = {}) {
  const list = roots.map(r => ({ raw: r, real: realOf(r) }));
  if (!list.length) throw new Error('这台电脑还没设置可读的目录（公司 Hub「AI特战队专用功能」→「文件读取」里设置）');
  let p = String(wanted == null ? '' : wanted).trim();
  if (!p) throw new Error('要给出路径');
  if (!path.isAbsolute(p)) {
    // 相对路径：优先按第一个含它的根拼（方便「AirView/out/a.txt」这样写）
    const hit = list.find(r => inside(path.resolve(r.real, p), r.real));
    if (hit) p = path.resolve(hit.real, p);
    else p = path.resolve(list[0].real, p);
  }
  const real = realOf(p);
  const hit = list.find(r => inside(real, r.real));
  if (!hit) {
    throw Object.assign(new Error(`不在可读目录里：${short(p, 160)}。可读的是 ${list.map(r => r.raw).join('、')}`), { code: 'outside' });
  }
  if (mustExist) {
    let st;
    try { st = fs.statSync(real); } catch (e) { throw Object.assign(new Error(`读不到：${short(real, 160)}（${e.code === 'ENOENT' ? '不存在' : errText(e)}）`), { code: e.code || 'stat-failed' }); }
    return { root: hit.raw, rootReal: hit.real, full: real, rel: path.relative(hit.real, real).split(path.sep).join('/') || '.', st };
  }
  return { root: hit.raw, rootReal: hit.real, full: real, rel: path.relative(hit.real, real).split(path.sep).join('/') || '.', st: null };
}

// ---- 后缀 / 名字闸门：默认放行，只拒绝凭据、密钥、二进制这三类 ----
function readableName(name) {
  const lower = String(name).toLowerCase();
  if (DENY_NAME.has(lower)) return { ok: false, why: '这类文件（凭据 / 密钥）不给读' };
  const ext = path.extname(lower);
  if (DENY_SECRET_EXT.has(ext)) return { ok: false, why: `这类文件（${ext}，密钥 / 证书）不给读` };
  if (BINARY_EXT.has(ext)) return { ok: false, why: `这类文件（${ext}）是二进制或打包产物，通道只传文本，读不了` };
  return { ok: true };
}
// 按后缀能不能当文本传（给子树统计标 text 用，和 readableName 同源）
const textByExt = ext => !DENY_EXT.has(String(ext).toLowerCase());

// ---- 文本解码：优先 UTF-8，出现替换字符就退回 GBK（中文 Windows 上的 txt 常见）----
function decodeText(buf) {
  let text = buf.toString('utf8');
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > 0) {
    for (const enc of ['gbk', 'gb18030', 'big5']) {
      try {
        const alt = new TextDecoder(enc).decode(buf);
        if ((alt.match(/\uFFFD/g) || []).length < bad) { text = alt; break; }
      } catch { /* 这套编码这个运行时没有，试下一个 */ }
    }
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); // \u53BB\u6389 UTF-8 BOM\u3001CRLF \u5F52\u4E00
}
const looksBinary = buf => buf.subarray(0, Math.min(buf.length, 8192)).includes(0);

// ---- 按行读一个窗口 ----
function readWindow(full, st, { from = 1, lines = DEFAULT_READ_LINES, chars = DEFAULT_READ_CHARS }, redact) {
  if (st.size > MAX_FILE_BYTES) throw Object.assign(new Error(`文件 ${mb(st.size)} MB，超过单次读取上限 ${mb(MAX_FILE_BYTES)} MB；先按更小的范围读（这类大文件多半是结果数据，先看它的同名 .txt / .log 说明）`), { code: 'too-big' });
  const buf = fs.readFileSync(full);
  if (looksBinary(buf)) throw Object.assign(new Error('这是二进制文件（内容里有 0 字节），不读'), { code: 'binary' });
  const plain = decodeText(buf);
  // 脱敏在**切窗口之前**对整篇做：私钥 / 证书块可能跨行，也可能只被读到半截（窗口从块中间开始）。
  // 代价是要整篇过一遍正则；redact 保证行数不变，所以 from / to / next 与真实文件行号仍然对得上。
  const text = typeof redact === 'function' ? redact(plain) : plain;
  const all = text.split('\n');
  const total = all.length - (all[all.length - 1] === '' ? 1 : 0);
  const start = Math.max(1, Math.min(Number(from) || 1, Math.max(1, total)));
  const picked = [];
  let used = 0, cut = false;
  // 只走到 total：文件末尾那个换行不算一行（否则每份「最后带换行」的文本都会多出一行空的）
  for (let i = start - 1; i < total && picked.length < lines; i += 1) {
    const line = all[i];
    const cost = line.length + 1;
    if (used + cost > chars && picked.length) { cut = true; break; }
    // 单行就超预算：截断这一行自己
    picked.push(line.length > chars ? line.slice(0, chars) : line);
    used += Math.min(cost, chars);
    if (used >= chars) { cut = true; break; }
  }
  const last = start + picked.length - 1;
  const more = cut || last < total;
  return { totalLines: total, from: start, to: last, lines: picked, chars: used, more,
    next: more ? last + 1 : null, truncatedLine: picked.some(l => l.length >= chars) };
}

// ---- 列目录 ----
async function listDir(roots, { dir, depth = 0, all = false, limit = DEFAULT_LIST }) {
  const at = resolveIn(roots, dir || '.', { mustExist: false });
  const maxDepth = Math.min(MAX_DEPTH, Math.max(0, Number(depth) || 0));
  const cap = Math.min(MAX_LIST, Math.max(1, Number(limit) || DEFAULT_LIST));
  const out = { root: at.root, dir: at.rel, depth: maxDepth, entries: [], truncated: false, note: null };
  let list;
  try { list = await within(fs.promises.readdir(at.full, { withFileTypes: true }), SCAN_OP_MS, '列目录'); }
  catch (e) { throw Object.assign(new Error(`列不了这个目录：${short(at.rel, 160)}（${e.code === 'ENOENT' ? '不存在' : errText(e)}）`), { code: e.code || 'readdir-failed' }); }
  const queue = [{ dir: at.full, rel: at.rel, depth: 0 }];
  let seen = 0;
  const t0 = Date.now();
  while (queue.length) {
    // 整体时间预算：根目录在网络盘 / 巨目录上时，单条 stat 最长 3 秒，不设上限会把「秒级」拖成几分钟
    if (Date.now() - t0 > SCAN_HARD_MS || seen > SCAN_MAX_ENTRIES) { out.truncated = true; break; }
    const cur = queue.shift();
    let kids = [];
    if (cur.dir === at.full) kids = list;
    else { try { kids = await within(fs.promises.readdir(cur.dir, { withFileTypes: true }), SCAN_OP_MS, '列目录'); } catch { continue; } }
    kids.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of kids) {
      seen += 1;
      if (Date.now() - t0 > SCAN_HARD_MS || seen > SCAN_MAX_ENTRIES) { out.truncated = true; queue.length = 0; break; }
      // 到上限就停：这里检查「再有就放不下」，所以整好装下时不会误报截断
      if (out.entries.length >= cap) { out.truncated = true; queue.length = 0; break; }
      const full = path.join(cur.dir, e.name);
      const rel = (cur.rel === '.' || !cur.rel ? '' : cur.rel + '/') + e.name;
      if (e.isDirectory()) {
        const skip = SKIP_DIRS.has(e.name.toLowerCase());
        out.entries.push({ name: e.name, rel, type: 'dir', skip: skip || undefined });
        if (!skip && cur.depth < maxDepth) queue.push({ dir: full, rel, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      // 默认只列可读的文本文件；all:true 时把其余也列出来（只给名字和大小，标不可读的原因）
      const gate = readableName(e.name);
      if (!gate.ok && !all) continue;
      let st = null; try { st = await within(fs.promises.stat(full), SCAN_OP_MS, '读文件信息'); } catch { /* 读不到就跳过 */ }
      if (!st) continue;
      out.entries.push({ name: e.name, rel, type: 'file', sizeKB: Math.round(st.size / 1024), mtime: Math.round(st.mtimeMs),
        ...(gate.ok ? (st.size > MAX_FILE_BYTES ? { big: true } : {}) : { unreadable: gate.why }) });
    }
  }
  // 装满了但还有没走的子目录：也算截断（循环里那次检查只在「还有下一条」时触发）
  if (!out.truncated && queue.length && out.entries.length >= cap) out.truncated = true;
  out.files = out.entries.filter(x => x.type === 'file').length;
  out.dirs = out.entries.filter(x => x.type === 'dir').length;
  out.scanned = seen;
  // 顺手报一下整棵子树的量级（文件数 + 总大小），家里要靠它估传输量
  if (maxDepth === 0) { const sub = await subtreeSize(at.full); out.subtree = sub; }
  if (out.truncated) out.note = `内容太多或目录太大，只列了前 ${cap} 项${out.entries.length < cap ? '（到时间上限了）' : ''}；把目录缩小一点再看`;
  return out;
}

// 子树统计：文件数、总字节、按后缀分组的字节数（估传输量用）
async function subtreeSize(dir, { budgetMs = SCAN_BUDGET_MS, maxEntries = SCAN_MAX_ENTRIES } = {}) {
  const t0 = Date.now();
  const byExt = new Map();
  let files = 0, bytes = 0, entries = 0, truncated = false;
  const queue = [dir];
  while (queue.length) {
    if (Date.now() - t0 > budgetMs || entries > maxEntries) { truncated = true; break; }
    const cur = queue.shift();
    let kids;
    try { kids = await within(fs.promises.readdir(cur, { withFileTypes: true }), SCAN_OP_MS, '列目录'); } catch { continue; }
    for (const e of kids) {
      if (Date.now() - t0 > budgetMs || entries > maxEntries) { truncated = true; break; }
      entries += 1;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) queue.push(full); continue; }
      if (!e.isFile()) continue;
      let st = null; try { st = await within(fs.promises.stat(full), SCAN_OP_MS, '读文件信息'); } catch { continue; }
      files += 1; bytes += st.size;
      const ext = (path.extname(e.name).toLowerCase() || '（无后缀）');
      const g = byExt.get(ext) || { ext, files: 0, bytes: 0 };
      g.files += 1; g.bytes += st.size; byExt.set(ext, g);
    }
  }
  const top = [...byExt.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12)
    .map(x => ({ ext: x.ext, files: x.files, sizeKB: Math.round(x.bytes / 1024), text: textByExt(x.ext === '（无后缀）' ? '' : x.ext) || undefined }));
  return { files, sizeKB: Math.round(bytes / 1024), top, scanned: entries, truncated, scanMs: Date.now() - t0 };
}

// ---- 找文件 ----
function globToRe(glob) {
  const g = String(glob || '').trim();
  if (!g) return null;
  // 同时接受 * ? 通配和普通子串（没有通配符就当子串匹配，大小写不敏感）
  const hasWild = /[*?]/.test(g);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]');
  return new RegExp(hasWild ? '^' + body + '$' : body, 'i');
}

async function search(roots, { root, name, content, depth = MAX_DEPTH, limit = DEFAULT_MATCHES, maxKB = 2048 }) {
  const rootsUse = root ? [resolveIn(roots, root, { mustExist: false })] : roots.map(r => resolveIn(roots, r, { mustExist: false }));
  const re = globToRe(name);
  const needle = content == null ? '' : String(content);
  if (!re && !needle) throw new Error('要找什么：给 name（文件名，支持 * 和 ?）或 content（文件内容里的词）');
  const maxDepth = Math.min(MAX_DEPTH, Math.max(0, Number(depth) || MAX_DEPTH));
  const cap = Math.min(MAX_MATCHES, Math.max(1, Number(limit) || DEFAULT_MATCHES));
  const sizeCap = Math.max(1, Number(maxKB) || 2048) * 1024;
  const t0 = Date.now();
  const matches = [], skipped = [];
  let scanned = 0, truncated = false;
  for (const at of rootsUse) {
    if (matches.length >= cap || Date.now() - t0 > SCAN_HARD_MS) { truncated = true; break; }
    const queue = [{ dir: at.full, rel: at.rel, depth: 0 }];
    while (queue.length) {
      if (matches.length >= cap || Date.now() - t0 > SCAN_BUDGET_MS) { truncated = true; break; }
      const cur = queue.shift();
      let kids;
      try { kids = await within(fs.promises.readdir(cur.dir, { withFileTypes: true }), SCAN_OP_MS, '列目录'); } catch { continue; }
      for (const e of kids) {
        if (matches.length >= cap || Date.now() - t0 > SCAN_BUDGET_MS) { truncated = true; break; }
        scanned += 1;
        const full = path.join(cur.dir, e.name);
        const rel = (cur.rel === '.' || !cur.rel ? '' : cur.rel + '/') + e.name;
        if (e.isDirectory()) { if (cur.depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) queue.push({ dir: full, rel, depth: cur.depth + 1 }); continue; }
        if (!e.isFile()) continue;
        const gate = readableName(e.name);
        if (!gate.ok) continue;
        if (re && !re.test(e.name)) continue;
        let st = null; try { st = await within(fs.promises.stat(full), SCAN_OP_MS, '读文件信息'); } catch { continue; }
        const hit = { root: at.root, rel, sizeKB: Math.round(st.size / 1024), mtime: Math.round(st.mtimeMs) };
        if (!needle) { matches.push(hit); continue; }
        if (st.size > sizeCap) { skipped.push({ ...hit, why: `文件 ${Math.round(st.size / 1024)} KB，超过内容搜索上限 ${maxKB} KB` }); continue; }
        let text = null;
        try {
          const buf = fs.readFileSync(full);
          if (looksBinary(buf)) { skipped.push({ ...hit, why: '二进制' }); continue; }
          text = decodeText(buf);
        } catch (err) { skipped.push({ ...hit, why: errText(err) }); continue; }
        const lower = text.toLowerCase(), want = needle.toLowerCase();
        const idx = lower.indexOf(want);
        if (idx < 0) continue;
        const lineNo = text.slice(0, idx).split('\n').length;
        const line = text.split('\n')[lineNo - 1] || '';
        const col = idx - (text.slice(0, idx).lastIndexOf('\n') + 1);
        matches.push({ ...hit, line: lineNo, col: col + 1, sample: short(line, 200), hits: (lower.split(want).length - 1) });
      }
    }
  }
  const out = { asked: { root: root || null, name: name || null, content: content == null ? null : short(content, 120) }, matches: matches.slice(0, cap), scanned, truncated,
    elapsedMs: Date.now() - t0 };
  if (skipped.length) out.skipped = skipped.slice(0, 10);
  if (matches.length >= cap) out.note = `已经找到 ${matches.length} 个（上限），可能还有；把范围收窄一点再看`;
  else if (truncated) out.note = '扫描到时间 / 条数上限就停了，可能还有没扫到的；把范围收窄一点再看';
  return out;
}

// ---- 参数校验（家里先核一遍，这边再核一遍）----
function parseParams(action, raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n = 260) => String(v == null ? '' : v).trim().slice(0, n);
  // 层数：不填用默认值；填了就要在范围内，不悄悄改小（免得对方以为扫了更深）
  const depth = (v, fallback) => {
    if (v == null) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DEPTH) throw new Error(`depth 只能是 0–${MAX_DEPTH}（当前 ${MAX_DEPTH} 层以内）`);
    return n;
  };
  if (action === 'list') {
    const out = { dir: str(p.dir) || '.', depth: depth(p.depth, 0), all: p.all === true };
    if (p.limit != null) { const n = Number(p.limit); if (!Number.isInteger(n) || n < 1 || n > MAX_LIST) throw new Error(`limit 只能是 1–${MAX_LIST}`); out.limit = n; }
    return out;
  }
  if (action === 'search') {
    const out = { root: str(p.root) || null, name: str(p.name, 120) || null, content: p.content == null ? null : str(p.content, 120),
      depth: depth(p.depth, MAX_DEPTH) };
    if (p.limit != null) { const n = Number(p.limit); if (!Number.isInteger(n) || n < 1 || n > MAX_MATCHES) throw new Error(`limit 只能是 1–${MAX_MATCHES}`); out.limit = n; }
    if (p.maxKB != null) { const n = Number(p.maxKB); if (!Number.isFinite(n) || n < 1 || n > 51200) throw new Error('maxKB 只能是 1–51200'); out.maxKB = n; }
    if (!out.name && !out.content) throw new Error('要找什么：给 name（文件名，支持 * 和 ?）或 content（文件内容里的词）');
    return out;
  }
  if (action === 'read') {
    const file = str(p.file);
    if (!file) throw new Error('要给出文件路径（可先用 list / search 找）');
    const out = { file };
    if (p.from != null) { const n = Number(p.from); if (!Number.isInteger(n) || n < 1 || n > 100000000) throw new Error('from 只能是行号（从 1 开始）'); out.from = n; }
    if (p.lines != null) { const n = Number(p.lines); if (!Number.isInteger(n) || n < 1 || n > MAX_READ_LINES) throw new Error(`lines 只能是 1–${MAX_READ_LINES}`); out.lines = n; }
    if (p.chars != null) { const n = Number(p.chars); if (!Number.isInteger(n) || n < 1000 || n > MAX_READ_CHARS) throw new Error(`chars 只能是 1000–${MAX_READ_CHARS}`); out.chars = n; }
    if (p.echo === true) out.echo = true; // 允许回显这一段原文（默认也回显；留字段给以后按需收紧）
    return out;
  }
  throw new Error('不认识的动作：' + short(action, 30) + '（只认 ' + ACTIONS.join(' / ') + '）');
}

// ---- 文件正文的脱敏：只管凭据，不动代码和路径（动 URL / 长串会把源码读成废纸）----
function makeFileRedactor({ scrub = s => s, extra = [] } = {}) {
  const words = [...new Set(extra.map(String).filter(s => s.length >= 6))].sort((a, b) => b.length - a.length);
  return text => {
    // 先把公司自己的账号实值等按整篇替换一遍（scrub 由调用方给，出错就退回原文，不挡这次读取）
    let s = String(text ?? '');
    try { s = String(scrub(s)); } catch { /* 脱敏回调出错就用原文，后面的规则照跑 */ }
    for (const w of words) s = s.split(w).join('<已隐去>');
    return s
      // 私钥 / 证书整块：BEGIN 到 END 之间的**每一行**都换成占位符（保持行数，切窗口的 from/to/next 才不会错位）
      .replace(/-----BEGIN [^-]{0,60}(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]{0,60}(?:PRIVATE KEY|CERTIFICATE)-----/g,
        m => m.split('\n').map(() => '<已隐去：私钥 / 证书>').join('\n'))
      // 只有 BEGIN、没有 END（文件被截断）：紧跟其后的 base64 正文行也一律隐去，别只藏个头
      .replace(/(?:^|\n)-----BEGIN [^-]{0,60}(?:PRIVATE KEY|CERTIFICATE)-----((?:\n[A-Za-z0-9+/=]{16,})*)/g,
        (m, body) => (m.startsWith('\n') ? '\n' : '') + '<已隐去：私钥 / 证书>' + body.replace(/[^\n]+/g, '<已隐去：私钥 / 证书>'))
      // 键值型凭据（保留键名，值换成占位）；值前面可能还有个前缀词（Authorization: Bearer xxx），连它一起吃掉
      .replace(/((?:pass(?:word|wd)?|pwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|authorization|auth[_-]?token|cookie|credential|口令|密码|密钥|令牌)\s*["']?\s*[:=：]\s*["']?(?:Bearer|Basic)?\s*)([^\s"',;，；]{4,})/gi, '$1<已隐去>')
      // 没有键名、光是认证头里的令牌
      .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1$2<已隐去>')
      // 各家模型 / 平台的 key 样式
      .replace(/\b(?:sk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|AKIA|ASIA|LTAI|ltaI)[-_][A-Za-z0-9_-]{10,}/g, '<已隐去>')
      // JSON 里 king 字段是长随机串
      .replace(/("(?:api_?key|token|secret|password|authorization)"\s*:\s*")[^"]{8,}(")/gi, '$1<已隐去>$2')
      // 账号密码写在 URL 里
      .replace(/(\b[a-z][a-z0-9+.-]{2,9}:\/\/)[^\/\s:@]{1,40}:[^\/\s@]{1,40}@/gi, '$1<已隐去>@');
  };
}

// ---- 执行一个动作 ----
async function run({ roots, action, params, redact }) {
  if (action === 'list') return { action, ...(await listDir(roots, params)) };
  if (action === 'search') return { action, ...(await search(roots, params)) };
  if (action === 'read') {
    const at = resolveIn(roots, params.file, { mustExist: true });
    if (at.st.isDirectory()) throw new Error('这是一个目录，用 action:"list" 看里面有什么');
    const gate = readableName(path.basename(at.full));
    if (!gate.ok) throw Object.assign(new Error(gate.why), { code: 'not-text' });
    const win = readWindow(at.full, at.st, params, redact);
    return { action, root: at.root, file: at.rel, path: at.full, sizeBytes: at.st.size, mtime: Math.round(at.st.mtimeMs), ...win };
  }
  throw new Error('不认识的动作：' + short(action, 30));
}

// ---- 塞进一条消息：超了就少给几行，仍然发得出去（同 diag.js fit 的思路）----
const STEPS = [
  ['内容砍掉一半', r => shrink(r, 2)],
  ['内容再砍一半', r => shrink(r, 2)],
  ['内容只剩 2000 字', r => shrink(r, 999)],
  ['只留前面 30 行', r => { if (r.lines && r.lines.length > 30) { r.lines = r.lines.slice(0, 30); r.to = r.from + 29; r.truncatedLine = r.truncatedLine; r.more = true; r.next = r.to + 1; } }],
  ['列表只留前 50 项', r => { if (r.entries && r.entries.length > 50) { r.entries = r.entries.slice(0, 50); r.truncated = true; } if (r.matches && r.matches.length > 20) { r.matches = r.matches.slice(0, 20); r.truncated = true; } }],
];
function shrink(r, div) {
  if (r.lines && r.lines.length) {
    const keep = div > 100 ? Math.max(1, Math.min(r.lines.length, Math.floor(2000 / Math.max(1, Math.round(r.lines.join('\n').length / r.lines.length))))) : Math.max(1, Math.ceil(r.lines.length / div));
    if (keep < r.lines.length) { r.lines = r.lines.slice(0, keep); r.to = r.from + keep - 1; r.more = true; r.next = r.to + 1; }
  }
  if (r.sample) r.sample = short(r.sample, 80);
  if (r.skipped) r.skipped = r.skipped.slice(0, 3);
  if (r.subtree && r.subtree.top) r.subtree.top = r.subtree.top.slice(0, 6);
  return r;
}
const STEP_LABELS = STEPS.map(s => s[0]);
function fit(result, measure, limit) {
  const r = JSON.parse(JSON.stringify(result));
  r.degraded = [];
  let data = require('./diag').encode(r), bytes = measure(data);
  for (const [label, step] of STEPS) {
    if (bytes < limit) break;
    step(r); r.degraded.push(label);
    data = require('./diag').encode(r); bytes = measure(data);
  }
  if (bytes >= limit) {
    const tiny = { action: r.action, degraded: [...r.degraded, '全部省略'], note: '这一段还是太长，只留摘要；把范围收窄（更具体的目录 / 更少的行）再读' };
    data = require('./diag').encode(tiny); bytes = measure(data);
    return { data, result: tiny, degraded: tiny.degraded, bytes };
  }
  return { data, result: r, degraded: r.degraded, bytes };
}

// ---- 一句话摘要（家里卡片顶上一行）----
function summarize(r) {
  if (!r || r.action == null) return '文件读取：没有结果';
  if (r.action === 'list') {
    const parts = [`目录 ${r.dir}`, `${r.dirs || 0} 个子目录、${r.files || 0} 个可读文件`];
    if (r.subtree) parts.push(`整棵子树 ${r.subtree.files} 个文件、${round1(r.subtree.sizeKB / 1024)} MB`);
    const big = (r.entries || []).filter(x => x.big).length;
    if (big) parts.push(`其中 ${big} 个超过 ${mb(MAX_FILE_BYTES)} MB（要分段读）`);
    if (r.truncated) parts.push('只列了一部分');
    return parts.join(' · ');
  }
  if (r.action === 'search') {
    const what = [r.asked?.name ? `名字像 ${r.asked.name}` : null, r.asked?.content ? `内容含「${r.asked.content}」` : null].filter(Boolean).join(' 且 ');
    return `找文件（${what}）：命中 ${(r.matches || []).length} 个${r.truncated || r.note ? ` · ${r.note || '可能还有'}` : ''}`;
  }
  if (r.action === 'read') {
    if (!r.totalLines) return `读文件 ${r.file}：空文件（0 字节内容）`;
    return `读文件 ${r.file}：${r.from}–${r.to} 行 / 共 ${r.totalLines} 行、${round1(r.sizeBytes / 1024)} KB${r.more ? ` · 后面还有，接着读用 from:${r.next}` : ' · 已读完'}`;
  }
  return '文件读取：' + (r.error || '完成');
}

module.exports = {
  ACTIONS, LABEL, parseParams, fileRoots, resolveIn, readableName, decodeText, readWindow, listDir, subtreeSize, search, run,
  makeFileRedactor, fit, summarize, summarizeAction: summarize, STEP_LABELS,
  MIN_INTERVAL_MS, INTERVALS, MAX_LIST, MAX_MATCHES, MAX_READ_LINES, MAX_READ_CHARS, MAX_DEPTH, DENY_EXT, BINARY_EXT, textByExt, MAX_ROOTS, MAX_FILE_BYTES, SKIP_DIRS,
  DENY_NAME, SCAN_BUDGET_MS, SCAN_MAX_ENTRIES,
};