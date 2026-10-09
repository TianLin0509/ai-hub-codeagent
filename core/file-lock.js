const fs = require('fs');

// Minimal cross-process file lock built on fs.openSync(path, 'wx').
// 'wx' = O_CREAT | O_EXCL: atomically fails with EEXIST if the file already
// exists, so two processes racing to create the same lock file get exactly
// one winner. Works on Windows + POSIX without any external dependency.
//
// Why not proper-lockfile from npm? CLAUDE.md forbids npm install in the
// main worktree, and the production hub worktree shares node_modules via
// junction — installing here would pollute production. The semantics we
// need (acquire/release + stale detection + retry + fallback on failure)
// are tiny enough to write inline.
//
// Usage:
//   const fd = acquireLock('/path/to/foo.lock');
//   if (fd != null) {
//     try { ...protected work... }
//     finally { releaseLock(fd, '/path/to/foo.lock'); }
//   } else {
//     // could not acquire within timeout; caller decides what to do
//     // (usually log + proceed without lock as a graceful fallback)
//   }

const DEFAULT_RETRIES = 20;
// 2026-05-07 maintainer — 多方审查 fix：原 50ms × 20 = 最多 1s 同步 spin 阻塞事件循环。
// 缩短到 10ms × 20 = 最多 200ms。100 进程压测过零丢失说明竞争实际很罕见，10ms 够用。
const DEFAULT_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_MS = 10000; // a writer holding the lock > 10s is considered crashed

function _sleepBusy(ms) {
  // Sync busy wait — only used between retries, total bounded by retries*delay
  // (~1s). Saves us from making save() async-only.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function _sleepAsync(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _isContentionError(error) {
  // Windows can briefly report EACCES/EPERM/EBUSY while another process is
  // closing or deleting the lock file. Treat those as contention.
  return !!error && ['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code);
}

async function acquireLockAsync(lockPath, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const owner = { pid: process.pid, mtime: Date.now() };
  let staleReaped = 0;
  const staleReapLimit = 3;

  for (let attempts = 0; attempts <= retries;) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      try { await handle.writeFile(JSON.stringify(owner)); } catch {}
      return handle;
    } catch (error) {
      if (!_isContentionError(error)) return null;
      let didReap = false;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try { await fs.promises.unlink(lockPath); didReap = true; } catch {}
        }
      } catch {}
      if (didReap) {
        staleReaped += 1;
        if (staleReaped > staleReapLimit) return null;
        continue;
      }
      if (attempts >= retries) return null;
      attempts += 1;
      await _sleepAsync(retryDelayMs);
    }
  }
  return null;
}

function acquireLock(lockPath, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const owner = { pid: process.pid, mtime: Date.now() };

  let attempts = 0;
  // Cap stale-reap retries separately to avoid unbounded loop if a stale-detect
  // race keeps re-creating the lock under us.
  let staleReaped = 0;
  const STALE_REAP_LIMIT = 3;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify(owner)); } catch { /* writing meta is best-effort */ }
      return fd;
    } catch (e) {
      if (!_isContentionError(e)) {
        // Permissions / FS error — bail to fallback path.
        return null;
      }
      // Stale lock detection: if the file is older than staleMs, the owner
      // probably crashed without releasing. Reap it and retry immediately
      // WITHOUT consuming a retry slot (otherwise stale + retries=0 deadlocks).
      let didReap = false;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockPath); didReap = true; } catch { /* another proc may have just released */ }
        }
      } catch { /* lock file vanished between EEXIST and statSync — race-friendly */ }

      if (didReap) {
        staleReaped++;
        if (staleReaped > STALE_REAP_LIMIT) return null;
        continue;
      }

      if (attempts >= retries) return null;
      attempts++;
      _sleepBusy(retryDelayMs);
    }
  }
}

function releaseLock(fd, lockPath) {
  // 2026-05-07 maintainer — 多方审查 fix：原版无条件 unlink 会破坏互斥语义。
  //   场景：A 拿锁 → A 卡住 > staleMs → B 把 A 的 lock 当 stale unlink → B 拿到新锁
  //   → A 醒来执行 releaseLock 又把 B 的 lock 删了 → C/A 都能 openSync 'wx' 成功
  //   → 互斥被破坏，state.json 可能并发损坏。
  //
  // 修复：unlink 之前比对 owner pid。如果磁盘上 lock 文件的 pid 不是自己，说明
  //   这把锁已经被 stale 接管，本进程不再拥有，只 closeSync(fd) 不删文件。
  //   读 owner 失败（文件已被别人删）也保持安全：跳过 unlink。
  if (fd != null) {
    try { fs.closeSync(fd); } catch { /* close errors don't block release */ }
  }
  let weStillOwnIt = false;
  try {
    const meta = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (meta && meta.pid === process.pid) weStillOwnIt = true;
  } catch { /* lock file vanished or unparseable — treat as not ours */ }
  if (weStillOwnIt) {
    try { fs.unlinkSync(lockPath); } catch { /* might have just been reaped */ }
  }
}

async function releaseLockAsync(handle, lockPath) {
  if (handle) {
    try { await handle.close(); } catch {}
  }
  let weStillOwnIt = false;
  try {
    const meta = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
    weStillOwnIt = !!meta && meta.pid === process.pid;
  } catch {}
  if (weStillOwnIt) {
    try { await fs.promises.unlink(lockPath); } catch {}
  }
}

module.exports = { acquireLock, acquireLockAsync, releaseLock, releaseLockAsync };
