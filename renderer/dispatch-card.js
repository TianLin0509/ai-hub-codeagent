/* 派发卡片的纯逻辑：这条卡片是发给谁的、正文里哪一段是每轮重复的角色抬头。
 *
 * 为什么要单独一个文件：meeting-room.js 只在浏览器里跑，没法在 node 单测里 require；
 * 这两件事都是纯字符串判断，拿出来才能被测。渲染（DOM/HTML）仍留在 meeting-room.js。
 *
 * 背景（2026-09-06 维护者提的两件事）：
 *   1. 发给合并位的指令在群聊窗口里看不到 —— 那是消息层没记，已在 orchestrator 修；
 *      这里负责把「发给谁」显示出来，让两张卡片一眼能分清。
 *   2. 每轮重复发角色定位「是否必要」—— 实测工作位每轮 374 字符、评审 530 字符，
 *      成本可忽略，且 CLI 上下文被压缩后这段重复是角色约定的兜底，所以**不动 prompt**，
 *      只在 UI 上把重复的抬头折叠起来。折叠是纯展示，实际下发内容一个字都没变。
 *
 * UMD：browser 挂 window.DispatchCard；node 走 module.exports（供单测 require）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DispatchCard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 抬头与本轮任务的分界线。工作位的 prompt 有这一行；评审的没有（它整段都是常驻角色文本）。
  const TASK_BOUNDARY = /^[ \t]*本轮任务[:：][ \t]*$/m;
  // 整段都是角色文本时，短的就不折了 —— 折一个两行的东西只会更吵。
  const COLLAPSE_MIN_CHARS = 320;

  /**
   * 把派发 prompt 拆成「可折叠的角色抬头」和「本轮真正要看的正文」。
   * 拆不出来就原样返回（head 为空），调用方照常整段渲染。
   */
  function splitDispatchPrompt(content) {
    const text = String(content == null ? '' : content);
    const m = TASK_BOUNDARY.exec(text);
    if (m) {
      const head = text.slice(0, m.index).trim();
      const body = text.slice(m.index).trim();
      // 抬头太短就不值得折
      if (head.length >= 40) return { head, body, mode: 'split' };
      return { head: '', body: text, mode: 'plain' };
    }
    if (/^[ \t]*##[ \t]*\S/.test(text) && text.length >= COLLAPSE_MIN_CHARS) {
      return { head: text.trim(), body: '', mode: 'all' };
    }
    return { head: '', body: text, mode: 'plain' };
  }

  /** 折叠条上显示的标题：优先用 prompt 的第一行标题，实在没有就给个通用说法。 */
  function collapsedTitle(content) {
    const first = String(content || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    const cleaned = first.replace(/^#+\s*/, '').trim();
    return cleaned ? cleaned.slice(0, 40) : '角色与目标';
  }

  /** 「发给 X、Y」；没有收件人信息就返回空串（普通群聊消息不显示这个角标）。 */
  function recipientText(message) {
    const labels = message && Array.isArray(message.toLabels) ? message.toLabels.filter(Boolean) : [];
    if (!labels.length) return '';
    return '发给 ' + labels.join('、');
  }

  /** 同一步的第 N 次传输重试复用同一张卡片，只在角标上标出来，不再造一张。 */
  function attemptText(message) {
    const attempt = message && message.dispatch && Number(message.dispatch.attempt);
    return attempt > 1 ? `第 ${attempt} 次派发` : '';
  }

  function isDispatchCard(message) {
    return !!(message && message.dispatch && Number.isInteger(Number(message.dispatch.stepIndex)));
  }

  return { splitDispatchPrompt, collapsedTitle, recipientText, attemptText, isDispatchCard, COLLAPSE_MIN_CHARS };
});
