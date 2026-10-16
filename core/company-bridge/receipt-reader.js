'use strict';
// Company receipts preserve every final body of one dispatched request. Other
// consumers still use LiveHistory's unchanged "latest native final" contract.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { JsonlByteScanner } = require('../jsonl-byte-scanner');
const { isToolResultEntry } = require('../claude-transcript-parser');
const { isSyntheticUserEntry, splitHubEnvelopes } = require('../synthetic-user-filter');
const { promptFingerprint, unwrapClaudePasteEnvelope } = require('../prompt-submission-receipts');

const digest = value => createHash('sha256').update(value).digest('hex');
function promptText(text) { return splitHubEnvelopes(unwrapClaudePasteEnvelope(String(text || ''))).text; }
function receiptPromptFingerprint(text) { return promptFingerprint(promptText(text)); }
function bodyText(row) {
  const body = row.message?.content;
  return typeof body === 'string' ? body : Array.isArray(body)
    ? body.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
}
// CodeAgent 粘贴时会读公司电脑的剪贴板，里面有图片就往提问里插「[Image #N]」，再追加一个以
// 「[已分析用户附件图片]」开头的文字块（看图结果或「图片视觉分析失败」）。2026-10-16 公司真机 Q-1016-01：
// 第 4、6 轮是「[Image #0]## 成员追问…」+ 看图块，第 2 轮的改写请求是「[Image #0][Image #1][Image #2]（编号…」
// + 3 个失败块；提问本身一字不差，回执却判成对不上。先比原文，比不上再去掉占位符和看图块比。
const CLIPBOARD_ANALYSIS = '\n[已分析用户附件图片]';
// 2026-10-16 公司真机 Q-1016-05 第 2 轮：答到一半公司 Hub 重启，CodeAgent 恢复会话后自己补了一句「继续」
// （type=user、isUserPrompt、无合成标记），把被打断的那一轮接着做完；这句被当成了新提问，回答随之被算到它名下，
// 本轮报「其他用户输入的答案不会作为本轮回执」。只有续跑字样、没有别的内容的输入，算作当前请求的延续；
// 人在终端里敲「继续」也是同一个意思。带了任何其他内容的输入仍按新提问处理（防串题的原规则不变）。
const BARE_CONTINUE = /^(?:继续|请继续|继续吧|接着做|continue|go on|keep going)[。.!！]?$/i;
function withoutClipboardImages(text) {
  if (!/\[Image #\d+\]/.test(text)) return [];
  const at = text.indexOf(CLIPBOARD_ANALYSIS);
  const bodies = at >= 0 ? [text, text.slice(0, at)] : [text];
  return bodies.flatMap(body => [/\[Image #\d+\]/g, /\[Image #\d+\] ?/g, /\[Image #\d+\]\s*/g].map(re => body.replace(re, '')));
}
function matchesRequest(group, request) {
  if (request.promptFingerprint) {
    if (receiptPromptFingerprint(group.text) === request.promptFingerprint) return true;
    return withoutClipboardImages(String(group.text || '')).some(text => receiptPromptFingerprint(text) === request.promptFingerprint);
  }
  // Upgrade compatibility for an already-dispatched round. New dispatches use
  // exact normalized content, not a task number merely quoted in user prose.
  if (!group.at || group.at < (request.sentAt || 0) - 5000) return false;
  const text = promptText(group.text).trim();
  const numbered = `编号 ${request.threadId}，第 ${request.round} 轮`;
  if (request.rewrite) return text.startsWith(`（${numbered}）你上一条回答里有成段的源码。`);
  const labels = ['成员请求', '成员追问', '家里的问题', '家里的追问'];
  const markers = labels.map(label => `## ${label}（${numbered}）`);
  if (request.round === 1) markers.push(`## 成员请求（编号 ${request.threadId}）`, `## 家里的问题（编号 ${request.threadId}）`);
  return text.split(/\r?\n/).some(line => markers.includes(line.trim()));
}

function readCompanyReceipt(meta, request) {
  const unavailable = issue => ({ available: false, issue, records: [] });
  const identity = meta?.ccSessionId, file = meta?.transcriptPath;
  if (!identity || !file) return unavailable('原生会话身份或绑定记录尚未就绪');
  const groups = [], owners = new Map(), userGroups = new Map(), toolOwners = new Map();
  let current = null, header = null, baselineIndex = request.baseline ? null : -1, lastHuman = null;
  const scanner = new JsonlByteScanner((row, index) => {
    if (row.sessionId && header === null) header = row.sessionId;
    if (row.sessionId !== identity || row.isSidechain) return;
    const parentKnown = row.parentUuid && owners.has(row.parentUuid);
    let owner = parentKnown ? owners.get(row.parentUuid) : current;
    let requestRoot = false;
    const text = bodyText(row);
    if (row.type === 'system' && row.subtype === 'scheduled_task_fire') {
      // A scheduled wakeup is not a continuation of this member request.
      owner = current = null;
    } else if (row.type === 'user' && !isToolResultEntry(row)) {
      const notification = row.origin?.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>');
      if (notification) {
        const toolId = text.match(/<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/)?.[1];
        if (toolId && toolOwners.has(toolId)) owner = toolOwners.get(toolId);
        current = owner;
      } else if (current && BARE_CONTINUE.test(promptText(text).trim())) {
        // 只有「继续」二字的输入是同一件事的延续，不是新提问（见 BARE_CONTINUE）。归属沿父节点或当前请求。
      } else if (!row.turnCompanion && !isSyntheticUserEntry(row, text)) {
        requestRoot = true;
        if (!userGroups.has(row.uuid)) {
          if (lastHuman) { lastHuman.end = index; lastHuman.endInvalid = scanner.getStats().invalidRecords; }
          owner = { userMessageId: row.uuid, text, at: Date.parse(row.timestamp) || null,
            start: index, end: Infinity, startInvalid: scanner.getStats().invalidRecords,
            endInvalid: null, records: new Map(), uncertain: false };
          groups.push(owner);
          if (row.uuid) userGroups.set(row.uuid, owner);
          lastHuman = owner;
        } else owner = userGroups.get(row.uuid);
        current = owner;
      }
    }
    // Omitted parentUuid is supported by existing Claude-format records. A
    // present but unresolved parent is not proof that this body is ours. A
    // real user submission itself starts a new root, even after compaction
    // removed its predecessor; its answer must still resolve to that root.
    if (owner && !requestRoot && parentKnown === false && row.parentUuid) owner.uncertain = true;
    if (row.uuid) owners.set(row.uuid, owner);
    if (row.type !== 'assistant') return;
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block?.type === 'tool_use' && block.id) toolOwners.set(block.id, owner);
    }
    if (row.message?.stop_reason !== 'end_turn' || !text.trim()) return;
    const messageId = row.uuid || row.message.id, turnId = row.message.id || row.uuid;
    const id = digest(JSON.stringify([identity, turnId, text.trim()]));
    if (id === request.baseline && baselineIndex === null) baselineIndex = index;
    if (!owner || index >= owner.end) return;
    if (!messageId) { owner.uncertain = true; return; }
    owner.records.set(messageId, { id, messageId, turnId, text: text.trim(), index });
  });
  let fd, readError;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(65536);
    for (let at = 0; at < size;) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - at), at);
      if (!n) break;
      scanner.push(buffer.subarray(0, n)); at += n;
    }
  } catch (error) { readError = error; }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (error) { readError ||= error; }
    }
  }
  if (readError) return unavailable('原生记录读取失败：' + readError.message);
  const stats = scanner.end({ flushFinal: false });
  if (header !== identity) return unavailable('原生记录身份与公司会话不一致');
  if (baselineIndex === null) return unavailable('未找到本次发送前的答复基线，暂不确认回执归属');
  const candidates = groups.filter(group => group.start > baselineIndex && matchesRequest(group, request));
  if (candidates.length !== 1) return unavailable('未能唯一核对本次请求对应的原生用户输入，请查看公司会话');
  const group = candidates[0];
  if (stats.pendingLineBytes && !Number.isFinite(group.end)) return unavailable('原生记录末行尚未写完整，等待追加后再核对回执');
  // Corruption before this actual request cannot change its ownership. A bad
  // row inside the request may hide a user boundary or answer: never skip it
  // and report a plausible but incomplete success.
  if ((group.endInvalid ?? stats.invalidRecords) > group.startInvalid) return unavailable('本次请求范围内存在损坏记录，暂不确认回执');
  if (!group.userMessageId || group.uncertain) return unavailable('本次请求的原生消息归属不完整，暂不确认回执');
  const records = [...group.records.values()].filter(record => record.index > baselineIndex && record.index < group.end);
  if (!records.length) return unavailable('本次请求尚未读到最终正文；其他用户输入的答案不会作为本轮回执');
  return { available: true, userMessageId: group.userMessageId, records,
    text: records.map(record => record.text).join('\n\n') };
}

// 提问有没有真的写进 CodeAgent 的记录（2026-10-16 公司真机 Q-1016-02 第 5 轮：发给了一个已经退出的 CodeAgent，
// 提问根本没写进去，以前只在「记录文件不存在」时才重发，干等 30 分钟判失败）。
// 搜同一项目目录里发送之后改过的全部 .jsonl：CLI 恢复后可能换了记录文件，不能只看绑定的那一个。
// 返回 true（找到）/ false（目录在、没找到）/ null（不知道记录在哪，不下结论）。
function transcriptHasRequest(meta, request, fsModule = fs) {
  const bound = meta?.transcriptPath;
  if (!bound || !request?.sentAt) return null;
  const dir = require('node:path').dirname(bound);
  let names;
  try { names = fsModule.readdirSync(dir).filter(name => name.endsWith('.jsonl')); } catch { return null; }
  const since = request.sentAt - 5000;
  for (const name of names) {
    const file = require('node:path').join(dir, name);
    try { if (fsModule.statSync(file).mtimeMs < since) continue; } catch { continue; }
    let raw;
    try { raw = fsModule.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.includes('"user"')) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== 'user' || isToolResultEntry(row)) continue;
      const at = Date.parse(row.timestamp) || 0;
      if (at && at < since) continue;
      if (matchesRequest({ text: bodyText(row), at }, request)) return true;
    }
  }
  return false;
}

module.exports = { readCompanyReceipt, receiptPromptFingerprint, transcriptHasRequest };
