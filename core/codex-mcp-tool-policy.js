'use strict';

// Per-tool settings keep a dedicated integration independent of global approval policy.
function toolApprovalEntries(entry) {
  const policies = entry?.toolApprovalModes;
  if (policies == null) return [];
  if (typeof policies !== 'object' || Array.isArray(policies)) throw new Error('Codex MCP 工具审批配置无效');
  return Object.entries(policies).map(([tool, mode]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(tool) || !['auto', 'prompt', 'writes', 'approve'].includes(mode)) {
      throw new Error('Codex MCP 工具审批配置无效');
    }
    return [tool, mode];
  });
}

function toolPolicyEntries(entry) {
  const policies = Object.fromEntries(toolApprovalEntries(entry).map(([name, mode]) => [name, { approval_mode: mode }]));
  const limits = entry?.toolOutputTokenLimits;
  if (limits != null) {
    if (typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Codex MCP 工具输出预算无效');
    for (const [name, value] of Object.entries(limits)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !Number.isSafeInteger(value) || value <= 0) throw new Error('Codex MCP 工具输出预算无效');
      policies[name] = { ...policies[name], output_token_limit: value };
    }
  }
  return Object.entries(policies);
}
module.exports = { toolApprovalEntries, toolPolicyEntries };
