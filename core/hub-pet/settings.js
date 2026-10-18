'use strict';
// 桌宠设置存在 Hub 数据目录的 hub-pet.json。公司版默认开，家里自用版默认关（2026-10-16 用户），设置里可改。
// 角色合不合法看 roleOk（2026-10-17 起形象可在线下载：以「这台电脑上装没装」为准，没装的回落小猫）。
const fs = require('fs');
const path = require('path');
const { MODES, ROLES } = require('./state');

const FILE = 'hub-pet.json';
const SCALE_MIN = 0.6, SCALE_MAX = 1.6;
const BOX_MAX = 0.45;          // 透明边最多占身体框的比例，防止一张奇怪的图把限位算坏
const BOX_ROLES_MAX = 24;

function defaults({ company = false } = {}) {
  return { enabled: !!company, role: '01-cat', mode: 'gentle', position: null, quietUntil: 0, silentDate: '', peekOnFullscreen: true, scale: 1, bodyBoxes: {} };
}

// 大小（2026-10-18）：身体是原大小的 0.6–1.6 倍，按 0.01 取整。认数字和「数字样子的字符串」（手改文件时常见），
// 其他（空串、null、布尔、NaN、对象）一律不认，返回 null 表示「保留原值」。
function parseScale(v) {
  if (typeof v === 'string') { if (!v.trim()) return null; v = Number(v); }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 100) / 100;
}

// 形象图四周的透明边（比例）。渲染端量出来后记进文件，下次启动直接用，不等量完再挪一次窗口。
function parseBox(b) {
  if (!b || typeof b !== 'object') return null;
  const f = v => (Number.isFinite(Number(v)) ? Math.round(Math.min(BOX_MAX, Math.max(0, Number(v))) * 10000) / 10000 : 0);
  return { left: f(b.left), right: f(b.right), top: f(b.top), bottom: f(b.bottom) };
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
  const scale = parseScale(raw.scale);
  if (scale != null) out.scale = scale;
  const p = raw.position;
  if (p === null) out.position = null;
  else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.position = { x: Math.round(p.x), y: Math.round(p.y) };
  if (Number.isFinite(raw.quietUntil) && raw.quietUntil >= 0) out.quietUntil = raw.quietUntil;
  if (raw.silentDate === '' || (typeof raw.silentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.silentDate))) out.silentDate = raw.silentDate;
  if (raw.bodyBoxes && typeof raw.bodyBoxes === 'object' && !Array.isArray(raw.bodyBoxes)) {
    const boxes = { ...(base.bodyBoxes || {}) };
    for (const [id, b] of Object.entries(raw.bodyBoxes)) {
      if (!/^[\w-]{1,40}$/.test(id)) continue;
      const box = parseBox(b);
      if (box) boxes[id] = box;
    }
    out.bodyBoxes = Object.fromEntries(Object.entries(boxes).slice(-BOX_ROLES_MAX));
  }
  return out;
}

function createSettingsStore({ dataDir, company = false, logger = console, roleOk = builtinRole } = {}) {
  const file = path.join(dataDir, FILE);
  const base = defaults({ company });
  let value = base;
  let dirty = false;
  try { value = normalize(JSON.parse(fs.readFileSync(file, 'utf8')), base, roleOk); }
  catch (error) { if (error.code !== 'ENOENT') logger.warn?.('[hub-pet] settings unreadable, using defaults:', error.message); }

  function save() {
    dirty = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) { logger.warn?.('[hub-pet] settings save failed:', error.message); }
  }

  return {
    file,
    get: () => ({ ...value, bodyBoxes: { ...value.bodyBoxes } }),
    // 不合法的字段保留原值；position 传 null、quietUntil 传 0、silentDate 传空串表示清掉。
    // persist:false 只改内存（拖大小滑块的过程中），之后由 flush() 或下一次普通 update 一起写盘。
    update(patch, { persist = true } = {}) {
      const before = JSON.stringify(value);
      value = normalize(patch, value, roleOk);
      if (persist) save(); else if (JSON.stringify(value) !== before) dirty = true;
      return { ...value };
    },
    flush() { if (dirty) save(); },
    isDirty: () => dirty,
  };
}

module.exports = { FILE, SCALE_MAX, SCALE_MIN, createSettingsStore, defaults, normalize, parseBox, parseScale };
