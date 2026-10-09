'use strict';
// Codex 会话的 cwd 迁移（2026-07-28）。
//
// 事故：workspace 归档换目录后，群聊里的 Codex 成员 resume 起来就卡死不回话，
// Hub 侧却一直显示 idle。真相不是崩溃，是 Codex CLI 弹了一个交互菜单等按键：
//
//     Choose working directory to resume this session
//     Current = your current working directory
//     › 1. Use session directory (\\?\C:\Workspace\_scratch\inbox-...)
//       Press enter to continue
//
// 根因是 workspace-handlers.js 里一句写进注释的错误推论：
//     「codex 的 rollout 按日期存放…都不受目录搬迁影响」
// 「rollout 文件放在哪」确实不受影响，但 rollout 的**内容里**记着 cwd
// （第一行 session_meta.payload.cwd），CLI 启动时会拿它和当前目录比对。
// 文件找得到 ≠ 能无痛恢复 —— 这一字之差让 codex 整个被排除在归档迁移之外。
//
// 修法与 kimi-session-migrator 同款：归档时把 rollout 里记的 cwd 改成新目录，
// CLI 比对通过就不会再弹菜单。只改第一行的 session_meta，正文里其它 "cwd"
// 出现（shell 命令记录等）一律不碰。
//
// ---------------------------------------------------------------------------
// 2026-07-29 备份策略重做（修 P1-1 / P2-2 / P2-3）
//
// 旧实现三处同源问题，都出在「无条件全量复制一份 rollout 当备份」：
//   P1-1 备份无限累积：`fs.copyFileSync(rolloutPath, `${rolloutPath}.pre-migrate-${Date.now()}.bak`)`
//        永不清理、迁移失败也留。真实数据 ~/.codex/sessions 合计 4.8 GB，
//        最大单个 rollout 656 MB —— 归档一次就多 656 MB 永不回收的垃圾。
//   P2-2 alreadyCurrent 短路失效：`path.resolve(a) === path.resolve(b)` 是裸字符串比较，
//        Windows 下大小写不同、或 codex 自己写进去的 `\\?\` 长路径前缀，都会被判成
//        「不一样」→ 内容其实没变也照样重写 + 再存一份大备份，直接放大 P1-1。
//   P2-3 同毫秒撞名：`Date.now()` 粒度下两次迁移共用同一个备份名，第二次把
//        「迁移后」的状态盖进备份，原始 cwd 永久丢失。
//
// 现在的策略——**只备份首行**：
//   这个迁移**只改 JSONL 第一行**，正文一字节不动，全量复制属于过度保险。
//   备份改成一个 sidecar JSON（~1 KB，与 rollout 大小无关），内容是改写前的首行原文：
//     - 落在 `<HUB_DATA_DIR>/backups/codex/`，不污染 ~/.codex/sessions
//       （Codex CLI 自己的 resume picker 会扫那棵目录树）；
//     - 文件名按 rollout 路径定死 → 同一个 rollout 永远只有一份备份，
//       累积在结构上就不可能发生（P1-1、P2-3 的撞名一起消失）；
//     - `originalFirstLine` 一旦落盘就永不覆盖，后续迁移只更新 previous* 字段 ——
//       所以哪怕同一毫秒连迁两次，最初的 cwd 也还在（P2-3）；
//     - 迁移失败时把备份恢复成动手之前的样子（原本没有就删掉），对齐 .tmp 的清理逻辑。
//
// 顺带修掉两个会在大 rollout 上直接爆炸的隐患：
//   - 旧实现 `fs.readFileSync(rolloutPath, 'utf8')` 把整份 rollout 读成 JS 字符串。
//     656 MB 的那个会直接抛 ERR_STRING_TOO_LONG（V8 单字符串上限 ~512 MB），
//     迁移根本走不完。现在首行走 bounded read，正文按 Buffer 分块搬运。
//   - 正文以 Buffer 原样搬运，不再经过 utf8 解码/编码往返，坏字节不会被换成 U+FFFD，
//     首行之后的字节保证与原文件逐字节一致。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  findCodexRolloutBySid,
  DEFAULT_CODEX_SESSIONS_ROOT,
  normalizePathForCompare,
} = require('./codex-transcript-parser.js');
const { getHubDataDir } = require('./data-dir.js');

const BACKUP_VERSION = 1;
// session_meta 首行实际就几百字节；512 KB 与 codex-transcript-parser 的
// readFirstLineSync 保持同一个上限，超了说明文件根本不是正常 rollout。
const FIRST_LINE_MAX_BYTES = 512 * 1024;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
// 旧实现留在 ~/.codex/sessions 里的全量备份，迁移成功后顺手清掉（只认这一个模式）。
const LEGACY_BACKUP_RE = /^\.pre-migrate-\d+\.bak$/;

// 临时文件名沿用仓库惯例（pid + 递增序号 + 随机后缀）：旧实现只有 `${pid}.tmp`，
// 同进程内连着迁两个会话就会撞名。配合 openSync 的 'wx' 标志，撞了也只会失败不会覆盖。
let tmpSeq = 0;
function nextTmpSuffix() {
  tmpSeq = (tmpSeq + 1) % 1000000;
  return `${process.pid}.${tmpSeq}.${crypto.randomBytes(3).toString('hex')}`;
}

// Windows 长路径前缀：codex 把 cwd 写成 `\\?\C:\...` 是常态（resume 菜单里就这么显示）。
// path.resolve 不会去掉它，normalizePathForCompare 也就不认得它和 `C:\...` 是同一个目录。
function stripWin32LongPathPrefix(value) {
  const s = String(value == null ? '' : value);
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) return `\\\\${s.slice(8)}`;
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return s.slice(4);
  return s;
}

// 复用 codex-transcript-parser 的比较口径（resolve + 正斜杠 + 小写），
// 只在前面补一层长路径前缀剥离。别再自己发明第二套路径归一。
function normalizeCwdForCompare(value) {
  return normalizePathForCompare(stripWin32LongPathPrefix(value));
}

// 只读首行，顺便记下正文起点。整文件读进内存的做法对 GB 级 rollout 是死路。
// tailOffset 指向换行符本身（与旧实现 raw.slice(newlineIdx) 的语义一致：正文含前导 \n）。
function readFirstLineInfo(rolloutPath) {
  const fd = fs.openSync(rolloutPath, 'r');
  try {
    const size = fs.fstatSync(fd).size || 0;
    const buf = Buffer.alloc(64 * 1024);
    const chunks = [];
    let scanned = 0;
    let newlineAt = -1;
    while (scanned < FIRST_LINE_MAX_BYTES) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, FIRST_LINE_MAX_BYTES - scanned), scanned);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(Buffer.from(slice.subarray(0, nl)));
        newlineAt = scanned + nl;
        break;
      }
      chunks.push(Buffer.from(slice));
      scanned += n;
    }
    if (newlineAt < 0 && scanned >= FIRST_LINE_MAX_BYTES) {
      return { tooLong: true, size };
    }
    const lineBuf = Buffer.concat(chunks);
    return {
      size,
      firstLine: lineBuf.toString('utf8'),
      // CRLF 的 rollout 没见过，但真遇上也不能把行尾吃掉（否则首行变 LF、其余是 CRLF）。
      crlf: lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d,
      tailOffset: newlineAt >= 0 ? newlineAt : lineBuf.length,
      hasTail: newlineAt >= 0,
    };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function resolveBackupDir(opts) {
  if (opts && opts.backupDir) return String(opts.backupDir);
  // 走 Hub 数据目录：隔离实例（CLAUDE_HUB_DATA_DIR）自然分开，单测也不会写进生产目录。
  return path.join(getHubDataDir(), 'backups', 'codex');
}

// 备份名对同一个 rollout 必须是稳定的 —— 「只留一份」靠的就是这个确定性，
// 不是靠事后扫目录删旧文件。basename 里已经带 sid，再拼一段路径哈希防跨目录同名。
function backupFileFor(rolloutPath, backupDir) {
  const resolved = path.resolve(rolloutPath);
  const digest = crypto.createHash('sha1').update(normalizeCwdForCompare(resolved), 'utf8').digest('hex').slice(0, 8);
  const safe = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return path.join(backupDir, `${safe}.${digest}.pre-migrate.json`);
}

function readBackupRaw(backupPath) {
  try { return fs.readFileSync(backupPath, 'utf8'); } catch { return null; }
}

function writeBackupRaw(backupPath, text) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const tmp = `${backupPath}.${nextTmpSuffix()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, backupPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 迁移失败时把备份恢复成动手之前的状态：原本没有就删掉，原本有就写回原内容。
function restoreBackupRaw(backupPath, prevRaw) {
  try {
    if (prevRaw === null) fs.unlinkSync(backupPath);
    else writeBackupRaw(backupPath, prevRaw);
  } catch {}
}

function saveFirstLineBackup(backupPath, rolloutPath, firstLine, oldCwd) {
  const prevRaw = readBackupRaw(backupPath);
  let prev = null;
  if (prevRaw !== null) {
    try { prev = JSON.parse(prevRaw); } catch { prev = null; }
  }
  const now = new Date().toISOString();
  // originalFirstLine 只在第一次落盘，之后任何一次迁移都不许覆盖 ——
  // 同毫秒连迁两次也不会把「最初的 cwd」冲成「上一次迁移后的 cwd」（P2-3）。
  const hasOriginal = !!(prev && typeof prev.originalFirstLine === 'string');
  const record = {
    version: BACKUP_VERSION,
    rolloutPath: path.resolve(rolloutPath),
    originalFirstLine: hasOriginal ? prev.originalFirstLine : firstLine,
    originalCwd: hasOriginal ? (prev.originalCwd || null) : (oldCwd || null),
    originalCapturedAt: hasOriginal ? (prev.originalCapturedAt || now) : now,
    previousFirstLine: firstLine,
    previousCwd: oldCwd || null,
    capturedAt: now,
    migrations: (prev && Number.isFinite(prev.migrations) ? prev.migrations : 0) + 1,
  };
  writeBackupRaw(backupPath, `${JSON.stringify(record, null, 2)}\n`);
  return prevRaw;
}

// 清掉旧实现（2026-07-28 版）留在 rollout 旁边的全量 .bak。
// 只认 `<本 rollout 文件名>.pre-migrate-<数字>.bak`，碰不到任何真实会话数据。
function pruneLegacyFullBackups(rolloutPath) {
  const resolved = path.resolve(rolloutPath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return removed; }
  for (const name of entries) {
    if (!name.startsWith(`${base}.`)) continue;
    if (!LEGACY_BACKUP_RE.test(name.slice(base.length))) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed.push(path.join(dir, name)); } catch {}
  }
  return removed;
}

// 改写首行 + 原样搬运正文，最后 rename 覆盖。正文走 Buffer 分块，
// 既不吃内存也保证字节级一致；读到 EOF 为止而不是按开头 stat 的 size 截断。
function rewriteFirstLineAtomic(rolloutPath, nextFirstLine, info) {
  const tmp = `${rolloutPath}.${nextTmpSuffix()}.tmp`;
  let src = null;
  let dst = null;
  try {
    // 'wx'：临时文件万一撞名，宁可失败也不覆盖别人正在写的东西。
    dst = fs.openSync(tmp, 'wx');
    fs.writeSync(dst, Buffer.from(nextFirstLine, 'utf8'));
    if (info.hasTail) {
      src = fs.openSync(rolloutPath, 'r');
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      let pos = info.tailOffset;
      for (;;) {
        const n = fs.readSync(src, buf, 0, buf.length, pos);
        if (n <= 0) break;
        fs.writeSync(dst, buf, 0, n);
        pos += n;
      }
      fs.closeSync(src);
      src = null;
    }
    fs.closeSync(dst);
    dst = null;
    fs.renameSync(tmp, rolloutPath);
  } catch (error) {
    if (src !== null) { try { fs.closeSync(src); } catch {} }
    if (dst !== null) { try { fs.closeSync(dst); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// rollout 是 JSONL，改写必须逐行处理且只动第一行的 session_meta。
// 整文件 JSON.parse 会直接失败，别图省事。
function rewriteRolloutCwd(rolloutPath, toCwd, opts = {}) {
  const info = readFirstLineInfo(rolloutPath);
  if (info.tooLong) {
    return { ok: false, reason: `rollout 首行超过 ${FIRST_LINE_MAX_BYTES} 字节仍未见换行，拒绝改写` };
  }

  let meta;
  try {
    meta = JSON.parse(info.firstLine);
  } catch (error) {
    return { ok: false, reason: `rollout 首行不是合法 JSON: ${error && error.message}` };
  }
  if (!meta || meta.type !== 'session_meta' || !meta.payload) {
    return { ok: false, reason: `rollout 首行不是 session_meta（type=${meta && meta.type}）` };
  }

  const oldCwd = meta.payload.cwd || null;
  // 大小写不同、`\\?\` 前缀、正反斜杠混用都算「已经是目标目录」，直接短路：
  // 内容没变还去重写，等于白白搬一遍 GB 级文件再多存一份备份。
  if (oldCwd && normalizeCwdForCompare(oldCwd) === normalizeCwdForCompare(toCwd)) {
    return { ok: true, alreadyCurrent: true, oldCwd, rolloutPath };
  }

  meta.payload.cwd = toCwd;
  const nextFirstLine = JSON.stringify(meta) + (info.crlf ? '\r' : '');
  if (nextFirstLine.includes('\n')) {
    return { ok: false, reason: 'JSONL 首行序列化后混入换行，拒绝写入' };
  }

  // 先备份再原子替换：写坏 rollout 等于丢掉整段会话历史，不能赌。
  // 备份只存首行 —— 这次改写也只碰首行，正文由 rename 保证要么全旧要么全新。
  const backupPath = backupFileFor(rolloutPath, resolveBackupDir(opts));
  const prevBackupRaw = saveFirstLineBackup(backupPath, rolloutPath, info.firstLine, oldCwd);
  try {
    rewriteFirstLineAtomic(rolloutPath, nextFirstLine, info);
  } catch (error) {
    restoreBackupRaw(backupPath, prevBackupRaw);
    throw error;
  }
  const prunedLegacyBackups = pruneLegacyFullBackups(rolloutPath);
  return { ok: true, oldCwd, newCwd: toCwd, rolloutPath, backup: backupPath, prunedLegacyBackups };
}

/**
 * 把某个 Codex 会话记录的工作目录改写成 toCwd。
 * 失败一律返回 { ok:false, reason }，由调用方决定是中止还是降级——
 * 归档本身已经成功，这里失败最多是「resume 时又弹一次菜单」，不该反向拖垮归档。
 */
function migrateCodexSession(opts = {}) {
  const sessionId = String(opts.sessionId || '');
  const toCwd = opts.toCwd;
  if (!sessionId || !toCwd) return { ok: false, reason: 'sessionId 和 toCwd 必填' };

  const sessionsRoot = opts.sessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT;
  let rolloutPath = null;
  try {
    rolloutPath = findCodexRolloutBySid(sessionId, sessionsRoot);
  } catch (error) {
    return { ok: false, reason: `查找 rollout 失败: ${error && error.message}` };
  }
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return { ok: false, reason: `未找到 codex rollout: ${sessionId}` };
  }

  try {
    return rewriteRolloutCwd(rolloutPath, path.resolve(toCwd), { backupDir: opts.backupDir });
  } catch (error) {
    return { ok: false, reason: `改写 rollout cwd 失败: ${error && error.message}` };
  }
}

function readCodexSessionCwd(sessionId, sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT) {
  try {
    const p = findCodexRolloutBySid(sessionId, sessionsRoot);
    if (!p) return null;
    const info = readFirstLineInfo(p);
    if (info.tooLong) return null;
    const meta = JSON.parse(info.firstLine);
    return (meta && meta.payload && meta.payload.cwd) || null;
  } catch {
    return null;
  }
}

module.exports = {
  migrateCodexSession,
  readCodexSessionCwd,
  rewriteRolloutCwd,
  // 备份路径与比较口径导出给测试/排查用，不参与业务流程。
  backupFileFor,
  resolveBackupDir,
  normalizeCwdForCompare,
};
