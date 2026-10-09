'use strict';
/*
 * 仅测试启用的钩子（任务书 I 层用）
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 为什么需要它：任务书的 I 层要求「运行真实 Electron、IPC、持久化、文件监测和真实 UI」，
 * 但**不**要求为此拉起真实 CLI —— 那是 L 层的事。中间这一层原本没有落脚点：
 * 循环引擎一定要有 dispatcher 才能跑，而真 dispatcher 一定要有真 PTY 和真账号。
 *
 * 于是把这唯一的接缝显式化：只把「派发一轮」和「席位是否就绪」换成测试可控的东西，
 * 其余全部保持真实 —— 真 meeting、真 serialWorkflow 持久化、真任务目录与文件读写、
 * 真交付闸门、真 IPC、真停止意图落盘、真重启重扫。
 *
 * **双重闸门，生产永远拿不到它：**
 *   1. 必须运行在隔离数据目录下（CLAUDE_HUB_DATA_DIR 已设，即 isIsolatedHub()）；
 *   2. 必须显式给出 CLAUDE_HUB_TEST_DISPATCH_SCRIPT 指向一个脚本文件。
 * 缺一个就返回 null，main.js 照常用真 dispatcher 和真 sessionManager。
 *
 * 脚本文件是一个 CommonJS 模块，导出 handle(args, ctx)：
 *   args —— dispatchGroupChatTurn 的原参数（targetMemberIds / userInput / workflowRun …）
 *   ctx  —— { meetingId, taskDocsDir, callIndex }
 *   返回 —— { text?, status?, delayMs?, interrupted?, superseded?, reason? }
 * 每次派发都重新读脚本（清 require 缓存），所以测试能在两次派发之间改行为，
 * 用来制造「第二轮才交付」「中途文件被占用」「这一轮只回一句普通话」这类现场。
 */
const path = require('path');

const SYNTHETIC_PREFIX = 'teststub-';

function loadTestHooks(deps = {}) {
  const { isIsolatedHub, getHubDataDir, meetingManager, logger = console } = deps;
  if (typeof isIsolatedHub !== 'function' || !isIsolatedHub()) return null;
  const scriptPath = String(process.env.CLAUDE_HUB_TEST_DISPATCH_SCRIPT || '').trim();
  if (!scriptPath) return null;

  logger.warn('[test-hooks] 仅测试钩子已启用（隔离实例 + 显式 env）：' + scriptPath);

  let callIndex = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 和引擎里的 sidOf 同一套位置约定，保证结果能被 validateStepResult 认领。 */
  function sidOf(meetingId, memberId) {
    const meeting = meetingManager.getMeeting(meetingId) || {};
    const specs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
    let index = specs.findIndex((spec, i) => String((spec && spec.memberId) || `m${i + 1}`) === String(memberId));
    if (index < 0) {
      const legacy = /^m(\d+)$/.exec(String(memberId || ''));
      index = legacy ? Number(legacy[1]) - 1 : -1;
    }
    return (index >= 0 && Array.isArray(meeting.subSessions)) ? (meeting.subSessions[index] || null) : null;
  }

  function loadScript() {
    const resolved = path.resolve(scriptPath);
    delete require.cache[resolved];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(resolved);
  }

  async function dispatchGroupChatTurn(meetingId, args = {}) {
    callIndex += 1;
    const targets = Array.isArray(args.targetMemberIds) ? args.targetMemberIds : [];
    let outcome = {};
    try {
      const script = loadScript();
      const handle = script && (script.handle || script);
      if (typeof handle === 'function') {
        outcome = (await handle(args, {
          meetingId,
          callIndex,
          taskDocsDir: path.join(getHubDataDir(), 'task-docs', meetingId),
        })) || {};
      }
    } catch (error) {
      logger.error('[test-hooks] 派发脚本抛错：', error && error.message);
      outcome = { status: 'errored', text: '', reason: (error && error.message) || 'stub_script_error' };
    }
    if (Number(outcome.delayMs) > 0) await sleep(Number(outcome.delayMs));

    const turnNum = Number(args.reuseTurnNum) > 0 ? Number(args.reuseTurnNum) : callIndex;
    return {
      status: outcome.status === 'errored' ? 'errored' : 'completed',
      turnNum,
      interrupted: !!outcome.interrupted,
      superseded: !!outcome.superseded,
      results: targets.map((memberId, index) => ({
        sid: sidOf(meetingId, memberId),
        memberId,
        status: outcome.status === 'errored' ? 'errored' : 'completed',
        text: index === 0 ? String(outcome.text == null ? '（测试桩：本轮无输出）' : outcome.text) : '（测试桩）',
        reason: outcome.reason || undefined,
      })),
      stub: true,
    };
  }

  /**
   * 席位就绪检查用的 sessionManager 外壳。
   * 只对 teststub- 前缀的 sid 造一个「活着且空闲」的合成会话，其余一律走真实的那份 ——
   * 所以真实会话存在时行为不变，也不会掩盖「席位真的不见了」这种错误。
   */
  function wrapSessionManager(real) {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'getSession') {
          return (sid) => {
            const found = target.getSession(sid);
            if (found) return found;
            return String(sid || '').startsWith(SYNTHETIC_PREFIX)
              ? { id: sid, title: sid, kind: 'codex', status: 'idle', synthetic: true }
              : null;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** 只在测试模式注册：把合成席位挂进 meeting，省掉为 I 层拉起真实 CLI。 */
  function registerIpc(ipcMain) {
    if (!ipcMain) return;
    ipcMain.handle('test:seed-groupchat-members', (_event, args = {}) => {
      const meetingId = String(args.meetingId || '');
      const count = Math.max(1, Math.min(4, Number(args.count) || 2));
      if (!meetingId || !meetingManager.getMeeting(meetingId)) return { ok: false, reason: 'no_meeting' };
      const sids = [];
      for (let i = 0; i < count; i += 1) {
        const sid = `${SYNTHETIC_PREFIX}${meetingId.slice(0, 8)}-${i + 1}`;
        meetingManager.addSubSession(meetingId, sid);
        sids.push(sid);
      }
      return { ok: true, sids };
    });
    ipcMain.handle('test:dispatch-stats', () => ({ callIndex }));
  }

  // 等待预算也归到这个已被双重闸门锁住的模块里：I 层要在几秒内验完
  // 「等不到文件就保留阶段」，而生产默认要等到 5 分钟。放这里，生产一行都不受影响。
  const budget = (key, fallback) => {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const stepTextWait = {
    docPollMs: budget('CLAUDE_HUB_TEST_DOC_POLL_MS', 300),
    docCapMs: budget('CLAUDE_HUB_TEST_DOC_CAP_MS', 2500),
    builderQuietMs: 50, builderCapMs: 500,
    verdictQuietMs: 50, verdictCapMs: 500,
  };

  return {
    dispatcher: { dispatchGroupChatTurn, interruptMeetingTurn: () => true },
    wrapSessionManager, registerIpc, stepTextWait,
  };
}

module.exports = { loadTestHooks, SYNTHETIC_PREFIX };
