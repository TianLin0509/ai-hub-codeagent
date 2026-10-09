'use strict';
// Read model only. Never dispatches, changes task files, or treats prose as a verdict.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./dev-file-workflow');
const LIMIT = 1024 * 1024;
const phases = Object.freeze({ discussion: '讨论中', implementing: '实现中', reviewing: '审核中', waiting: '等待接续', paused: '已暂停', completed: '已报告完成', stopped: '已停止' });
function parseRecord(text, taskId) {
  const blocks = [...text.matchAll(/^```hub-task-view\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (!blocks.length) return null;
  if (blocks.length !== 1) throw new Error('任务摘要只能有一个 hub-task-view 块');
  const d = JSON.parse(blocks[0][1]);
  if (!d || d.schema !== 'hub.task-view.v1' || d.taskId !== taskId || !Number.isSafeInteger(d.revision) || d.revision < 1 || !Object.hasOwn(phases, d.phase)) throw new Error('任务摘要版本、身份、修订号或阶段无效');
  if (typeof d.summary !== 'string' || !d.summary.trim() || d.summary.length > 600) throw new Error('任务摘要须为 1–600 字');
  if (d.title != null && (typeof d.title !== 'string' || d.title.length > 240)) throw new Error('任务标题无效');
  if (d.decision != null && (!d.decision || typeof d.decision.id !== 'string' || !d.decision.id || d.decision.id.length > 128 || typeof d.decision.text !== 'string' || !d.decision.text.trim() || d.decision.text.length > 600 || d.decision.recipient !== 'user' || typeof d.decision.resolved !== 'boolean')) throw new Error('待决事项格式无效');
  if (d.evidence != null && (!Array.isArray(d.evidence) || d.evidence.length > 12 || d.evidence.some(e => !e || typeof e.ref !== 'string' || !e.ref || e.ref.length > 2048 || typeof e.kind !== 'string'))) throw new Error('证据清单格式无效');
  if (d.merge != null && (!d.merge || !/^[a-f0-9]{40}$/.test(d.merge.candidate) || !/^[a-f0-9]{40}$/.test(d.merge.commit) || !/^refs\/(?:heads|remotes)\/[A-Za-z0-9_./-]+$/.test(d.merge.target) || d.merge.target.includes('..'))) throw new Error('合并记录须包含完整 SHA 与目标 ref');
  return { schema: d.schema, taskId, revision: d.revision, phase: d.phase, summary: d.summary.trim(), title: d.title || '', decision: d.decision || null, evidence: d.evidence || [], merge: d.merge || null };
}
function inside(root, file) { const rel = path.relative(root, file); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
async function safeFile(root, file) {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (!inside(realRoot, realFile)) throw new Error('文件路径越出任务目录');
  return realFile;
}
async function readText(root, file) {
  const real = await safeFile(root, file), before = await fs.stat(real);
  if (!before.isFile() || before.size > LIMIT) throw new Error('记录不是普通文件或超过 1 MB');
  const bytes = await fs.readFile(real), after = await fs.stat(real);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || bytes.length > LIMIT) throw new Error('记录正在写入，等待稳定版本');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { text, at: after.mtimeMs, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function readTask(dataDir, meeting) {
  const dir = F.directory(dataDir, meeting.id), taskId = meeting.serialWorkflow?.taskViewId || meeting.id;
  let names = [];
  try {
    await safeFile(path.join(dataDir, 'task-docs'), dir);
    names = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const solo = F.isSolo(meeting), file = solo ? null : F.fromNames(names);
  if (file?.error) throw new Error(file.error);
  // Only the current stage owns its narrative. No carryover from an older round.
  const current = solo ? '任务记录.md' : file.done ? file.completed : names.includes(file.draft) ? file.draft : null;
  let raw = null;
  if (current && names.includes(current)) raw = await readText(dir, path.join(dir, current));
  const record = raw ? parseRecord(raw.text, taskId) : null;
  const afterNames = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  if (!solo && JSON.stringify(F.fromNames(afterNames)) !== JSON.stringify(file)) throw new Error('阶段文件正在变化，等待稳定快照');
  let mergeVerified = false, mergeError = '';
  if (record?.merge && record.phase === 'completed' && meeting.workspace) {
    try {
      mergeVerified = await require('./git-merge-verification').verifyMerge(meeting.workspace, record.merge);
    } catch { mergeError = '尚未核对到候选进入目标分支；保留文档报告，不宣称已合并'; }
  }
  return { taskId, record, file, name: current || '', at: raw?.at || 0, hash: raw?.hash || '', mergeVerified, mergeError, checkedAt: Date.now() };
}
function projectFileRow(meeting, cached, runtime, fileRuntime) {
  const solo = F.isSolo(meeting), d = cached?.value, record = d?.record, file = d?.file;
  const error = cached?.error || '', paused = !!fileRuntime?.paused;
  let phase = solo ? record?.phase || 'unknown' : file?.done ? 'completed' : ({ discuss: 'discussion', kickoff: 'discussion', build: 'implementing', merge: 'reviewing' }[file?.phase] || 'unknown');
  const basis = solo ? record ? '任务记录报告的阶段' : '尚无有效任务摘要' : file ? file.done ? '完整交接文件链已完成' : file.label : '正在核对任务文件';
  let label = phases[phase] || '进度未记录';
  if (!solo && file?.done) label = '文件流程已完成';
  if (d?.mergeVerified) label = '已合并';
  const decision = record?.decision && !record.decision.resolved ? record.decision : null;
  if (decision) label = '等你决定';
  if (paused && phase !== 'completed') { phase = 'paused'; label = '已暂停'; }
  const scope = ['completed', 'stopped'].includes(phase) ? 'history' : phase === 'discussion' ? 'discuss' : 'current';
  const notice = error || fileRuntime?.dispatchError || d?.mergeError || '';
  const tone = error ? 'bad' : decision ? 'warn' : phase === 'completed' ? 'ok' : ['implementing', 'reviewing'].includes(phase) ? 'run' : 'idle';
  return { taskId: d?.taskId || meeting.id, scope, phase, basis, title: record?.title || meeting.title,
    progress: record?.summary || (solo ? '尚无可核对的任务进度，展开可查看现有记录。' : file?.done ? '交接文件链已完成，合并结果以核对证据为准。' : file?.label || '正在读取任务文件…'),
    stage: { key: phase, label, tone, running: ['running', 'starting'].includes(runtime.state) },
    attention: decision ? { kind: 'user-decision', label: '等你决定', text: decision.text, id: decision.id } : null,
    runtime, quality: error ? d ? 'stale' : 'unavailable' : cached ? 'fresh' : 'loading', notice,
    source: { name: d?.name || '', at: d?.at || 0, hash: d?.hash || '', revision: record?.revision || 0, checkedAt: d?.checkedAt || 0 },
    evidence: record?.evidence || [], merge: record?.merge || null, mergeVerified: !!d?.mergeVerified,
    outcome: d?.mergeVerified ? '已核对候选与合并提交在目标分支中的可达性；当前运行实例尚未核对。' : phase === 'completed' ? '这是文档交付结果；未核对的合并、自测与独立审查不能互相替代。' : '',
    mode: solo ? '单 Agent' : '文件协作', activityAt: d?.at || meeting.createdAt || 0, actions: {},
  };
}
function recordInstruction(meeting) {
  return '工作台只读摘要：在当前任务文档保留唯一的 ```hub-task-view 代码块（内为 JSON），正文仍用自然语言。只在事实变化时增加 revision，不以文件创建或一次回复结束宣告开工/完成，不用摘要触发派工。格式：' + JSON.stringify({ schema:'hub.task-view.v1', taskId:meeting.serialWorkflow?.taskViewId || meeting.id, revision:1, phase:'discussion', summary:'实际进展一句话', decision:null, evidence:[] }) + '。phase 仅可为 discussion/implementing/reviewing/waiting/paused/completed/stopped；普通讨论必须为 discussion。待用户决定时 decision={id,text,recipient:"user",resolved:false}，收到明确答案才 resolved:true。验证证据 evidence=[{kind:"test",ref:"相对项目或任务目录的报告路径"}]；只记真实证据。完成若涉及 Git 合并，可附 merge={candidate:"完整40位SHA",commit:"完整40位合并SHA",target:"refs/heads/master"}，工作台另行核对，不能将自测写成独立审查。先读已有 revision，不得回退；UTF-8 写同目录临时文件并原子替换。一个群聊对应一个任务，新增无关任务另建群聊，避免复用旧交付证据。';
}
module.exports = { parseRecord, readTask, readText, safeFile, inside, projectFileRow, recordInstruction };
