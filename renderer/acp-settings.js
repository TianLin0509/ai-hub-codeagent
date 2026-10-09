'use strict';
const { LABELS, ACP_KINDS } = require('../core/acp-profiles');
async function openAcpSettings({ document: doc = document, invoke }) {
  if (doc.getElementById('acp-settings-dialog')) return;
  const settings = await invoke('acp:settings:get');
  const dialog = doc.createElement('dialog');
  dialog.id = 'acp-settings-dialog';
  dialog.style.cssText = 'width:min(760px,90vw);max-height:85vh;overflow:auto;background:var(--bg-primary,#18212d);color:var(--text-primary,#eee);border:1px solid var(--border-color,#607084);border-radius:12px;padding:24px';
  const title = doc.createElement('h2'); title.textContent = '原生 Harness · 阿里云套餐'; dialog.append(title);
  const note = doc.createElement('p'); note.textContent = '三家共用套餐 Key，各自运行原生工具。填写本机已安装的入口；保存后用于新建和恢复会话。'; dialog.append(note);
  const fields = new Map();
  function field(key, label, value = '', secret = false) {
    const row = doc.createElement('label'); row.style.cssText = 'display:block;margin:12px 0'; row.textContent = label;
    const input = doc.createElement('input'); input.type = secret ? 'password' : 'text'; input.value = value;
    input.style.cssText = 'display:block;box-sizing:border-box;width:100%;padding:8px;margin-top:5px;background:var(--bg-secondary,#263346);color:inherit;border:1px solid #66768a;border-radius:5px';
    input.autocomplete = 'off'; input.setAttribute('aria-label', label); row.append(input); dialog.append(row); fields.set(key, input);
  }
  field('key', settings.apiKeySet ? '套餐 Key（已保存；留空保留）' : '套餐专属 Key', '', true);
  field('node', 'Node 可执行文件绝对路径（22 或更高）', settings.nodePath);
  for (const kind of ACP_KINDS) {
    const heading = doc.createElement('h3'); heading.textContent = LABELS[kind]; dialog.append(heading);
    const value = settings.providers[kind] || {};
    field(kind + ':entryPath', 'JavaScript 入口绝对路径', value.entryPath);
    field(kind + ':model', '套餐模型 ID', value.model);
    field(kind + ':mcpConfigPath', 'MCP 配置文件绝对路径（可选，ACP server 数组）', value.mcpConfigPath);
    if (kind === 'glm') field(kind + ':backendPath', '原生 ZCode 的 zcode.cjs 绝对路径', value.backendPath);
    if (kind === 'deepseek-acp') field(kind + ':bridgePath', '完整交互 ACP 扩展包目录（@openma/deepseek-harness-acp）', value.bridgePath);
  }
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); dialog.append(status);
  const save = doc.createElement('button'); save.textContent = '保存套餐配置'; save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const providers = Object.fromEntries(ACP_KINDS.map(kind => [kind, Object.fromEntries(
        ['entryPath','model','backendPath','bridgePath','mcpConfigPath'].map(key => [key, fields.get(kind + ':' + key)?.value || '']))]));
      const result = await invoke('acp:settings:save', { apiKey: fields.get('key').value, nodePath: fields.get('node').value, providers });
      if (!result?.ok) throw new Error(result?.message || '保存失败');
      fields.get('key').value = '';
      status.textContent = '已保存。请新建会话验证模型连接。';
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  const close = doc.createElement('button'); close.textContent = '关闭'; close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { fields.get('key').value = ''; dialog.remove(); });
  dialog.append(save, close); doc.body.append(dialog); dialog.showModal();
}
module.exports = { openAcpSettings };
