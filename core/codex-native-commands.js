'use strict';

const HELP = `命令原文会保留在卡片历史中。
/goal [目标] · /goal edit <目标> · /goal pause|resume|clear
/model [模型] · /plan [任务] · /plan off · /review [要求]
/status · /context · /usage · /mcp · /skills · /hooks · /apps · /plugins
/rename <名称> · /compact · /diff · /ps · /stop · /debug-config
/init · /<skill名称> [任务]（包括当前后端已安装的 /loop 等 skill）
新建、恢复、分叉请使用 Hub 会话菜单。
/logout、/login 尚未接入：在 PowerShell 使用 codex logout、codex login（相同 CODEX_HOME）。`;

function formatGoal(result) {
  const goal = result?.goal;
  if (!goal) return '当前没有目标。使用 /goal <目标> 设置。';
  const status = {active:'进行中',paused:'已暂停',complete:'已完成',blocked:'受阻'}[goal.status] || goal.status || '已设置';
  return `目标：${goal.objective}\n状态：${status}`
    + (goal.tokenBudget != null ? `\nToken：${goal.tokensUsed || 0} / ${goal.tokenBudget}` : '');
}

async function skills(session, request) {
  const result = await request('skills/list', { cwds: [session.options.cwd], forceReload: true });
  const errors = (result.data || []).flatMap(group => group.errors || []);
  if (errors.length) throw new Error('Skill 目录读取失败：' + JSON.stringify(errors));
  return (result.data || []).flatMap(group => group.skills || []).filter(skill => skill.enabled !== false);
}

// Return actual native input for prompt/skill commands; control commands never
// masquerade as a successful model answer. Unknown commands stay explicit errors.
async function extendedCommand(session, command, value, request) {
  if (command === '/model' && !value) {
    const rows = [], seen = new Set(); let cursor;
    do {
      const page = await request('model/list', { ...(cursor ? {cursor} : {}) });
      rows.push(...(page.data || [])); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('模型目录分页游标重复，目录未完整读取');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { output: '使用 /model <模型 ID> 切换，也可点击输入框的模型按钮。\n'
      + rows.map(model => `${model.id || model.model} · ${model.displayName || model.model}`).join('\n') };
  }
  if (command === '/skills') {
    const list = await skills(session, request);
    return { output: list.length ? list.map(s => `/${s.name} · ${s.description || ''}`).join('\n') : '当前没有可用 skill。' };
  }
  const queries = {
    '/hooks':['hooks/list',{cwds:[session.options.cwd]}],
    '/apps':['app/list',{threadId:session.threadId}],
    '/plugins':['plugin/list',{cwds:[session.options.cwd]}],
    '/usage':['account/rateLimits/read',{}],
    '/debug-config':['config/read',{includeLayers:true}],
    '/ps':['thread/backgroundTerminals/list',{threadId:session.threadId}],
    '/stop':['thread/backgroundTerminals/clean',{threadId:session.threadId}],
    '/clean':['thread/backgroundTerminals/clean',{threadId:session.threadId}],
  };
  if (queries[command]) {
    if (value) throw new Error(command + ' 暂不接受参数');
    const [method, params] = queries[command];
    let result = await request(method, params);
    if (command === '/apps') {
      const rows = [...(result.data || [])], seen = new Set();
      while (result.nextCursor) {
        if (seen.has(result.nextCursor)) throw new Error('应用目录分页游标重复，目录未完整读取');
        seen.add(result.nextCursor);
        result = await request(method, {...params,cursor:result.nextCursor});
        rows.push(...(result.data || []));
      }
      result = {...result,data:rows};
    }
    return { output: JSON.stringify(result, null, 2) };
  }
  if (command === '/context') return {output: session.tokenUsage ? JSON.stringify(session.tokenUsage, null, 2) : '引擎尚未返回上下文用量；完成一次对话后可再次查询。'};
  if (command === '/diff') {
    const {execFile} = require('child_process');
    const run = require('util').promisify(execFile);
    const options = {cwd:session.options.cwd,windowsHide:true,maxBuffer:16*1024*1024};
    const diff = await run('git',['diff','HEAD','--'],options);
    const untracked = await run('git',['ls-files','--others','--exclude-standard'],options);
    return {output:(diff.stdout || '没有已跟踪文件的改动。') + (untracked.stdout ? '\n未跟踪文件：\n'+untracked.stdout : '')};
  }
  if (command === '/init') return {prompt:'Create an AGENTS.md file with repository instructions for coding agents. Inspect the repository first and preserve existing instructions.\n'+value};
  const knownUi = ['new','clear','resume','fork','archive','delete','quit','exit','app','agent','subagents',
    'permissions','experimental','memories','import','approve','ide','keymap','vim','setup-default-sandbox',
    'sandbox-add-read-dir','copy','raw','mention','title','statusline','theme','pets','pet','feedback','personality','side','btw'];
  if (knownUi.includes(command.slice(1))) throw new Error(command + ' 是 CLI 交互命令，尚无对应原生操作。请使用 Hub 的会话/设置入口；原文已保留，未发送给模型。');
  const matches = (await skills(session, request)).filter(s => s.name.toLowerCase() === command.slice(1).toLowerCase());
  if (matches.length > 1) throw new Error('存在多个同名 skill：'+command+'，请先消除名称冲突');
  if (matches.length === 1 && matches[0].path) return { prompt: value || '执行 '+command+' skill。', skill: matches[0] };
  throw new Error('此命令尚无 Hub 原生映射，也未找到同名 skill：'+command+'。未发送给模型；输入 /help 或 /skills 查看当前支持的命令。/loop 属于 Claude Code 命令；Codex 需要安装对应 skill。');
}

module.exports = { HELP, formatGoal, extendedCommand };
