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
// 2026-10-18 v2.1.9 发布验收（D:\Temp\hub-restart-resume-03pDZw）：机器负载重，第一次发送粘贴进了 CodeAgent 输入框、
// 回车没生效；3 分钟后通道判「没送达」重发，又粘贴一遍，一个回车把两份一起提交——原生记录里是一条用户消息、正文是
// 同一段提问连写两遍（中间隔一个空行）。它确实是本轮的提问，只是重复了。整条由同一段文字重复 N 遍组成时，取出那一段再比。
function repeatedCopy(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').trim();
  const head = s.slice(0, 40);
  if (!head) return null;
  for (let at = s.indexOf(head, 1); at > 0; at = s.indexOf(head, at + 1)) {
    const copy = s.slice(0, at).trim();
    if (!copy) continue;
    let rest = s.slice(at), n = 1;
    while (rest.startsWith(copy)) { rest = rest.slice(copy.length).trimStart(); n += 1; }
    if (!rest && n > 1) return copy;
  }
  return null;
}
// 一条用户输入可能对应的提问指纹：原文；去掉剪贴板图片占位符与看图块；以及其中「同一段连写多遍」的单份。
function requestFingerprints(raw) {
  const out = new Set();
  for (const variant of [raw, ...withoutClipboardImages(raw)]) {
    const text = promptText(variant);
    out.add(promptFingerprint(text));
    for (const copy of [repeatedCopy(text), repeatedCopy(variant)]) if (copy) out.add(promptFingerprint(promptText(copy)));
  }
  return out;
}
function matchesRequest(group, request) {
  if (request.promptFingerprint) return requestFingerprints(String(group.text || '')).has(request.promptFingerprint);
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
            endInvalid: null, records: new Map(), parts: new Map(), uncertain: false };
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
    if (!text.trim()) return;
    // 2026-10-21 同事公司 Hub（2 轮「回执只收到后半段」）：以前只收 end_turn 的正文，CodeAgent 在工具调用之前写的结论
    // （stop_reason=tool_use / null 的文字块）全丢了。这里把本轮所有带文字的 assistant 块按顺序记下，
    // 拼回执时取到最后一段最终正文为止（之后还没收尾的过程文字不算，见下方 parts 过滤）。
    if (row.message?.stop_reason !== 'end_turn') {
      if (owner && index < owner.end) {
        const key = row.uuid || (row.message?.id ? row.message.id + ':' + digest(text.trim()) : null);
        if (key && !owner.parts.has(key)) owner.parts.set(key, { text: text.trim(), index, final: false });
      }
      return;
    }
    const messageId = row.uuid || row.message.id, turnId = row.message.id || row.uuid;
    const id = digest(JSON.stringify([identity, turnId, text.trim()]));
    if (id === request.baseline && baselineIndex === null) baselineIndex = index;
    if (!owner || index >= owner.end) return;
    if (!messageId) { owner.uncertain = true; return; }
    owner.records.set(messageId, { id, messageId, turnId, text: text.trim(), index });
    if (!owner.parts.has(messageId)) owner.parts.set(messageId, { text: text.trim(), index, final: true });
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
  if (!candidates.length) return unavailable('未能唯一核对本次请求对应的原生用户输入，请查看公司会话');
  // 同一轮的提问在记录里出现了不止一次（通道补发、人在终端里重发了同一段）：都是这一个请求，不再判「不唯一」。
  // 归属看最后一份：取最后一段首尾相连的重复（中间没有别的真实输入）里、最靠后且已有最终正文的那一份；
  // 都还没有正文就按最后一份等。更早、被别的输入隔开的那几份不算，防串题的原规则不变。
  const run = [candidates[candidates.length - 1]];
  for (let i = groups.indexOf(run[0]) - 1; i >= 0 && candidates.includes(groups[i]); i -= 1) run.unshift(groups[i]);
  const answeredIn = g => [...g.records.values()].some(record => record.index > baselineIndex && record.index < g.end);
  const group = [...run].reverse().find(answeredIn) || run[run.length - 1];
  if (stats.pendingLineBytes && !Number.isFinite(group.end)) return unavailable('原生记录末行尚未写完整，等待追加后再核对回执');
  // Corruption before this actual request cannot change its ownership. A bad
  // row inside the request may hide a user boundary or answer: never skip it
  // and report a plausible but incomplete success.
  if ((group.endInvalid ?? stats.invalidRecords) > group.startInvalid) return unavailable('本次请求范围内存在损坏记录，暂不确认回执');
  if (!group.userMessageId || group.uncertain) return unavailable('本次请求的原生消息归属不完整，暂不确认回执');
  const records = [...group.records.values()].filter(record => record.index > baselineIndex && record.index < group.end);
  if (!records.length) return unavailable('本次请求尚未读到最终正文；其他用户输入的答案不会作为本轮回执');
  const lastFinal = Math.max(...records.map(record => record.index));
  const parts = [...group.parts.values()].filter(p => p.index > baselineIndex && p.index <= lastFinal).sort((a, b) => a.index - b.index)
    .map(p => ({ text: p.text, final: p.final }));
  return { available: true, userMessageId: group.userMessageId, records, parts,
    text: parts.map(p => p.text).join('\n\n') };
}

// —— 按问题文本找回答（2026-10-21 同事公司 Hub：「会话停下了，但一直没读到回答」「答完 20 分钟没送回」、重启后补收 0/5）——
// 上面的 readCompanyReceipt 只读会话绑定的那一个记录文件，且要求记录头身份 = 绑定的原生 id。两种情况会读不到：
//   1) 会话身份一直没绑定（CodeAgent 不认 --session-id，靠第一个 hook 上报绑定；hook 没到或被判成外来，transcriptPath 一直为空）；
//   2) 休眠后 --resume 拉起的 CLI 换了原生 id / 记录文件（core/claude-identity-switch.js 只在 30 秒内、或本进程见过旧会话
//      SessionEnd 时才改绑；隔了几分钟的休眠唤醒和 Hub 重启后都不改绑，新 id 的 hook 全被当成外来会话丢弃）。
// 这里不依赖绑定和内存状态：在「号的配置目录\projects\<工作目录 slug>」（以及绑定记录所在目录）里，
// 找发送之后改过的 .jsonl，按这一轮发出的问题（指纹或编号标记，同 matchesRequest）定位，取它之后的全部 assistant 文字。
function projectSlugOf(cwd) { return require('node:path').resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-'); }
function transcriptDirs(meta, fsModule = fs) {
  const path = require('node:path');
  const dirs = [];
  if (meta?.transcriptPath) dirs.push(path.dirname(meta.transcriptPath));
  const configDir = meta?.codeagentConfigDir;
  if (configDir && meta?.cwd) {
    const forms = [path.resolve(String(meta.cwd))];
    try { const real = fsModule.realpathSync.native ? fsModule.realpathSync.native(forms[0]) : fsModule.realpathSync(forms[0]); if (real && real.toLowerCase() !== forms[0].toLowerCase()) forms.push(real); } catch { /* 目录不在了：只按原写法 */ }
    for (const form of forms) dirs.push(path.join(configDir, 'projects', projectSlugOf(form)));
  }
  const seen = new Set();
  return dirs.filter(d => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
const MAX_SCAN_FILES = 12;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
function candidateTranscripts(meta, since, fsModule = fs) {
  const path = require('node:path');
  const out = [];
  for (const dir of transcriptDirs(meta, fsModule)) {
    let names; try { names = fsModule.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let st; try { st = fsModule.statSync(file); } catch { continue; }
      if (st.mtimeMs < since || st.size > MAX_SCAN_BYTES) continue;
      if (!out.some(x => x.file.toLowerCase() === file.toLowerCase())) out.push({ file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SCAN_FILES);
}
// 一个记录文件里这一轮的问题和它之后的回答。返回最后一次出现的这一轮问题（同一段落进多次时取最后一份）。
function scanFileForRound(file, request, since, fsModule = fs) {
  let raw; try { raw = fsModule.readFileSync(file, 'utf8'); } catch { return null; }
  let hit = null, cur = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.isSidechain) continue;
    if (row.type === 'user') {
      if (isToolResultEntry(row)) { if (cur) cur.finished = false; continue; }
      const text = bodyText(row);
      const at = Date.parse(row.timestamp) || 0;
      if ((!at || at >= since) && !row.turnCompanion && matchesRequest({ text, at }, request)) {
        cur = { file, at, userMessageId: row.uuid || null, nativeId: row.sessionId || null, parts: new Map(), finished: false };
        hit = cur; continue;
      }
      if (!cur) continue;
      // 续跑的「继续」、后台通知、压缩摘要、斜杠命令回显：还是这一轮；别的真实输入划开边界。
      if (BARE_CONTINUE.test(promptText(text).trim()) || row.origin?.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')) { cur.finished = false; continue; }
      if (isSyntheticUserEntry(row, text) || /^<(?:local-command-|command-name>)/.test(text.trimStart())) continue;
      cur = null; continue;
    }
    if (!cur) continue;
    if (row.type === 'system' && row.subtype === 'scheduled_task_fire') { cur = null; continue; }
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') { cur.finished = false; continue; }
    if (row.type !== 'assistant') continue;
    const text = bodyText(row).trim();
    const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
    const final = row.message?.stop_reason === 'end_turn';
    if (text) {
      const key = row.uuid || (row.message?.id || '') + ':' + digest(text);
      if (!cur.parts.has(key)) cur.parts.set(key, { text, final });
    }
    if (final && text) cur.finished = true;
    else if (blocks.some(b => b?.type === 'tool_use') || !final) cur.finished = false;
  }
  return hit;
}
// meta：会话元数据（transcriptPath / codeagentConfigDir / cwd 任有其一）；request：这一轮（promptFingerprint 或 threadId+round+sentAt）。
// 返回 null（找不到这一轮的问题）或 { file, mtime, at, finished, parts:[{text, final}], text }。
// finished：问题之后最后一条是带正文的 end_turn（没再调工具、没再等输入）；text 取到最后一段最终正文为止，没收尾时是已写的全部文字。
function findRoundAnswer(meta, request, { fsModule = fs } = {}) {
  const first = Math.min(...[request?.sentAt, request?.firstSentAt].filter(Number.isFinite));
  const since = (Number.isFinite(first) ? first : 0) - 5000;
  let best = null;
  for (const c of candidateTranscripts(meta, since, fsModule)) {
    const hit = scanFileForRound(c.file, request, since, fsModule);
    if (!hit) continue;
    const parts = [...hit.parts.values()];
    const cand = { file: c.file, mtime: c.mtime, at: hit.at, finished: hit.finished, userMessageId: hit.userMessageId, nativeId: hit.nativeId, parts };
    // 恢复会话的新记录会带着旧记录的历史（同一条提问、同一时间戳）：同一时刻的提问取答完的、写得多的、较新的那份。
    const better = !best || cand.at > best.at || (cand.at === best.at && (cand.finished !== best.finished ? cand.finished
      : cand.parts.length !== best.parts.length ? cand.parts.length > best.parts.length : cand.mtime > best.mtime));
    if (better) best = cand;
  }
  if (!best) return null;
  let parts = best.parts;
  if (best.finished) { let last = -1; parts.forEach((p, i) => { if (p.final) last = i; }); parts = parts.slice(0, last + 1); }
  return { ...best, parts, text: parts.map(p => p.text).join('\n\n') };
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
  // 从第一次发出算起：重发前先核对时，第一次发出后才慢慢落进记录的那一份也算送到了（不必再发第二遍）。
  const since = Math.min(request.sentAt, request.firstSentAt || request.sentAt) - 5000;
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

// 会话的上一轮是不是已经答完（hub-admin.js 重启后恢复本机会话前用）：最后一条有效记录是带正文的 end_turn 回答。
// 之后又有工具调用 / 工具结果、真实提问、「继续」、被打断的占位、后台通知或排队中的输入，都算没答完。
// 斜杠命令回显、压缩摘要、附件、系统行不改变判断。返回 true / false / null（读不到记录，不下结论）。
function transcriptTurnFinished(meta, fsModule = fs) {
  const file = meta?.transcriptPath;
  if (!file) return null;
  let raw;
  try { raw = fsModule.readFileSync(file, 'utf8'); } catch { return null; }
  let finished = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.isSidechain) continue;
    if (meta.ccSessionId && row.sessionId && row.sessionId !== meta.ccSessionId) continue;
    if (row.type === 'assistant') {
      finished = row.message?.stop_reason === 'end_turn' && !!bodyText(row).trim();
    } else if (row.type === 'user') {
      if (isToolResultEntry(row)) { finished = false; continue; }
      const text = bodyText(row).trimStart();
      if (row.isCompactSummary || /^<(?:local-command-|command-name>)/.test(text)) continue;
      finished = false;
    } else if (row.type === 'attachment' && row.attachment?.type === 'queued_command') finished = false;
  }
  return finished;
}

module.exports = { readCompanyReceipt, receiptPromptFingerprint, transcriptHasRequest, transcriptTurnFinished, findRoundAnswer, candidateTranscripts, transcriptDirs, BARE_CONTINUE };
