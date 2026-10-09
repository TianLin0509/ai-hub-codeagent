'use strict';

const { isUsableCodexRolloutPath, readCodexRolloutMeta } = require('../../core/codex-transcript-parser.js');
const { isKimiCliKind: defaultIsKimiCliKind } = require('../../core/ai-kinds.js');
const { parseKimiWireToTurns: defaultParseKimiWireToTurns } = require('../../core/kimi-transcript-parser.js');
const { isFreshSession, isUnsubmittedBranch } = require('../../core/session-history-state');
const {
  MAX_BRANCH_DEPTH,
  applyTailLimit,
  mergeInheritedTurns,
  resolveForkTimestamp,
} = require('../../core/branch-transcript-inheritance.js');
const { compactTurnsToolOutputs } = require('../../core/transcript-tool-compact.js');
const { readToolResultFromTranscriptFile } = require('../../core/claude-tool-details.js');

// 增量刷新（turn-complete 回填）用 limit:1 只取最新一条回答，合并前置历史后再切尾
// 结果完全一样，白搭一次父 transcript 解析。除此之外的窗口都照常继承。
const BRANCH_INHERITANCE_MIN_LIMIT = 2;

function defaultDefer() {
  return new Promise(resolve => setImmediate(resolve));
}

async function runTranscriptParser(deps, kind, transcriptPath, parseOpts, fallbackParser) {
  if (parseOpts && parseOpts.compactToolOutputs) rememberCompactedTranscript(transcriptPath);
  if (deps.transcriptParserService && typeof deps.transcriptParserService.parse === 'function') {
    return deps.transcriptParserService.parse(kind, transcriptPath, parseOpts);
  }
  const turns = await fallbackParser(transcriptPath, parseOpts);
  const list = Array.isArray(turns) ? turns : [];
  return { turns: parseOpts && parseOpts.compactToolOutputs ? compactTurnsToolOutputs(list, { transcriptPath }) : list, meta: {} };
}

// Only transcripts this process has itself served as compacted card history
// can be read back through `claude-transcript:tool-result`; the window cannot
// name an arbitrary file.
const COMPACTED_TRANSCRIPTS_MAX = 2000;
const compactedTranscripts = new Set();
function transcriptKey(file) {
  return require('path').resolve(String(file || '')).toLowerCase();
}
function rememberCompactedTranscript(file) {
  if (!file) return;
  const key = transcriptKey(file);
  compactedTranscripts.delete(key);
  compactedTranscripts.add(key);
  if (compactedTranscripts.size > COMPACTED_TRANSCRIPTS_MAX) compactedTranscripts.delete(compactedTranscripts.values().next().value);
}

async function readCompactedToolResult(reference = {}) {
  const file = reference && reference.transcriptPath;
  const itemId = reference && typeof reference.itemId === 'string' ? reference.itemId : '';
  if (!file || !itemId || !compactedTranscripts.has(transcriptKey(file))) {
    throw new Error('未找到完整工具来源，请重新载入会话');
  }
  const full = await readToolResultFromTranscriptFile(file, itemId);
  if (full == null) throw new Error('Claude 原生记录中已找不到这段工具输出的全文');
  return full;
}

// 分支会话的祖先记录既可能是活会话，也可能只剩落盘记录（休眠 / Hub 重启后）。
function lookupSessionRecord(sessionId, deps) {
  const id = String(sessionId || '');
  if (!id) return null;
  const live = deps.sessionManager && typeof deps.sessionManager.getSession === 'function'
    ? deps.sessionManager.getSession(id)
    : null;
  if (live) return { record: live, live: true };
  const persisted = typeof deps.getPersistedSessions === 'function' ? deps.getPersistedSessions() : [];
  const found = (Array.isArray(persisted) ? persisted : []).find(item => item && item.hubId === id);
  return found ? { record: found, live: false } : null;
}

// Codex 的 rollout 头里写着 fork 时刻（session_meta.timestamp），比任何推断都准。
function codexProviderForkAt(session, transcriptPath) {
  if (!transcriptPath || !session || !session.codexSid) return 0;
  try {
    const meta = readCodexRolloutMeta(transcriptPath);
    if (!meta || !meta.forked_from_id) return 0;
    const at = Date.parse(meta.timestamp || '');
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * 给分支会话补上分支之前的对话。
 *
 * 为什么必须补：`codex fork <sid>` 的新 rollout **一条父历史都不写**（2026-08-28 对
 * 4 个真实 fork 文件实测：首个 task_started 之前的 response_item/message 全是 0 条），
 * 于是卡片视图从分支那一刻开始，之前的内容彻底看不到。Claude 的 `--fork-session`
 * 会整份复制，跑同一条路径也安全 —— 签名去重会把重复的部分全滤掉。
 */
async function withInheritedBranchTurns(args, deps, liveSession, childTurns, parseOpts, transcriptPath) {
  const depth = Number(args && args.__branchDepth) || 0;
  if (depth >= MAX_BRANCH_DEPTH) return childTurns;
  const limit = Number(parseOpts && parseOpts.limit);
  if (Number.isFinite(limit) && limit < BRANCH_INHERITANCE_MIN_LIMIT && !parseOpts?.includeBranchHistory) return childTurns;

  // 休眠 / Hub 重启后的分支会话拿不到活对象，branchSourceSessionId 只在落盘记录里。
  const session = liveSession
    || (args && args.hubSessionId ? (lookupSessionRecord(args.hubSessionId, deps) || {}).record : null);
  const parentId = session && session.branchSourceSessionId;
  if (!parentId) return childTurns;

  const parent = lookupSessionRecord(parentId, deps);
  if (!parent) return childTurns;

  const parentResult = await parseSessionTranscript({
    // hubSessionId 一定要带上：祖先自己也可能是分支，而它若已休眠，
    // branchSourceSessionId 只能靠这个 id 从落盘记录里查回来，否则多级分支链
    // 只继承得到一层。祖先不活时 parseSessionTranscript 会自动落到下面这几个
    // 显式字段上（Codex 侧此时只校验「是不是一份可用的顶层 rollout」）。
    hubSessionId: parentId,
    ccSessionId: parent.record.ccSessionId || null,
    transcriptPath: parent.record.transcriptPath || null,
    kind: parent.record.kind || null,
    opts: { ...parseOpts, fromTail: true },
    __branchDepth: depth + 1,
  }, deps);

  const parentTurns = parentResult && Array.isArray(parentResult.turns) ? parentResult.turns : [];
  if (!parentTurns.length) return childTurns;

  const forkAt = resolveForkTimestamp({
    session,
    childTurns,
    providerForkAt: codexProviderForkAt(session, transcriptPath),
  });
  const merged = mergeInheritedTurns(parentTurns, childTurns, { forkAt, sourceSessionId: parentId });
  // 合并后重新收口到调用方要的窗口，否则一条长父会话会把 limit 翻倍。
  return applyTailLimit(merged, limit, parseOpts && parseOpts.fromTail);
}

async function parseProviderTranscript(args = {}, deps) {
  const {
    defaultCodexSessionsRoot,
    defer = defaultDefer,
    findCodexRolloutByCwd,
    findCodexRolloutBySid,
    findTranscriptByCCSessionId,
    isCodexCliKind,
    parseClaudeTranscriptToTurns,
    parseCodexRolloutToTurns,
    sessionManager,
    transcriptTap,
    updateSessionTranscriptBinding,
  } = deps;
  const validateCodexRolloutPath = typeof deps.isUsableCodexRolloutPath === 'function'
    ? deps.isUsableCodexRolloutPath
    : isUsableCodexRolloutPath;
  const isKimiCliKind = typeof deps.isKimiCliKind === 'function' ? deps.isKimiCliKind : defaultIsKimiCliKind;
  const parseKimiWireToTurns = typeof deps.parseKimiWireToTurns === 'function'
    ? deps.parseKimiWireToTurns
    : defaultParseKimiWireToTurns;

  await defer();

  const { hubSessionId, ccSessionId, transcriptPath: inPath, kind: inKind, opts } = args || {};
  let session = null;
  let transcriptPath = null;
  try {
    session = hubSessionId ? sessionManager.getSession(hubSessionId) : null;
    const nativeCodex = hubSessionId && (sessionManager.getNativeSession?.(hubSessionId) || sessionManager.getNativeCodex?.(hubSessionId));
    if (nativeCodex) {
      try {
        if (!require('../../core/codex-native-runtime').isUnstartedRuntime(nativeCodex.runtime)) await nativeCodex.start();
      } catch (error) {
        // A failed connection must not hide saved Codex history. Only read the
        // bound, identity-checked file; this is not a reconnect or turn replay.
        const sid=session?.codexSid || nativeCodex.runtime?.threadId;
        const saved=session?.transcriptPath || nativeCodex.options?.resumePath;
        if (session?.runtimeBackend !== 'codex-app-server' || !sid || !saved
            || !validateCodexRolloutPath(saved,sid)) throw error;
        transcriptPath=saved;
        const parseOpts={limit:50,fromTail:true,...opts};
        const parsed=await runTranscriptParser(deps,'codex',saved,parseOpts,parseCodexRolloutToTurns);
        return {turns:await withInheritedBranchTurns(args,deps,session,parsed.turns,parseOpts,saved),
          transcriptPath:saved,source:'codex-rollout',error:null,connectionError:error.message,
          parseMs:parsed.meta.parseMs,parseCacheHit:!!parsed.meta.cacheHit};
      }
      const refreshIds=session?.runtimeBackend==='codex-app-server' && Array.isArray(opts?.refreshTurnIds)
        ? [...new Set(opts.refreshTurnIds.filter(id=>typeof id==='string' && id.length<=256))].slice(0,128) : [];
      const displayIds=new Set(Array.isArray(opts?.refreshDisplayIds)?opts.refreshDisplayIds.filter(id=>typeof id==='string' && id.length<=512).slice(0,4096):[]);
      const refreshedTurns=refreshIds.flatMap(turnId=>nativeCodex.readTranscript({turnId,limit:Infinity,toolPreviews:true}))
        .flatMap(turn=>{
          if(!Array.isArray(turn.displayMessages))return displayIds.has(turn.id)?[turn]:[];
          const final=[...turn.displayMessages].reverse().find(m=>['final_answer','final'].includes(m.phase));
          const messages=turn.displayMessages.filter(m=>displayIds.has(m.id)||m===final);
          return messages.length || displayIds.has(turn.id+':activity') ? [{...turn,displayMessages:messages}] : [];
        });
      return {turns:nativeCodex.readTranscript({...opts,toolPreviews:true}),
        refreshedTurns,transcriptPath:session?.transcriptPath || null,
        error:null,source:nativeCodex.isCliProvider ? 'provider-cli' : nativeCodex.options?.kind && require('../../core/acp-profiles').isAcpKind(nativeCodex.options.kind) ? 'acp' : 'codex-app-server'};
    }
    const native = hubSessionId && sessionManager.getNativeClaude?.(hubSessionId);
    if (native) {
      const parseOpts = { limit: 50, fromTail: true, ...(opts || {}) };
      let history = [];
      const turns = native.transcript(opts?.nativeLive ? { tailRecords: 4 }
        : Number.isFinite(parseOpts.limit) && parseOpts.fromTail !== false ? { tailRecords: Math.max(4, parseOpts.limit) } : {});
      if (!opts?.nativeLive) {
        const file = native.historyPath();
        if (file) {
          const parsed = await runTranscriptParser(deps, 'claude', file, { ...native.historyExclusions(), ...parseOpts }, parseClaudeTranscriptToTurns);
          history = parsed.turns || [];
        }
      }
      const live=require('../../core/claude-tool-details').compactClaudeTools(turns,{hubSessionId,threadId:native.sessionId});
      return { turns: applyTailLimit([...history, ...live].sort((a, b) => (a.ts || 0) - (b.ts || 0)), Number(parseOpts.limit), parseOpts.fromTail),
        transcriptPath: null, source: 'claude-stream-json', error: null };
    }
    const kind = session ? session.kind : inKind;
    // Public kind stays `deepseek` across the migration. A persisted Claude id
    // without a Codex id is the unambiguous marker for a pre-migration session;
    // it must keep using the Claude parser even when the live session is absent.
    const effectiveCcSessionId = (session && session.ccSessionId) || ccSessionId || null;
    const isLegacyDeepSeek = /^deepseek(?:-resume)?$/.test(String(kind || ''))
      && !!effectiveCcSessionId
      && !(session && session.codexSid);
    const runtimeKind = (session && session.transcriptKind)
      || (isLegacyDeepSeek ? 'deepseek-legacy' : kind);

    if(/^gemini(?:-resume)?$/.test(String(runtimeKind||''))){
      const bound=session||(hubSessionId?lookupSessionRecord(hubSessionId,deps)?.record:null);
      transcriptPath=bound?.transcriptPath||inPath||null;
      if(!transcriptPath)return {turns:[],transcriptPath:null,
        error:isFreshSession(session)?null:'Gemini 原生记录尚未绑定，请等待 CLI 启动'};
      const parseOpts={limit:50,fromTail:true,...opts,expectedSessionId:bound?.geminiChatId};
      const parsed=await runTranscriptParser(deps,'gemini',transcriptPath,parseOpts,
        require('../../core/gemini-transcript-parser').parseGeminiTranscriptToTurns);
      return {turns:parsed.turns,transcriptPath,error:null,source:'gemini-cli'};
    }

    if (isCodexCliKind(runtimeKind)) {
      const liveRolloutPath = hubSessionId ? transcriptTap.getCodexRolloutPath(hubSessionId) : null;
      const expectedCodexSid = session && session.codexSid ? session.codexSid : null;
      if (liveRolloutPath && validateCodexRolloutPath(liveRolloutPath, expectedCodexSid)) {
        transcriptPath = liveRolloutPath;
      }
      if (!transcriptPath && session && session.transcriptPath
        && validateCodexRolloutPath(session.transcriptPath, expectedCodexSid)) {
        transcriptPath = session.transcriptPath;
      }
      if (!transcriptPath && inPath && validateCodexRolloutPath(inPath, expectedCodexSid)) {
        transcriptPath = inPath;
      }
      if (!transcriptPath && session && session.codexSid) {
        const bySid = findCodexRolloutBySid(
          session.codexSid,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
        );
        if (bySid && validateCodexRolloutPath(bySid, session.codexSid)) transcriptPath = bySid;
      }
      if (!transcriptPath && session && session.codexAllowMtimeFallback && session.cwd) {
        const byCwd = findCodexRolloutByCwd(
          session.cwd,
          session.codexSessionsRoot || defaultCodexSessionsRoot,
          { sinceMs: session.createdAt || Date.now() },
        );
        if (byCwd && validateCodexRolloutPath(byCwd)) transcriptPath = byCwd;
      }
      if (!transcriptPath) {
        if (isFreshSession(session)) {
          return { turns: [], transcriptPath: null, error: null };
        }
        return { turns: [], transcriptPath: null, error: 'codex rollout not found' };
      }
      if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const parsed = await runTranscriptParser(deps, 'codex', transcriptPath, parseOpts, parseCodexRolloutToTurns);
      return {
        turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
        transcriptPath,
        parseMs: parsed.meta.parseMs,
        parseCacheHit: !!parsed.meta.cacheHit,
        error: null,
      };
    }

    if (isKimiCliKind(runtimeKind)) {
      transcriptPath = (session && session.transcriptPath) || inPath || null;
      if (!transcriptPath && session && session.kimiSessionDir) {
        transcriptPath = require('path').join(session.kimiSessionDir, 'agents', 'main', 'wire.jsonl');
      }
      if (!transcriptPath) {
        return { turns: [], transcriptPath: null, error: isFreshSession(session) ? null : 'kimi wire transcript not found' };
      }
      if (hubSessionId && session && session.transcriptPath !== transcriptPath) {
        updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
      }
      const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
      const parsed = await runTranscriptParser(deps, 'kimi', transcriptPath, parseOpts, parseKimiWireToTurns);
      return {
        turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
        transcriptPath,
        parseMs: parsed.meta.parseMs,
        parseCacheHit: !!parsed.meta.cacheHit,
        error: null,
      };
    }

    transcriptPath = session && session.transcriptPath ? session.transcriptPath : null;
    if (!transcriptPath && inPath) {
      transcriptPath = inPath;
    }
    if (!transcriptPath && ccSessionId) {
      transcriptPath = findTranscriptByCCSessionId(ccSessionId);
    }
    if (!transcriptPath && hubSessionId) {
      if (session && session.ccSessionId) {
        transcriptPath = findTranscriptByCCSessionId(session.ccSessionId);
      }
    }
    if (!transcriptPath) {
      const record = session || (hubSessionId ? lookupSessionRecord(hubSessionId, deps)?.record : null);
      return { turns: [], transcriptPath: null,
        error: isFreshSession(record) || isUnsubmittedBranch(record) ? null : 'transcript not found' };
    }
    if (hubSessionId && transcriptPath && session && session.transcriptPath !== transcriptPath) {
      updateSessionTranscriptBinding(hubSessionId, { transcriptPath });
    }
    const parseOpts = { limit: 50, fromTail: true, ...(opts && typeof opts === 'object' ? opts : {}) };
    const parseStartedAt = Date.now();
    // Claude 卡片与原生会话走同一套投影（claude-disk-transcript）：过程/结果分段、
    // 工具状态与耗时都对齐。旧 DeepSeek-Claude 兼容会话保持原解析器。
    const nativeProjection = typeof deps.parseClaudeTranscriptToNativeTurns === 'function'
      && !/^deepseek-legacy/.test(String(runtimeKind || ''));
    // Cards show a preview of each tool result and read the rest on demand;
    // screenshots and long outputs stay in the transcript (transcript-tool-compact).
    const parsed = nativeProjection
      ? await runTranscriptParser(deps, 'claude-native', transcriptPath, { ...parseOpts, compactToolOutputs: true }, deps.parseClaudeTranscriptToNativeTurns)
      : await runTranscriptParser(deps, 'claude', transcriptPath, parseOpts, parseClaudeTranscriptToTurns);
    return {
      turns: await withInheritedBranchTurns(args, deps, session, parsed.turns, parseOpts, transcriptPath),
      transcriptPath,
      parseMs: typeof parsed.meta.parseMs === 'number' ? parsed.meta.parseMs : Date.now() - parseStartedAt,
      parseCacheHit: !!parsed.meta.cacheHit,
      error: null,
    };
  } catch (err) {
    // Some CLIs bind the future transcript path at startup. Only a genuinely
    // unused launch may treat that specific missing-file race as empty history.
    if ((err?.code === 'ENOENT' || /^ENOENT\b/.test(String(err?.message || '')))
        && isFreshSession(hubSessionId ? sessionManager.getSession(hubSessionId) : null, { allowMissingTranscript: true })) {
      return { turns: [], transcriptPath, error: null };
    }
    return { turns: [], transcriptPath, error: err && err.message ? err.message : String(err) };
  }
}

async function parseSessionTranscript(args = {}, deps) {
  const result = await parseProviderTranscript(args, deps);
  if (!args.hubSessionId) return result;
  // After observing real history, never reinterpret its later disappearance as
  // the normal missing-file interval of a brand-new launch.
  if (result.turns?.length && deps.sessionManager.getSession(args.hubSessionId)?.freshLaunch === true) {
    deps.sessionManager.updateSessionMeta?.(args.hubSessionId, { freshLaunch: false });
  }
  const { commandTranscriptStore, mergeCommandTurns } = require('../../core/command-transcript-store');
  const path = require('path'), fs = require('fs');
  if (!deps.commandTranscriptStore && !fs.existsSync(path.join(require('../../core/data-dir').getHubDataDir(), 'command-transcript.sqlite'))) return result;
  const commands = (deps.commandTranscriptStore || commandTranscriptStore()).read(args.hubSessionId);
  if (!commands.length) return result;
  return { ...result, turns: mergeCommandTurns(result.turns || [], commands, args.opts || {}) };
}

function registerTranscriptIpc(ipcMain, deps) {
  const {
    transcriptTap,
  } = deps;
  ipcMain.handle('codex-native:tool-result', (_event, reference = {}) => {
    const native=deps.sessionManager.getNativeCodex?.(reference.hubSessionId);
    if(!native?.readToolResult)throw Error('Codex 工具来源不可用，请重新载入会话');
    return native.readToolResult(reference);
  });
  ipcMain.handle('claude-native:tool-result', (_event, reference = {}) => {
    const native=deps.sessionManager.getNativeClaude?.(reference.hubSessionId);
    if(!native)throw Error('Claude 工具来源不可用，请重新载入会话');
    return require('../../core/claude-tool-details').readClaudeToolResult(native,reference);
  });

  ipcMain.handle('get-last-assistant-text', (_e, sessionId) => {
    const nativeCodex = (deps.sessionManager.getNativeSession?.(sessionId) || deps.sessionManager.getNativeCodex?.(sessionId));
    if (nativeCodex) return nativeCodex.finalText();
    const native = deps.sessionManager?.getNativeClaude?.(sessionId);
    if (native) return native.transcript().filter(turn => turn.role === 'assistant').at(-1)?.text || null;
    return transcriptTap.getLastAssistantText(sessionId);
  });

  ipcMain.handle('parse-session-transcript', async (_e, args = {}) => {
    return parseSessionTranscript(args, deps);
  });
  ipcMain.handle('claude-transcript:tool-result', (_event, reference = {}) => readCompactedToolResult(reference));
}

module.exports = {
  parseSessionTranscript,
  readCompactedToolResult,
  registerTranscriptIpc,
  runTranscriptParser,
};
