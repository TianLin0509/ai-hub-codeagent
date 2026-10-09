'use strict';
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');

// A narrow action-command recognizer, not a general natural-language authority
// model or an OS sandbox. Ambiguous/read-only wording stays read-only.
function commandText(text) {
  let command = String(text).trim();
  for (let i = 0; i < 10; i++) {
    const next = command.replace(/^(?:用户[，,\s]*|我想让你|我希望你|我需要你|你能不能|你能否|你帮我|请你|能不能|可不可以|可以|能否|请|麻烦你|麻烦|帮我|帮忙|替我|现在|立刻|马上|先|我想要|我希望|我需要|我想)\s*/, '');
    if (next === command) break;
    command = next;
  }
  return command;
}
function actionIntent(text, type) {
  const original = String(text || '').trim();
  const command = commandText(original);
  if (/^(?:举个例子|例如|比如说|假设|假如|如果|回顾|复述|举例|讨论|我(?:昨天|之前|以前|上次)说过)/.test(command)) return false;
  if (/(?:只是|仅仅|只是在)(?:回顾|复述|举例|讨论)/.test(original)) return false;
  if (/(发送过什么|发送过哪些|创建过什么|创建过哪些|做过什么|做过哪些|要多久|需要多久|是什么意思|有什么区别|有何区别|有哪些步骤|有什么风险|安全吗|靠谱吗|可行吗|了吗|了么|了没|过吗)[？?。\s]*$/.test(original)) return false;
  // An action mentioned inside a prerequisite/advisability question is still
  // discussion, even when its opening words look like an imperative.
  if (/(?:之前|以前|前)[，,\s]*(?:还)?(?:有什么|有哪些|需要确认什么|需要注意什么|需要哪些|要确认什么|要注意什么)/.test(original)) return false;
  if (/(?:(?:是否|是不是|会不会)(?:更|不|有必要|太)?(?:合适|妥当|合理|可行|安全|可靠|必要|值得)|(?:合适|妥当|合理|必要|值得)(?:吗|么)|(?:好不好|该不该|应不应该|要不要))[？?。\s]*$/.test(original)) return false;
  if (/(?:不要|别|禁止|不必|无需|不想|不需要|不允许|不能|暂不|先不|暂停|停止)\s*(?:再|你|帮我|替我|去|给我|继续|现在|立刻|马上|先)*\s*(?:新建|创建|新开|开个|开一个|启动|让|发送|转交|派发|下达|推进|恢复|继续|这个任务|该任务)/.test(command)) return false;
  if (type === 'create') {
    const create = /^(?:新建|创建|启动|新开|开一个|开个).{0,30}(?:会话|session|任务)/i;
    if (create.test(command)) return true;
    // Spoken requests may give the travel/business background first. Only a
    // direct delegation clause can grant creation; merely discussing a new
    // session does not. The original negation/question checks still apply.
    const clauses = command.split(/[，,。！？?!；;\n]/).map(s => s.trim());
    const delegated = /^(?:对\s*)?(?:你帮我|请你|帮我|请|麻烦你|替我)\s*/;
    if (clauses.some(clause => delegated.test(clause) && create.test(commandText(clause.replace(/^对\s*/, ''))))) return true;
    return /^(?:我)?在想\s*(?:新建|创建|新开|开一个|开个).{0,30}(?:会话|session)/i.test(command)
      && clauses.some(clause => delegated.test(clause)
        && /^(?:通过|用)\s*(?:那个|这个|新(?:的)?)\s*(?:codex\s*)?(?:session|会话)\s*(?:(?:让他|让它)\s*)?(?:帮我\s*)?(?:制作|完成|执行|研究|整理|编写|生成)/i.test(commandText(clause.replace(/^对\s*/, ''))));
  }
  return /^(发送|转交|派发|下达)\s*\S|^让.{1,100}(继续|恢复|开始|执行|完成)|^(继续|恢复|推进)\s*\S|^把.{1,150}(发给|发送给|转交给|派发给)/i.test(command);
}

// A business shorthand is accepted only when the user's target phrase matches
// exactly one known title. The model cannot nominate its own aliases.
function businessTargetPhrase(text) {
  const value = String(text || '');
  const quoted = value.match(/(?:让|推进|继续|恢复|转交给|发给)\s*[「“"《]([^」”"》]{2,100})[」”"》]/);
  if (quoted) return quoted[1].trim();
  const match = value.match(/让\s*(.{2,100}?)\s*(?:这个(?:会话|session)|(?:会话|session))?\s*(?:继续|恢复|开始|执行|完成)/i)
    || value.match(/(?:推进|继续|恢复|转交给|发给)\s*([^，,。！？?!：:\n]{2,100})/i);
  if (!match) return null;
  const phrase = match[1].trim().replace(/^(?:昨天的|之前的|那个|这个)/, '').replace(/(?:这个|的)?(?:业务|项目|会话|session|任务)\s*$/i, '').trim();
  return phrase.length >= 2 ? phrase : null;
}

function requireAuthorizedTarget(current, action, sessions) {
  if (!actionIntent(current.text, action.type)) throw new Error('本轮未明确委托执行此操作；回顾、提问及否定要求只读取');
  if (action.type !== 'send') return;
  return requireBoundTarget(current,action,sessions);
}
function requireBoundTarget(current, action, sessions) {
  const target = sessions.find(s => s.id === action.targetSessionId);
  if (!target) throw new Error('目标会话不存在，请先定位目标');
  // Explicit stable ID removes title ambiguity; a same-name session does not.
  if (String(current.text).includes(target.id)) return;
  const title = String(target.title || target.name || '');
  if (title.length >= 2 && String(current.text).includes(title)) {
    if (sessions.filter(s => String(s.title || s.name || '') === title).length !== 1) throw new Error('存在同名会话，请使用准确会话 ID 指定目标');
    return;
  }
  const reminderPhrase=String(current.text).match(/(?:^|[，,。])\s*(?:请|帮我|关注)?\s*(.{2,100}?)\s*(?:有|一有|出现)(?:新的?)?(?:回复|答复|回答|结果)/)?.[1]?.trim();
  const watchPhrase=String(current.text).trim().match(/^(?:请|帮我)?关注\s*(.{2,100}?)\s*[。！!]?$/)?.[1]?.trim();
  const phrase = businessTargetPhrase(current.text)||reminderPhrase||watchPhrase;
  const candidates = phrase ? sessions.filter(s => String(s.title || s.name || '').toLowerCase().includes(phrase.toLowerCase())) : [];
  if (candidates.length > 1) throw new Error('业务名称匹配多个会话，请明确要推进哪个原会话');
  if (candidates.length !== 1 || candidates[0].id !== target.id) throw new Error('本轮委托未绑定这个目标，请使用明确业务名称、会话标题或 ID');
}

function bindOperation(store, current, operationKey, action) {
  const key = String(operationKey || '');
  if (!key || key.length > 120) throw new Error('缺少有效 operationKey');
  const payload = action.type === 'send'
    ? { type: 'send', targetSessionId: action.targetSessionId, text: action.text }
    : { type: 'create', title: action.title, text: action.text };
  const encoded = JSON.stringify(payload), fingerprint = digest(encoded);
  const intentId = digest(`${current.id}:payload:${encoded}`);
  const bindingKey = `operation:${digest(`${current.id}:key:${key}`)}`;
  const createKey = `create-operation:${digest(String(current.id))}`;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const old = store.get(bindingKey);
    if (old && old.fingerprint !== fingerprint) throw new Error('同一 operationKey 已绑定不同任务内容，未重复派发');
    if (action.type === 'create') {
      const reserved = store.get(createKey);
      if (reserved && reserved.fingerprint !== fingerprint) throw new Error('本轮已有新建任务；首版每轮创建一个会话，新增任务请另发要求');
      if (!reserved) store.set(createKey, { fingerprint, intentId });
    }
    if (!old) store.set(bindingKey, { fingerprint, intentId });
    store.db.exec('COMMIT');
    return old?.intentId || intentId;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
module.exports = { actionIntent, requireAuthorizedTarget,requireBoundTarget, bindOperation, businessTargetPhrase };
