'use strict';
// 桌宠设置存在 Hub 数据目录的 hub-pet.json。公司版默认开，家里自用版默认关（2026-10-16 用户），设置里可改。
// 角色合不合法看 roleOk（2026-10-17 起形象可在线下载：以「这台电脑上装没装」为准，没装的回落小猫）。
const fs = require('fs');
const path = require('path');
const { MODES, ROLES } = require('./state');

const FILE = 'hub-pet.json';

function defaults({ company = false } = {}) {
  return { enabled: !!company, role: '01-cat', mode: 'gentle', position: null, quietUntil: 0, silentDate: '', peekOnFullscreen: true };
}

// 以 base 为底，只采纳 raw 里合法的字段。
const builtinRole = id => ROLES.some(r => r.id === id);

function normalize(raw, base, roleOk = builtinRole) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.role === 'string' && roleOk(raw.role)) out.role = raw.role;
  if (MODES.includes(raw.mode)) out.mode = raw.mode;
  if (typeof raw.peekOnFullscreen === 'boolean') out.peekOnFullscreen = raw.peekOnFullscreen;
  const p = raw.position;
  if (p === null) out.position = null;
  else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.position = { x: Math.round(p.x), y: Math.round(p.y) };
  if (Number.isFinite(raw.quietUntil) && raw.quietUntil >= 0) out.quietUntil = raw.quietUntil;
  if (raw.silentDate === '' || (typeof raw.silentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.silentDate))) out.silentDate = raw.silentDate;
  return out;
}

function createSettingsStore({ dataDir, company = false, logger = console, roleOk = builtinRole } = {}) {
  const file = path.join(dataDir, FILE);
  const base = defaults({ company });
  let value = base;
  try { value = normalize(JSON.parse(fs.readFileSync(file, 'utf8')), base, roleOk); }
  catch (error) { if (error.code !== 'ENOENT') logger.warn?.('[hub-pet] settings unreadable, using defaults:', error.message); }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) { logger.warn?.('[hub-pet] settings save failed:', error.message); }
  }

  return {
    file,
    get: () => ({ ...value }),
    // 不合法的字段保留原值；position 传 null、quietUntil 传 0、silentDate 传空串表示清掉。
    update(patch) { value = normalize(patch, value, roleOk); save(); return { ...value }; },
  };
}

module.exports = { FILE, createSettingsStore, defaults, normalize };
