'use strict';
// 「昨日之我」里点一条还没有 Hub 会话的原生记录时，决定用哪种会话恢复、带哪些参数。
// CodeAgent 的记录与 Claude 同格式（nativeFamily 也是 claude），按 provider 区分：
// 用 codeagent-resume 在原目录接着聊，模型取启动中心「设为默认」的 CodeAgent 模型
// （与启动中心「恢复会话」→ CodeAgent 一致，见 past-session-modals.js）。

function resumeRequestForSearchHit(hit, { codeagentModel } = {}) {
  if (!hit || !hit.nativeSessionId) return null;
  const opts = {
    title: hit.title || undefined,
    cwd: hit.cwd || undefined,
    resumeTranscriptPath: hit.transcriptPath || undefined,
    autoTitleGenerated: !!hit.title,
  };
  let kind;
  if (hit.nativeFamily === 'claude' && hit.provider === 'codeagent') {
    kind = 'codeagent-resume';
    opts.resumeCCSessionId = hit.nativeSessionId;
    if (codeagentModel) opts.model = codeagentModel;
  } else if (hit.nativeFamily === 'claude') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'claude-resume';
    opts.resumeCCSessionId = hit.nativeSessionId;
    if (hit.provider === 'deepseek') opts.deepseekLegacyClaude = true;
  } else if (hit.nativeFamily === 'codex') {
    kind = hit.provider === 'deepseek' ? 'deepseek-resume' : 'codex-resume';
    opts.useResume = true;
    opts.codexSid = hit.nativeSessionId;
    if (hit.codexSessionsRoot) opts.codexSessionsRoot = hit.codexSessionsRoot;
    if (hit.codexProfile) opts.codexProfile = hit.codexProfile;
  } else {
    return null;
  }
  return { kind, opts };
}

module.exports = { resumeRequestForSearchHit };
