'use strict';

// Matches the installed App Server 0.153.4 schema, not a TUI keystroke or
// default_mode_request_user_input feature override. Applies on the next turn.
async function configureMode(session, mode, intent, expectedEpoch) {
  if (!['plan', 'default'].includes(mode)) throw new Error('仅支持 plan 或 default 模式');
  await session.start();
  const check = () => {
    session.checkSendable(intent);
    if (expectedEpoch != null && expectedEpoch !== session.runtime.epoch) throw new Error('模式操作来自旧连接');
    if (!['idle', 'completed', 'failed', 'interrupted'].includes(session.runtime.state)) throw new Error('当前轮次结束后才能切换工作方式');
  };
  check();
  const client = session.entry.client;
  const result = await session.requestNative(client, 'collaborationMode/list', {}, undefined, { beforeWrite: check });
  check();
  if (client !== session.entry.client) throw new Error('模式响应来自旧连接');
  if (!(result.data || []).some(item => item.mode === mode)) throw new Error('当前 Codex 不支持所选工作方式');
  // Preset model and effort are deliberately not copied over the user's choices.
  session.apply({ type: 'configuration', error: null, collaborationMode: mode });
  return { mode, appliesOn: 'next-turn' };
}

function turnCollaborationMode(session) {
  const mode = session.runtime.collaborationMode;
  if (mode == null) return {};
  if (!['plan', 'default'].includes(mode)) throw new Error('已保存的 Codex 工作方式无效，请重新选择');
  return { collaborationMode: { mode, settings: { model: session.options.turnParams.model,
    reasoning_effort: session.options.turnParams.effort || null, developer_instructions: null } } };
}

module.exports = { configureMode, turnCollaborationMode };
