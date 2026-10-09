'use strict';
/*
 * 循环工作流 · 纯逻辑核心（Phase 1，2026-06-29 maintainer）
 * ─────────────────────────────────────────────────────────────
 * 在「串行工作流」之上加：评审 gate + 不达标自动重来 + 达标后自动打磨。
 * 本文件只放【无 DOM / 无 IPC 依赖】的纯逻辑，便于单元测试；
 * 真正的循环驱动（调 groupchat:turn）在 main/groupchat/loop-engine.js，renderer 只展示进度。
 *
 * ⚠ 下面 PROMPTS 是「默认值，待用户审定」——见 Desktop/claude-artifacts/loop-prompt-design.html。
 *   用户改 prompt 文本不影响本文件的判定逻辑（逻辑只依赖 <<<VERDICT>>> 输出契约）。
 *
 * UMD：browser 挂 window.LoopWorkflow；node 走 module.exports（供单测 require）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.LoopWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ===================== 角色 Prompt（默认·待审定） =====================
  const PROMPTS = {
    // 执行者：首轮实现；后续只修评审 blocker。模板职责作为短补充注入。
    builder(ctx) {
      const taskBlock = ctx.firstRound
        ? '这是第一轮：实现目标并完成最小相关验证。'
        : (ctx.phase === 'polishing'
            ? `目标已通过双评审验收，现在进入打磨阶段。本轮只实现下面这一条价值最高的优化项（只做这一条）：\n${ctx.taskText}`
            : `本轮只解决下面的评审阻断项：\n${ctx.taskText}`);
      return [
        '## 角色：执行者',
        `工作区：${ctx.cwd || '(当前会话工作目录)'}`,
        `总目标：${ctx.goal}`,
        ctx.rolePrompt ? `步骤职责：${ctx.rolePrompt}` : '',
        '本轮任务：',
        taskBlock,
        '',
        '要求：只改相关代码；不做无关重构；能复现就先复现；修改后运行验证。若阻断项无法复现，明确说明，不要猜。',
        '输出：改动、验证、剩余风险。是否 PASS 由评审决定。',
      ].filter(Boolean).join('\n');
    },

    // 评审者：亲自验证；输出容错更高的四行契约。parseVerdict 仍兼容旧 JSON。
    reviewer(ctx) {
      return [
        '## 你的角色：评审',
        `你是独立质量把关人，审查执行者本轮的改动。工作区 ${ctx.cwd || '(当前会话工作目录)'}，你可以读代码、运行命令、跑测试，但【不代替执行者编写或修复代码】；仅当本步骤合同明确要求时，可以执行已经亲验通过的分支合并。`,
        ctx.rolePrompt ? `\n## 本步骤职责\n${ctx.rolePrompt}` : '',
        '',
        '## 你的默认立场：不通过',
        '默认 decision = fail。只有在你【亲自验证】之后、且确实挑不出阻断项时，才可以 pass。',
        '不要因为代码"看起来对"、或开发者说"我测过了"，就放行。',
        '',
        '## 你必须做的事',
        '亲自跑测试 / 启动工具喂真实输入 / 复现关键路径，看真实结果。只把会让目标不成立、崩溃或数据错误的硬问题列为阻断项；风格、命名、锦上添花不算阻断项。',
        '',
        '## 目标与改动',
        `· 目标(goal)：${ctx.goal}`,
        '· 执行者本轮改动：见上方执行者的发言（你能看到）。',
        '',
        '## 输出（最后严格输出四行）',
        'RESULT: PASS 或 FAIL',
        'BLOCKERS: 无，或列出必须修复的问题',
        'VERIFIED: 实际执行的验证及结果',
        'NEXT: 无，或下一步建议',
        '',
        '## 红线',
        '· VERIFIED 不能为空——它是你"真的动手验证过"的证明。',
        '· 不代替执行者修改代码；没有合同明确授权时，只给裁决和建议。',
      ].join('\n');
    },

    // 回灌：把合并阻断项 + 两份裁决全文拼给开发者下一轮
    feedback(ctx) {
      const lines = [`## 第 ${ctx.round} 轮评审结果：未通过`, '两位评审合并的阻断项如下，本轮请逐一解决（不要做无关改动）：', ''];
      ctx.blockers.forEach((b, i) => {
        lines.push(`${i + 1}. [${b.from || '评审'}] ${b.what || ''}` + (b.evidence ? `（依据：${b.evidence}）` : ''));
      });
      if (ctx.fullVerdicts && ctx.fullVerdicts.length) {
        lines.push('', '———', '（参考）两位评审的完整裁决，供你判断分歧与取舍：');
        ctx.fullVerdicts.forEach(fv => lines.push(`[${fv.from}]`, fv.raw || JSON.stringify(fv.verdict)));
      }
      return lines.join('\n');
    },
  };

  // ===================== verdict 解析 =====================
  // 从评审回答文本里提取 <<<VERDICT>>> ... <<<END>>> 之间的 JSON。
  // 解析失败返回 null（上层按"保守 fail"处理）。
  /**
   * 这一步的 AI 根本没能力干活（额度用尽 / 被限流 / 会话失效），而不是「答了但没给裁决」。
   *
   * 实测踩到：合并位整轮只回了一句
   *   "You've hit your session limit · resets 6am (America/Los_Angeles)"
   * 引擎当它「没给裁决」保守判 fail，于是又派工作位重做两轮 ——
   * 工作位每轮都正确回答「阻断项是评审没出裁决，我改不了」，白烧两轮 token，
   * 最后报「返工用尽」。维护者看到的是「任务太难做不完」，真实原因却是换个人就好。
   *
   * 判据要窄：只认明确的额度/限流/鉴权失败，别把正文里讨论限流的技术回答误伤。
   * 所以要求文本很短（真出这种事时 CLI 只吐这一句）且整体匹配。
   */
  const UNAVAILABLE_PATTERNS = [
    /you'?ve hit your (session|usage) limit/i,
    /(usage|rate) limit (reached|exceeded)/i,
    /quota (exceeded|exhausted)/i,
    /insufficient (quota|credit)/i,
    /(额度|配额)(已)?(用尽|耗尽|不足)/,
    /请求过于频繁|触发限流/,
    /(401|403).*(unauthorized|forbidden)/i,
    /please (run )?\/login|not (logged in|authenticated)/i,
  ];

  function looksUnavailable(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s || s.length > 400) return false;   // 长回答里提到限流不算
    return UNAVAILABLE_PATTERNS.some(re => re.test(s));
  }

  function parseVerdict(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(/<<<VERDICT>>>([\s\S]*?)<<<END>>>/);
    if (m) {
      let raw = m[1].trim();
      // Legacy contract: tolerate optional fenced JSON.
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let v;
      try { v = JSON.parse(raw); } catch (e) { return null; }
      if (!v || typeof v !== 'object') return null;
      return {
        decision: v.decision === 'pass' ? 'pass' : 'fail',
        blockers: Array.isArray(v.blockers) ? v.blockers : [],
        suggestions: Array.isArray(v.suggestions) ? v.suggestions : [],
        verified: Array.isArray(v.verified) ? v.verified : [],
      };
    }
    // v2 contract: four short lines. This is easier for heterogeneous CLIs to follow.
    const result = text.match(/(?:^|\n)\s*RESULT\s*[:：]\s*(PASS|FAIL)\b/im);
    if (!result) return null;
    const field = (name) => {
      const re = new RegExp('(?:^|\\n)\\s*' + name + '\\s*[:：]\\s*([^\\n]*)', 'im');
      const hit = text.match(re);
      return hit ? hit[1].trim() : '';
    };
    const blockerText = field('BLOCKERS');
    const verifiedText = field('VERIFIED');
    const nextText = field('NEXT');
    const noBlocker = !blockerText || /^(?:无|none|nil|n\/a|\[\])\s*$/i.test(blockerText);
    const noNext = !nextText || /^(?:无|none|nil|n\/a)\s*$/i.test(nextText);
    return {
      decision: result[1].toUpperCase() === 'PASS' ? 'pass' : 'fail',
      blockers: noBlocker ? [] : [{ what: blockerText, evidence: verifiedText }],
      suggestions: noNext ? [] : [{ idea: nextText, why: '' }],
      verified: verifiedText ? [verifiedText] : [],
    };
  }

  // ===================== 合并多评审裁决（AND-pass / OR-fail） =====================
  // input: [{ from, verdict|null, raw }]
  // output: { pass, blockers:[{...,from}], suggestions:[{...,from}], fullVerdicts:[{from,verdict,raw}] }
  function mergeVerdicts(reviews) {
    const blockers = [], suggestions = [], fullVerdicts = [];
    let pass = true;
    for (const r of reviews) {
      fullVerdicts.push({ from: r.from, verdict: r.verdict, raw: r.raw });
      const v = r.verdict;
      if (!v) { // 解析失败 → 保守 fail
        pass = false;
        blockers.push({ what: `评审「${r.from}」未给出可解析裁决`, evidence: '未找到可解析的 RESULT/VERDICT 裁决 → 保守判 fail', from: r.from });
        continue;
      }
      if (v.decision !== 'pass' || (v.blockers && v.blockers.length)) pass = false;
      if (v.decision !== 'pass' && (!v.blockers || !v.blockers.length)) {
        blockers.push({ what: `评审「${r.from}」判定 FAIL 但未给出阻断项`, evidence: '请评审明确必须修复的问题后再回修', from: r.from });
      }
      (v.blockers || []).forEach(b => blockers.push(Object.assign({ from: r.from }, b)));
      (v.suggestions || []).forEach(s => suggestions.push(Object.assign({ from: r.from }, s)));
      // verified 为空也视为不可信 → fail（红线②）
      if ((!v.verified || !v.verified.length)) {
        pass = false;
        blockers.push({ what: `评审「${r.from}」未提供验证证据(verified 为空)`, evidence: '红线：未举证亲验 → 不予通过', from: r.from });
      }
    }
    return { pass, blockers, suggestions, fullVerdicts };
  }

  // ===================== 默认配置 / 初始状态 =====================
  function defaultConfig() {
    return {
      templateId: 'fast-review-loop',
      roles: [
        { role: 'builder', memberId: 'm1' },
        { role: 'reviewer', memberId: 'm2' },
        { role: 'reviewer', memberId: 'm3' },
      ],
      gate: { consecutivePass: 1 },
      polish: { enabled: false },
      stop: { maxRounds: 3, deadlineTs: null, noProgressRounds: 2 },
      cwd: null,
    };
  }
  function newLoopState() {
    return {
      status: 'running',         // running | paused | done | stopped_user | stopped_max | stopped_deadline | stopped_stuck
      phase: 'reaching',         // reaching | polishing
      round: 0,
      consecutiveGreen: 0,
      suggestionPool: [],
      history: [],
      _lastBlockerSig: null,
      _noProgress: 0,
    };
  }

  // Phase 2b：从持久化 loopState 重建可续跑的 state + prevMerge（崩溃/重启续跑）
  function resumeState(persisted) {
    const s = newLoopState();
    if (persisted && typeof persisted === 'object') {
      s.status = persisted.status || 'running';
      s.phase = persisted.phase || 'reaching';
      s.round = persisted.round || 0;
      s.consecutiveGreen = persisted.consecutiveGreen || 0;
      s.suggestionPool = Array.isArray(persisted.suggestionPool) ? persisted.suggestionPool : [];
      s.history = Array.isArray(persisted.history) ? persisted.history : [];
      s.goal = persisted.goal || '';
      s._lastBlockerSig = persisted._lastBlockerSig || null;
      s._noProgress = persisted._noProgress || 0;
      s.currentStep = persisted.currentStep || null;
      s.attempt = persisted.attempt || (s.round + 1);
      s.lastError = persisted.lastError || null;
      s.runId = persisted.runId || null;
      s.currentTurnNum = persisted.currentTurnNum || null;
      s.stepAttempt = Number(persisted.stepAttempt) || 0;
    }
    // 上一轮若未过 → 恢复 prevMerge，让续跑首轮回灌其阻断项
    const last = s.history[s.history.length - 1];
    const prevMerge = (last && last.pass === false)
      ? { pass: false, blockers: last.blockers || [], suggestions: [], fullVerdicts: [] }
      : null;
    return { state: s, prevMerge };
  }

  function blockerSig(blockers) {
    return (blockers || []).map(b => (b.what || '')).sort().join('|');
  }

  // ===================== 状态推进（每轮评审后调用，纯函数语义） =====================
  // 返回 next state（在传入 state 上原地推进并返回，便于链式 + 测试断言）。
  // merge: mergeVerdicts 的结果；nowTs: 当前时间戳；config: 配置
  function advanceLoopState(state, merge, config, nowTs) {
    state.round += 1;
    // Legacy polish compatibility: freeze the suggestion pool when entering polishing.
    // Never add fresh reviewer suggestions during polishing, otherwise the pool self-refills.
    if (state.phase === 'reaching' && config.polish && config.polish.enabled) {
      (merge.suggestions || []).forEach(s => state.suggestionPool.push(s));
    }
    state.history.push({ round: state.round, phase: state.phase, pass: merge.pass, blockers: merge.blockers.slice(), });

    // 无进展检测：同一批阻断项连续重复
    const sig = blockerSig(merge.blockers);
    if (!merge.pass && sig && sig === state._lastBlockerSig) state._noProgress += 1; else state._noProgress = 0;
    state._lastBlockerSig = merge.pass ? null : sig;

    if (state.phase === 'reaching') {
      if (merge.pass) {
        state.consecutiveGreen += 1;
        if (state.consecutiveGreen >= (config.gate && config.gate.consecutivePass || 1)) {
          if (config.polish && config.polish.enabled && state.suggestionPool.length) state.phase = 'polishing';
          else state.status = 'done';
        }
      } else {
        state.consecutiveGreen = 0; // 回灌阻断项（由调用方读 merge.blockers 拼下轮）
      }
    } else if (state.phase === 'polishing') {
      if (merge.pass) {
        state.suggestionPool.shift(); // 当前这条优化做完且没改坏 → 取走
        if (!state.suggestionPool.length) state.status = 'done';
      }
      // 未过 → 当前优化引入了问题，下一轮继续修（blockers 回灌）
    }

    // 三道强制退出（任一触发覆盖正常态）
    if (state.status === 'running') {
      if (state.round >= (config.stop && config.stop.maxRounds || 8)) state.status = 'stopped_max';
      else if (config.stop && config.stop.deadlineTs && nowTs && nowTs >= config.stop.deadlineTs) state.status = 'stopped_deadline';
      else if (config.stop && config.stop.noProgressRounds && state._noProgress >= config.stop.noProgressRounds) state.status = 'stopped_stuck';
    }
    return state;
  }

  // 本轮该派给开发者的"任务文本"（首轮/达标回灌/打磨）
  function builderTaskText(state, merge, config) {
    if (state.round === 0) return { firstRound: true, phase: state.phase, taskText: '' };
    if (state.phase === 'polishing') {
      const s = state.suggestionPool[0];
      return { firstRound: false, phase: 'polishing', taskText: s ? `${s.idea || ''}（理由：${s.why || ''}）` : '（建议池已空）' };
    }
    // reaching 回灌
    const lines = (merge && merge.blockers || []).map((b, i) => `${i + 1}. [${b.from || '评审'}] ${b.what || ''}` + (b.evidence ? `（依据：${b.evidence}）` : ''));
    return { firstRound: false, phase: 'reaching', taskText: lines.join('\n') };
  }

  // ===================== 晨间报告生成（Phase 2：循环跑完出 HTML 复盘） =====================
  function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function buildReportHtml(goal, state, config, meta) {
    meta = meta || {};
    const rows = (state.history || []).map(h =>
      `<tr><td>${h.round}</td><td>${_esc(h.phase)}</td><td>${h.pass ? '<span class=g>通过</span>' : '<span class=r>未过</span>'}</td><td>${(h.blockers || []).length}</td><td>${_esc((h.blockers || []).map(b => b.what).join('；')).slice(0, 240)}</td></tr>`
    ).join('') || '<tr><td colspan=5 class=soft>（无轮次）</td></tr>';
    const pool = (state.suggestionPool || []).map(s =>
      `<li>${_esc(s.idea)}${s.why ? ' — <span class=soft>' + _esc(s.why) + '</span>' : ''}${s.from ? ' <span class=soft>[' + _esc(s.from) + ']</span>' : ''}</li>`
    ).join('') || '<li class=soft>（空）</li>';
    const statusZh = { done: '✅ 验收通过', paused: '⏸ 步骤失败，已暂停', stopped_user: '⏹ 用户停止', stopped_max: '⏹ 到轮次上限', stopped_deadline: '⏰ 到截止时间', stopped_stuck: '⚠ 连续无进展终止', running: '… 运行中' }[state.status] || state.status;
    return [
      '<!DOCTYPE html><html lang=zh-CN><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1">',
      '<title>循环复盘 · ' + _esc(goal).slice(0, 40) + '</title><style>',
      ':root{--bg:#fafafa;--card:#fff;--ink:#1d1d1f;--soft:#6e6e73;--bd:#d2d2d7;--ac:#0071e3;--g:#34c759;--r:#ff3b30}',
      '@media(prefers-color-scheme:dark){:root{--bg:#1d1d1f;--card:#2c2c2e;--ink:#f5f5f7;--soft:#aeaeb2;--bd:#38383a;--ac:#0a84ff;--g:#30d158;--r:#ff453a}}',
      'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC",system-ui,sans-serif;line-height:1.7;padding:40px 20px}',
      '.w{max-width:880px;margin:0 auto}h1{font-size:24px;margin:0 0 6px}.sub{color:var(--soft);font-size:14px;margin:0 0 16px;word-break:break-all}',
      '.badge{display:inline-block;padding:6px 14px;border-radius:999px;background:color-mix(in srgb,var(--ac) 14%,transparent);color:var(--ac);font-weight:700;font-size:14px;margin:4px 0 18px}',
      'table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden;margin:12px 0}',
      'th,td{padding:9px 12px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}th{color:var(--soft);font-size:12px;background:color-mix(in srgb,var(--soft) 6%,transparent)}tr:last-child td{border-bottom:none}',
      '.g{color:var(--g);font-weight:600}.r{color:var(--r);font-weight:600}.soft{color:var(--soft)}h2{font-size:16px;margin:24px 0 8px}ul{padding-left:20px;font-size:14px}',
      '.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px 18px;margin:12px 0;font-size:14px}',
      '</style></head><body><div class=w>',
      '<h1>🔁 循环工作流复盘</h1>',
      '<p class=sub>目标：' + _esc(goal) + '</p>',
      '<div class=badge>' + statusZh + ' · 共 ' + state.round + ' 轮' + (meta.builderLabel ? ' · 开发 ' + _esc(meta.builderLabel) : '') + (meta.reviewerLabels ? ' · 评审 ' + _esc(meta.reviewerLabels) : '') + '</div>',
      '<div class=card>阶段：' + _esc(state.phase) + '　|　连续绿：' + state.consecutiveGreen + '　|　建议池剩 ' + (state.suggestionPool || []).length + ' 条</div>',
      '<h2>每轮明细</h2><table><tr><th>轮</th><th>阶段</th><th>结果</th><th>阻断数</th><th>阻断项</th></tr>' + rows + '</table>',
      '<h2>建议池（待消化 / 已记录）</h2><ul>' + pool + '</ul>',
      '<p class=soft style="margin-top:30px;font-size:12px">' + _esc(meta.finishedAt || '') + ' · 循环工作流自动生成 · 自包含离线</p>',
      '</div></body></html>'
    ].join('');
  }

  return {
    PROMPTS, parseVerdict, looksUnavailable, mergeVerdicts, advanceLoopState,
    defaultConfig, newLoopState, resumeState, builderTaskText, blockerSig, buildReportHtml,
  };
});
