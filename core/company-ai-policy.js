'use strict';
// Distribution identity comes from the shipped marker, never from an API key or user preference.
const distribution = require('./distribution');
const companyOnly = () => distribution.target === 'company';
function assertExternalAiAllowed() {
  if (companyOnly()) throw new Error('公司版 AI 任务只使用 CodeAgent；语音只使用本地识别，不调用外部 AI 服务。');
}
function assertKind(kind) {
  if (companyOnly() && !['codeagent', 'powershell'].includes(String(kind).replace(/-resume$/, ''))) throw new Error('公司版只支持 CodeAgent 和 PowerShell，请选择 CodeAgent。');
}
module.exports = { companyOnly, assertExternalAiAllowed, assertKind };
