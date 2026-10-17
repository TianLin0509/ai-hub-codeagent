'use strict';
// 公司版「助理」页开不开：只在公司版（target=company，features.companyAssistant 没关）启用；家里自用版、公开版都不显示。
// 隔离测试可用 CLAUDE_HUB_COMPANY_ASSISTANT=1 打开（必须同时有隔离数据目录，生产实例改不了）。
function companyAssistantEnabled(env = process.env, distribution = require('../distribution')) {
  if (env.CLAUDE_HUB_COMPANY_ASSISTANT && env.CLAUDE_HUB_DATA_DIR) return env.CLAUDE_HUB_COMPANY_ASSISTANT === '1';
  return distribution.target === 'company' && distribution.featureEnabled('companyAssistant');
}
module.exports = { companyAssistantEnabled };
