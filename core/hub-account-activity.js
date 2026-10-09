'use strict';
// Passive metadata only: no browser, prompts or credentials in the public result.
const fs = require('fs'), path = require('path');
const SITES = new Set([...require('./hub-account-catalog').COMPANIES.map(c => c.site), 'github']);
// Recorded by the tools themselves; image results are read from the image queue instead.
const SOURCES = new Set(['website', 'roundtable', 'bridge']);
const STEPWISE = new Set(['bridge']), RECORD_EVERY_MS = 60000;
const HISTORY_HOSTS = { chatgpt: ['chatgpt.com'], claude: ['claude.ai'], google: ['gemini.google.com'],
  doubao: ['doubao.com'], deepseek: ['chat.deepseek.com'], kimi: ['kimi.com'], qwen: ['qianwen.com'],
    github: ['github.com'] };
const historyCache = new Map();
function historyActivity(root, now = Date.now()) {
  const rows = [];
  for (const identity of ['main', 'alt']) {
    const file = path.join(root, identity, 'History');
    let stat;
    try { stat = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const cached = historyCache.get(file);
    if (cached && now - cached.readAt < 30000 && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      rows.push(...cached.rows); continue;
    }
    // Chrome locks History while running. Read a private snapshot; never ask Chrome to open a page.
    const copy = path.join(require('os').tmpdir(), `hub-history-${process.pid}-${require('crypto').randomUUID()}.db`);
    let db;
    try {
      fs.copyFileSync(file, copy);
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(copy, { readOnly: true });
      const latest = new Map();
      for (const visit of db.prepare('SELECT url, last_visit_time / 1000 AS time FROM urls WHERE last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT 10000').all()) {
        let host;
        try { host = new URL(visit.url).hostname.toLowerCase(); } catch { continue; }
        for (const [site, hosts] of Object.entries(HISTORY_HOSTS)) {
          if (latest.has(site) || !hosts.some(h => host === h || host.endsWith('.' + h))) continue;
          const at = Number(visit.time) - 11644473600000;
          if (Number.isFinite(at) && at > 0 && at <= now + 60000) latest.set(site, { identity, site, source: 'history', outcome: 'visited', at });
        }
        if (latest.size === Object.keys(HISTORY_HOSTS).length) break;
      }
      const found = [...latest.values()];
      historyCache.set(file, { readAt: now, mtimeMs: stat.mtimeMs, size: stat.size, rows: found });
      rows.push(...found);
    } finally {
      try { db?.close(); } finally { try { fs.unlinkSync(copy); } catch { /* private snapshot only */ } }
    }
  }
  return rows;
}
function recordActivity(root, { identity = 'main', site, source = 'website', outcome, at = Date.now() }) {
  if (!['main', 'alt'].includes(identity) || !SITES.has(site) || !SOURCES.has(source)
      || !['opened', 'success', 'failed', 'login_required', 'verification_required', 'network_error', 'rate_limited', 'quota_exhausted', 'adapter_changed'].includes(outcome) || !Number.isFinite(at)) throw Error('账号使用记录无效');
  const dir = path.join(root, 'account-activity'), file = path.join(dir, `${identity}-${site}-${source}.json`);
  fs.mkdirSync(dir, { recursive: true });
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('账号使用记录无法读取'); }
  if (previous?.at > at) return;
  // The bridge reports every step; an unchanged outcome is written at most once a minute.
  if (STEPWISE.has(source) && previous?.outcome === outcome && at - previous.at < RECORD_EVERY_MS) return;
  const value = { identity, site, source, outcome, at, lastSuccessAt: outcome === 'success' ? at : previous?.lastSuccessAt || 0 };
  const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8'); fs.renameSync(tmp, file);
}
function combine(rows) {
  const entries = {};
  for (const row of rows) {
    if (!row || !['main', 'alt'].includes(row.identity) || !SITES.has(row.site) || !Number.isFinite(row.at)) continue;
    const key = row.identity + ':' + row.site, previous = entries[key];
    const chosen = previous?.at > row.at ? previous : row;
    const lastSuccessAt = Math.max(previous?.lastSuccessAt || 0, row.lastSuccessAt || (row.outcome === 'success' ? row.at : 0));
    const rowIssue = ['login_required', 'verification_required'].includes(row.outcome) ? { outcome: row.outcome, at: row.at } : null;
    const issue = (rowIssue?.at || 0) > (previous?.issue?.at || 0) ? rowIssue : previous?.issue;
    // Each tool's own latest result, so the account page can say which tool needs attention.
    const sources = { ...previous?.sources };
    if (!['website', 'history'].includes(row.source) && !(sources[row.source]?.at > row.at))
      sources[row.source] = { outcome: row.outcome, at: row.at, lastSuccessAt: Math.max(sources[row.source]?.lastSuccessAt || 0, row.lastSuccessAt || (row.outcome === 'success' ? row.at : 0)) };
    // The person's own use of the page: opened from the account page or seen in Chrome history.
    const openedAt = Math.max(previous?.openedAt || 0, ['website', 'history'].includes(row.source) ? row.at : 0);
    entries[key] = { identity: chosen.identity, site: chosen.site, source: chosen.source, outcome: chosen.outcome, at: chosen.at,
      lastSuccessAt, ...(openedAt ? { openedAt } : {}), ...(issue && issue.at > lastSuccessAt ? { issue } : {}), ...(Object.keys(sources).length ? { sources } : {}) };
  }
  return entries;
}
function imageActivity(root, env) {
  const isolated = env.CLAUDE_HUB_HOME_DIR || env.CLAUDE_HUB_DATA_DIR;
  const pool = isolated ? path.join(root, 'tool-fixtures/ChatGPTWebImagesPool') : env.CHATGPT_WEB_IMAGES_POOL || 'C:/AppData/ChatGPTWebImagesPool';
  const database = path.join(pool, 'queue.sqlite3');
  if (!fs.existsSync(database)) return [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'tool-bindings.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const bindings = (manifest.tools || []).filter(b => b.tool === 'images' && ['main', 'alt'].includes(b.identity));
  if (!bindings.length) return [];
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100');
    const accounts = db.prepare('SELECT id, config_dir FROM accounts').all(), rows = [];
    const latest = db.prepare("SELECT status, updated, error, result FROM jobs WHERE account_id=? AND status NOT IN ('queued','cancelled') ORDER BY updated DESC LIMIT 1");
    const successful = db.prepare("SELECT updated, result FROM jobs WHERE account_id=? AND status='complete' ORDER BY updated DESC LIMIT 1");
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    for (const account of accounts) {
      const binding = bindings.find(b => typeof b.config === 'string' && same(b.config, path.join(account.config_dir, 'settings.json')));
      if (!binding) continue;
      const config = JSON.parse(fs.readFileSync(binding.config, 'utf8'));
      if (!require('./hub-tool-binding').matchesBinding(binding, config)) continue;
      const job = latest.get(account.id); if (!job) continue;
      const result = JSON.parse(job.result || '{}'), error = JSON.parse(job.error || 'null') || result.error;
      const outcome = ['login_required', 'credential_required', 'account_selection_required'].includes(error?.code) ? 'login_required'
        : error?.code === 'browser_challenge' ? 'verification_required' : error?.code === 'rate_limited' ? 'rate_limited'
        : job.status === 'complete' && result.files?.length ? 'success'
        : ['complete', 'failed', 'preparation_failed', 'needs_attention', 'parked', 'partial', 'count_mismatch'].includes(job.status) ? 'failed' : 'using';
      const last = successful.get(account.id);
      const lastSuccessAt = last && JSON.parse(last.result || '{}').files?.length ? last.updated * 1000 : 0;
      rows.push({ identity: binding.identity, site: 'chatgpt', source: 'images', outcome, at: job.updated * 1000, lastSuccessAt });
    }
    return rows;
  } finally { db.close(); }
}
function readActivity(root, env = process.env) {
  const rows = [], warnings = [], dir = path.join(root, 'account-activity');
  for (const identity of ['main', 'alt']) for (const site of SITES) for (const source of SOURCES) {
    try { rows.push(JSON.parse(fs.readFileSync(path.join(dir, `${identity}-${site}-${source}.json`), 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT' && !warnings.includes('部分使用记录无法读取')) warnings.push('部分使用记录无法读取'); }
  }
  try { rows.push(...historyActivity(root)); } catch { warnings.push('专属 Chrome 访问记录暂时无法读取'); }
  try { rows.push(...imageActivity(root, env)); } catch { warnings.push('生图使用记录暂时无法读取'); }
  return { entries: combine(rows), warnings };
}
function recordWebJob(job, env = process.env) {
  const provider = job.input?.provider, site = provider === 'gemini' ? 'google' : provider;
  if (job.kind !== 'web' || !SITES.has(site) || !['succeeded', 'failed', 'needs_attention'].includes(job.state)) return;
  const { defaultRoot } = require('./hub-chrome');
  const outcome = job.state === 'succeeded' ? 'success' : job.errorCode === 'quota_exhausted' ? 'quota_exhausted' : job.recovery?.reason === 'login_required' ? 'login_required'
    : job.recovery?.reason === 'human_verification' ? 'verification_required' : 'failed';
  recordActivity(defaultRoot(env), { site, source: 'roundtable', outcome, at: Date.parse(job.updatedAt) });
}
module.exports = { recordActivity, readActivity, combine, imageActivity, historyActivity, recordWebJob };
