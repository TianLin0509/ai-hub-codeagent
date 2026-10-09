'use strict';
// Group chat answers come from Markdown files, not from CLI transcripts
// (2026-09-30). Each member writes what it wants the group to see; the Hub
// reads the file whenever it changes — before or after an interruption, and
// whether or not the Hub dispatched that turn. Card states: content or none.
//
// Plain group chats: <data>/task-docs/<meetingId>/answers/turn-<n>/<memberId>/回答.md
// Delivery workflow turns reuse that step's delivery files (draft shown as 草稿).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const RECENT_TURNS = 30;
const SAFE = /^[a-zA-Z0-9_-]{1,255}$/;

// Legacy engines still extract answers from transcripts until their rooms migrate.
function legacyWorkflow(w) {
  if (!w || w.deliveryVersion === 1 || w.conversationVersion === 1) return false;
  return w.fileFlowVersion === 2 || !!w.loop?.enabled || (!!w.enabled && (w.settingsVersion === 1 || (Array.isArray(w.steps) && w.steps.length > 0)));
}
// answerSource:'transcript' is a per-room escape hatch (not in the UI) and keeps
// the extraction machinery testable.
function enabled(meeting) { return !!meeting?.groupChat && meeting.answerSource !== 'transcript' && !legacyWorkflow(meeting.serialWorkflow); }

function plainEntry(dataDir, meetingId, turnNum, memberId) {
  if (!SAFE.test(String(meetingId)) || !SAFE.test(String(memberId)) || !Number.isSafeInteger(Number(turnNum))) throw new Error('回答文件路径身份无效');
  const dir = path.join(dataDir, 'task-docs', String(meetingId), 'answers', `turn-${Number(turnNum)}`, String(memberId));
  return { kind: 'plain', dir, ready: path.join(dir, '回答.md') };
}
function deliveryEntry(dataDir, meetingId, workflowRun, memberId) {
  const D = require('./delivery-workflow');
  const base = D.directory(dataDir, meetingId);
  const run = JSON.parse(fs.readFileSync(path.join(base, 'run.json'), 'utf8'));
  const step = run.id === workflowRun.runId ? run.steps[workflowRun.stepIndex] : null;
  if (!step) throw new Error('交付步骤不存在');
  const p = D.paths(base, run, step, memberId);
  return { kind: 'delivery', dir: p.dir, draft: p.draft, ready: p.ready, rework: p.rework, blocked: p.blocked };
}
/** The answer file(s) for one member in one dispatched turn. */
function entryFor({ dataDir, meetingId, turnNum, memberId, speaker, workflowRun }) {
  const base = workflowRun?.kind === 'delivery' ? deliveryEntry(dataDir, meetingId, workflowRun, memberId) : plainEntry(dataDir, meetingId, turnNum, memberId);
  return { ...base, memberId, speaker: speaker || memberId, at: Date.now() };
}
function instruction(entry) {
  if (entry.kind !== 'plain') return '';
  return `【本轮回答】把要发到群聊的完整回答写入 ${entry.ready}（UTF-8 Markdown），写完回读确认。群聊卡片只显示这个文件，所以只写最终回答，不要先写「正在查阅」之类的进度；之后要补充或更正，直接修改它。聊天里一句话说明已写好即可，不必重复全文。`;
}

function readText(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return '';
    // Drop BOM and the delivery ticket line; they are protocol, not content.
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^<!-- hub-delivery:[0-9a-f]+ -->\r?\n/, '').trim();
  } catch { return ''; }
}
/** Current answer: { state: 'delivered'|'draft', outcome, text, hash } or null. */
function read(entry) {
  for (const [key, outcome] of [['ready', 'ready'], ['rework', 'rework'], ['blocked', 'blocked']]) {
    const text = entry[key] ? readText(entry[key]) : '';
    if (text) return { state: 'delivered', outcome, text, hash: crypto.createHash('sha256').update(text).digest('hex') };
  }
  const draft = entry.draft ? readText(entry.draft) : '';
  return draft ? { state: 'draft', outcome: null, text: draft, hash: crypto.createHash('sha256').update(draft).digest('hex') } : null;
}
function signature(entry) {
  return ['ready', 'rework', 'blocked', 'draft'].map(k => {
    if (!entry[k]) return '-';
    try { const st = fs.statSync(entry[k]); return `${st.size}:${st.mtimeMs}`; } catch { return '0'; }
  }).join('|');
}
// Accepted workflow files are pinned inputs. Do not replace their card with a
// later, unaccepted edit (the workflow reports that conflict separately).
// Derive identity from the stable path so registrations saved by older Hubs
// get the same protection. Completed runs are archived before the next run.
function acceptedDelivery(entry, readJson) {
  if (entry.kind !== 'delivery') return null;
  const stepDir = path.dirname(entry.dir), runDir = path.dirname(stepDir), base = path.dirname(runDir);
  const runId = path.basename(runDir), number = Number(path.basename(stepDir).replace(/^step-/, ''));
  const current = readJson(path.join(base, 'run.json'));
  const run = current.id === runId ? current : readJson(path.join(runDir, '已结束运行.json'));
  const step = run.steps.find(s => s.number === number), member = entry.memberId || path.basename(entry.dir);
  const accepted = step?.deliveries?.[member];
  if (!accepted || accepted.outcome === 'skipped') return accepted || null;
  const found = require('./delivery-workflow').readDelivery(base, run, step, member);
  if (!found || found.hash !== accepted.hash || found.outcome !== accepted.outcome || found.path !== accepted.path) throw new Error('已接纳的交付已变化');
  return accepted;
}
/** Applies changed answer files of recent turns to the orchestrator. Returns true if anything changed. */
function reconcile(orch,{changedPaths=null}={}) {
  const byTurn = orch.state.answerFiles;
  if (!byTurn) return false;
  let changed = false;
  // One consistent metadata snapshot per pass, shared by all member cards.
  // Keep it local: the next event/sweep must observe external acceptance and
  // archived-run changes. Failed reads are never memoized. Each accepted
  // delivery still passes its existing path/content/hash verification.
  const runFiles = new Map();
  const readJson = file => {
    if (!runFiles.has(file)) runFiles.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
    return runFiles.get(file);
  };
  const normalize=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  const changedFiles=changedPaths?.length?new Set(changedPaths.map(normalize)):null;
  const affectsPlainEntry=entry=>!changedFiles||['ready','rework','blocked','draft'].some(key=>entry[key]&&[...changedFiles].some(file=>{
    const target=normalize(entry[key]);return target===file||target.startsWith(file+path.sep);
  }));
  const turns = Object.keys(byTurn).map(Number).sort((a, b) => b - a).slice(0, RECENT_TURNS);
  for (const turnNum of turns) {
    for (const [sid, entry] of Object.entries(byTurn[turnNum] || {})) {
      // File notifications check only matching plain answers. Workflow
      // metadata may affect acceptance, so delivery entries keep a full check.
      // The periodic/open-room reconciliation also always checks every entry.
      if(entry.kind==='plain'&&!affectsPlainEntry(entry))continue;
      try {
        const accepted = acceptedDelivery(entry, readJson);
        if (accepted?.outcome === 'skipped') continue;
      } catch { continue; } // Retry on the next scan; never cache a failed read.
      // Skip unchanged files cheaply: size + mtime of every candidate path.
      const sig = signature(entry);
      if (sig === entry.sig) continue;
      const got = read(entry);
      if (got && orch.applyAnswerFile(turnNum, sid, got)) changed = true;
      else if (!got && entry.hash && orch.applyAnswerFile(turnNum, sid, { state: 'missing', outcome: null, text: '', hash: null })) changed = true;
      entry.sig = sig;
    }
  }
  return changed;
}

module.exports = { enabled, legacyWorkflow, entryFor, instruction, read, reconcile, RECENT_TURNS };
