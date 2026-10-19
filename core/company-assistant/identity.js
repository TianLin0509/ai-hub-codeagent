'use strict';
// 公司真机 Q-1019-07：contact detail 的 users[]，w3Account/personAccount → chineseName。
// 自动采集与只读 CLI 包装共用；只保留展示需要的字段，不落整份通讯录资料。
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const W = require('./welink');
const DAY = 86400000, MISS_TTL = 10 * 60000;
const safeAccount = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/.test(v);
const cleanName = v => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').trim().slice(0, 128) : '';
const hasChinese = v => /\p{Script=Han}/u.test(v || '');
const readCache = file => { try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return c.version === 1 && c.entries && typeof c.entries === 'object' ? c.entries : {}; } catch { return {}; } };

async function mergeCache(file, updates, now) {
  // Hub 与 CLI 是不同进程。锁内只做同步读改写，防止两份旧副本相互覆盖。
  const lock = file + '.lock', deadline = Date.now() + 500;
  let fd, tmp;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    while (fd === undefined) {
      try { fd = fs.openSync(lock, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 临时写锁不包含资料；上个进程崩溃遗留的锁可回收。
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch { /* 下轮再试 */ }
        if (Date.now() >= deadline) return readCache(file);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const merged = readCache(file);
    for (const [account, incoming] of Object.entries(updates)) {
      const latest = merged[account];
      const keepLatest = latest?.name && latest.status === 'resolved' && latest.expiresAt > now &&
        (incoming.status !== 'resolved' || latest.resolvedAt > incoming.resolvedAt ||
          latest.resolvedAt === incoming.resolvedAt && latest.source === 'contact-detail' && incoming.source !== 'contact-detail');
      merged[account] = keepLatest ? latest : incoming;
    }
    for (const [account, value] of Object.entries(merged)) if (!value || Number(value.expiresAt) < now - 7 * DAY) delete merged[account];
    tmp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: merged }), 'utf8');
    fs.renameSync(tmp, file); tmp = null;
    return merged;
  } catch { return readCache(file); }
  finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* 下次清理 */ }
    if (fd !== undefined) { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch { /* 锁会过期 */ } } }
  }
}

async function resolveNames({ run, cacheDir, identity, accounts, seeds = new Map(), now = Date.now(), batchSize = 10, maxCalls = 16, budgetMs = 15000 }) {
  const wanted = [...new Set(accounts.filter(a => typeof a === 'string' && a))];
  const entries = new Map(), updates = Object.create(null);
  const file = cacheDir && identity ? path.join(cacheDir, 'names-' + createHash('sha256').update(identity).digest('hex') + '.json') : null;
  const cached = file ? readCache(file) : {};
  const pending = [];
  let calls = 0;
  const deadline = Date.now() + budgetMs;
  for (const account of wanted) {
    const old = cached[account], seed = cleanName(seeds.get(account));
    if (old && Number(old.expiresAt) > now && (!seed || old.name || old.status === 'resolved')) { entries.set(account, old); continue; }
    if (seed && hasChinese(seed)) {
      const entry = { name: seed, status: 'resolved', source: 'conversation', resolvedAt: now, expiresAt: now + DAY };
      entries.set(account, entry); updates[account] = entry; continue;
    }
    entries.set(account, { name: cleanName(old?.name) || seed, status: old?.name ? 'stale' : seed ? 'fallback' : 'unresolved', source: old?.source || (seed ? 'conversation' : ''), resolvedAt: old?.resolvedAt || null });
    if (identity && safeAccount(account)) pending.push(account);
  }
  const saveMiss = (account, status) => {
    const previous = entries.get(account) || {};
    const entry = { ...previous, status: previous.name ? 'stale' : status, expiresAt: now + MISS_TTL };
    entries.set(account, entry); updates[account] = entry;
  };
  const chunks = [];
  const size = Math.max(1, Math.min(20, batchSize));
  for (let i = 0; i < pending.length; i += size) chunks.push(pending.slice(i, i + size));
  while (chunks.length && calls < maxCalls && Date.now() < deadline) {
    const batch = chunks.shift();
    let data;
    try {
      calls += 1;
      const r = await run(['contact', 'detail', ...batch], { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) });
      data = W.parseJson(r.stdout);
      if (Number(r.code || 0) !== 0 || !data || String(data.code) !== '0' || !Array.isArray(data.users)) {
        // 单个坏账号不能拖累整批；只对已核实的“人员不存在”业务码拆批，不放大超时/权限错误。
        if (String(data?.code) === '47111' && batch.length > 1) {
          const half = Math.ceil(batch.length / 2); chunks.unshift(batch.slice(0, half), batch.slice(half)); continue;
        }
        for (const account of batch) saveMiss(account, String(data?.code) === '47111' ? 'not-found' : 'error');
        continue;
      }
    } catch { for (const account of batch) saveMiss(account, 'error'); continue; }
    const found = new Map(), conflicted = new Set();
    for (const user of data.users) {
      const ids = [...new Set([user?.w3Account, user?.personAccount].filter(v => typeof v === 'string' && v))];
      if (ids.length !== 1 || !batch.includes(ids[0])) continue;
      const account = ids[0], name = cleanName(user.chineseName) || cleanName(user.englishName);
      if (!name || name === account) continue;
      if (found.has(account) && found.get(account).name !== name) conflicted.add(account);
      found.set(account, { name, status: 'resolved', source: 'contact-detail', resolvedAt: now, expiresAt: now + 7 * DAY,
        ...(typeof user.workId === 'string' ? { workId: user.workId } : {}) });
    }
    for (const account of batch) {
      const entry = !conflicted.has(account) && found.get(account);
      if (entry) { entries.set(account, entry); updates[account] = entry; }
      else saveMiss(account, 'unresolved');
    }
  }
  for (const account of chunks.flat()) entries.set(account, { ...entries.get(account), status: entries.get(account)?.name ? 'stale' : 'pending' });
  if (file && Object.keys(updates).length) {
    const merged = await mergeCache(file, updates, now);
    for (const account of wanted) {
      const latest = merged[account], own = entries.get(account);
      if (latest?.name && latest.status === 'resolved' && latest.expiresAt > now && (own?.status !== 'resolved' || latest.resolvedAt >= own.resolvedAt)) entries.set(account, latest);
    }
  }
  const duplicates = new Map();
  for (const [account, entry] of entries) if (entry.name) { const ids = duplicates.get(entry.name) || new Set(); ids.add(account); duplicates.set(entry.name, ids); }
  for (const [account, entry] of entries) entries.set(account, { ...entry, displayName: entry.name ? (duplicates.get(entry.name).size > 1 ? `${entry.name}（${account}）` : entry.name) : account });
  return { entries, stats: { total: wanted.length, resolved: [...entries.values()].filter(e => e.status === 'resolved').length,
    unresolved: [...entries.values()].filter(e => e.status !== 'resolved').length, calls } };
}

function applyNames(messages, resolution) {
  return messages.map(m => {
    const e = resolution.entries.get(m.account);
    if (!e) return m;
    return { ...m, sender: m.mine ? '我' : e.displayName, senderName: e.name || '', nameStatus: e.status, nameSource: e.source, nameResolvedAt: e.resolvedAt || null };
  });
}

module.exports = { resolveNames, applyNames };
