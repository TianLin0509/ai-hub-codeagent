'use strict';
// 修正公司个人账号的 CodeAgent 默认模型（远程维护 set-personal-model，2026-10-19 用户明确授权：「授权你来做」）。
//
// 背景：公司个人账号只有 GLM-5.2-WX-Auto 权限，个人配置目录 settings.json 的 model 却是 deepseek-v4-flash-0731，
// 个人账号开出来的会话一启动就报「模型 … 不存在或配置有误」（2026-10-19 00:18 直查 errors 段原文）。
// 只能由对端经远程维护手动触发，Hub 不会自动改这份文件（号主自己日常用的配置）。
//
// 做法（只动 model 这一个键，其余内容原样保留）：
//   1. 目标模型必须在个人账号的权限清单里，并且有权限依据：清单来自「获取模型权限」的探测文件，或个人账号实际用它作答过
//      （分档名 GLM-5.2-WX 算 GLM-5.2-WX-Auto）；都没有时拒绝，force 才跳过这一条（审核 2026-10-19）。撤销（restore）时用最近一次备份里的值；
//   2. 改前把原文件整份备份为 settings.json.hub-backup-<时间>（撤销时自己的备份带 -undo 后缀，撤销只认非 -undo 的，连点两次撤销结果一样）；
//   3. 先写临时文件再改名（失败重试一次）；写完回读核对：model 是目标值、其余键和原来一致；核对不过就用备份还原并报失败；
//   4. 只影响之后新开的会话：CodeAgent 开会话时读一次 settings.json，已在跑的会话不受影响。
// 个人账号目录和号池（根目录或任何一个号的目录）相同或互相包含时拒绝（先 realpath 再比），绝不改号池账号的目录。
const fs = require('fs');
const path = require('path');

const BACKUP_PREFIX = 'settings.json.hub-backup-';
const KEEP_BACKUPS = 10;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

function stamp(now) {
  const d = new Date(Number(now) + 8 * 3600000); // 北京时间，便于人看
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}
function parseSettings(raw) {
  if (raw == null || !String(raw).trim()) return {};
  const v = JSON.parse(String(raw).replace(/^﻿/, ''));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('settings.json 不是对象');
  return v;
}
const modelOf = obj => (typeof obj.model === 'string' ? obj.model : undefined);
const withoutModel = obj => { const { model, ...rest } = obj; void model; return JSON.stringify(rest); };

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// 个人账号的权限清单（和号表同一口径）。source：probe = 「获取模型权限」的探测文件（personal-models.json）；
// enterprise = CodeAgent 自己存在配置目录 .cac.json 里的账号模型清单（enterpriseModelOptionsCache，它的 /model 菜单就按这个列）；
// config = 从配置文件里零散收集的模型名（可能混进 settings 里写错的那个），不算权威。前两种 authoritative。
function allowedModels({ dataDir, personalDir, fsModule = fs }) {
  const pool = require('./codeagent-pool');
  const known = pool.accountModels(personalDir, fsModule, dataDir ? pool.personalModelsFile(dataDir) : null);
  const source = known.probedAt ? 'probe' : known.authoritative ? 'enterprise' : 'config';
  return { models: (known.models || []).slice(), authoritative: !!known.authoritative, probedAt: known.probedAt || null, source };
}
// 实际作答过的模型能不能证明目标模型有权限：同名，或分档名（GLM-5.2-WX）落到菜单里的 -Auto（2026-10-13 / 10-17 公司真机）。
function answeredProves(answered, target) {
  const t = String(target || '').toLowerCase();
  return (answered || []).some(m => { const x = String(m || '').toLowerCase(); return !!x && (x === t || x + '-auto' === t); });
}

// 报给对端的只有固定文案和 code（审核 2026-10-19：路径、JSON 片段只进本机审计日志）；detail 是本机排查用的原始信息。
function fail(code, text, detail = '') { return Object.assign(new Error(text), { code, detail: String(detail || '') }); }

function listBackups(personalDir, fsModule = fs) {
  let names = [];
  try { names = fsModule.readdirSync(personalDir).filter(n => n.startsWith(BACKUP_PREFIX)); } catch { names = []; }
  return names.sort(); // 时间戳定长，按名字排就是按时间排
}
// 最近一次修改前的备份（撤销会用它）：{ name, model }，没有返回 null。直查据此显示「撤销」按钮。
function latestBackup(personalDir, fsModule = fs) {
  const name = listBackups(personalDir, fsModule).filter(n => !n.endsWith('-undo')).pop();
  if (!name) return null;
  try { return { name, model: modelOf(parseSettings(fsModule.readFileSync(path.join(personalDir, name), 'utf8'))) || '' }; } catch { return { name, model: null }; }
}

function atomicWrite(file, text, fsModule) {
  const tmp = `${file}.hub-model-${process.pid}-${Date.now()}.tmp`;
  fsModule.writeFileSync(tmp, text, 'utf8');
  try {
    try { fsModule.renameSync(tmp, file); }
    catch { fsModule.renameSync(tmp, file); } // Windows 上 CodeAgent 或杀毒正读着时偶尔失败：重试一次
  } catch (error) {
    try { fsModule.unlinkSync(tmp); } catch { /* 临时文件已不在 */ }
    throw error;
  }
}

// 返回 { ok, changed, before, after, backup, verified, verifiedBy, rolledBack?, error?, code?, detail?, allowed }；
// 参数或前提不对抛带 code 的错误（调用方回报固定文案）。
// 权限校验（审核 2026-10-19）：目标模型要在权限清单里，并且满足其一——(a) 清单来自探测文件；(b) answered（个人账号上实际作答过的模型）能证明；
// 都不满足时拒绝，force:true 才跳过这一条（verifiedBy='force'，调用方回报里标「未经权限校验」）。其余校验照常。
function setPersonalModel({ dataDir, personalDir, model = '', restore = false, force = false, answered = [], now = Date.now(), fsModule = fs } = {}) {
  if (!personalDir) throw fail('no-personal-dir', '读不到个人账号的配置目录');
  // 个人目录和号池根目录或任何一个号的目录相同、互相包含，都拒绝（先 realpath，Windows 上不分大小写和分隔符；
  // 2026-10-19 公司真机：旧的按字面路径比对没拦住，改的其实是号 1 的目录，10:01 号 1 开会话又被同步写回）。
  if (dataDir) {
    let match = null;
    try { match = require('./codeagent-pool').poolDirMatch(dataDir, personalDir, { fsModule }); }
    catch (error) { throw fail('pool-check-failed', '核对个人账号目录是否和号池重叠时出错，没改', error.message); }
    if (match || inside(personalDir, require('./codeagent-pool').poolRoot(dataDir))) {
      throw fail('in-pool-dir', '个人账号的配置目录落在号池目录里（或和号池里某个号的目录重叠），这不是个人账号的目录，不改', `${personalDir}${match && match.id ? `（号 ${match.id}）` : ''}`);
    }
  }
  const file = path.join(personalDir, 'settings.json');
  let raw = null;
  try { raw = fsModule.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw fail('read-failed', '读不了个人账号的 settings.json，没改', error.message); }
  let current;
  try { current = parseSettings(raw); } catch (error) { throw fail('bad-json', '个人账号的 settings.json 不是有效的 JSON，没改', error.message); }
  const before = modelOf(current);
  const list = allowedModels({ dataDir, personalDir, fsModule });
  const allowed = list.models;

  let target, restoredFrom = null, verifiedBy = null;
  if (restore) {
    const backups = listBackups(personalDir, fsModule).filter(n => !n.endsWith('-undo'));
    if (!backups.length) throw fail('no-backup', '没有可以撤销的备份（还没用 set-personal-model 改过）');
    restoredFrom = backups[backups.length - 1];
    let saved;
    try { saved = parseSettings(fsModule.readFileSync(path.join(personalDir, restoredFrom), 'utf8')); }
    catch (error) { throw fail('backup-unreadable', '最近一次备份读不了，没撤销', `${restoredFrom}：${error.message}`); }
    target = modelOf(saved);
    verifiedBy = 'backup';
  } else {
    const want = String(model || '').trim();
    if (!MODEL_ID.test(want)) throw fail('bad-model', 'model 要是模型名（如 GLM-5.2-WX-Auto）');
    if (!allowed.length) throw fail('list-unknown', '个人账号的模型权限清单未知，不改；请在公司 Hub「账号与号池」里点「获取模型权限」');
    target = allowed.find(m => m.toLowerCase() === want.toLowerCase());
    if (!target) throw fail('not-in-list', `${want} 不在个人账号的权限清单里，可选：${allowed.join('、')}`);
    if (list.authoritative) verifiedBy = list.source;
    else if (answeredProves(answered, target)) verifiedBy = 'answered';
    else if (force) verifiedBy = 'force';
    else throw fail('unverified', `个人账号的权限清单不权威（没经过探测，也不是 CodeAgent 自己的账号清单），也没有个人账号实际用 ${target} 作答过的记录，没改；请在公司 Hub 点「获取模型权限」，或者用 --force-unverified 强制写入`);
  }
  if (target === before) {
    return { ok: true, changed: false, before: before ?? '', after: target ?? '', backup: null, verified: true, verifiedBy, allowed, restoredFrom };
  }

  // 1. 整份备份（原来没有文件就记成 {}，撤销时等于去掉 model）
  const backup = BACKUP_PREFIX + stamp(now) + (restore ? '-undo' : '');
  const backupText = raw == null ? '{}\n' : raw;
  try { fsModule.writeFileSync(path.join(personalDir, backup), backupText, 'utf8'); }
  catch (error) { throw fail('backup-failed', '写备份失败，没改', error.message); }
  // 2. 只改 model 这一个键
  const next = { ...current };
  if (target === undefined) delete next.model; else next.model = target;
  const source = restore ? 'remote:set-personal-model-undo' : 'remote:set-personal-model';
  try { require('./codeagent-default-model-guard').noteHubWrite(personalDir, target ?? '', source, { logged: true }); } catch { /* 只影响留痕 */ }
  try { atomicWrite(file, JSON.stringify(next, null, 2) + '\n', fsModule); }
  catch (error) { throw fail('write-failed', '写入个人账号的 settings.json 失败，原文件没变', error.message); }
  // 3. 回读核对：model 是目标值，其余键和原来一致
  let verified = false, why = '';
  try {
    const back = parseSettings(fsModule.readFileSync(file, 'utf8'));
    verified = modelOf(back) === target && withoutModel(back) === withoutModel(current);
    if (!verified) why = `回读到的 model 是 ${modelOf(back) ?? '（空）'}${withoutModel(back) === withoutModel(current) ? '' : '，且其他内容也不一致'}`;
  } catch (error) { why = '回读失败：' + error.message; }
  if (!verified) {
    let rolledBack = false;
    try {
      if (raw == null) fsModule.rmSync(file, { force: true });
      else atomicWrite(file, raw, fsModule);
      rolledBack = true;
    } catch (error) { why += `；从备份还原也失败了（${error.message}），备份在 ${backup}`; }
    return { ok: false, changed: false, before: before ?? '', after: before ?? '', backup, verified: false, verifiedBy, rolledBack, code: 'verify-failed',
      error: `写入后回读核对不一致${rolledBack ? '，已从备份还原' : '，从备份还原也失败了，请在公司电脑上检查'}`, detail: why, allowed, restoredFrom };
  }
  // 留痕：codeagent-model.log 记一行写前、写后、来源，直查个人号行据此报「最近一次被改写的来源」
  if (dataDir) { try { require('./codeagent-default-model-guard').recordChange(dataDir, { account: '个人', before: before ?? '', after: target ?? '', source, at: Number(now) || Date.now() }); } catch { /* 只影响留痕 */ } }
  // 4. 备份只留最近 10 份（修改的和撤销的分开算，撤销用的那份不会被撤销备份挤掉）
  const all = listBackups(personalDir, fsModule);
  for (const group of [all.filter(n => !n.endsWith('-undo')), all.filter(n => n.endsWith('-undo'))]) {
    for (const old of group.slice(0, Math.max(0, group.length - KEEP_BACKUPS))) { try { fsModule.rmSync(path.join(personalDir, old), { force: true }); } catch { /* 删不掉下次再删 */ } }
  }
  return { ok: true, changed: true, before: before ?? '', after: target ?? '', backup, verified: true, verifiedBy, allowed, restoredFrom };
}

module.exports = { setPersonalModel, allowedModels, answeredProves, listBackups, latestBackup, BACKUP_PREFIX, KEEP_BACKUPS };
