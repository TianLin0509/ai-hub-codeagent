'use strict';

const path = require('path');
const { prepareLaunch, historySqliteHomeSync } = require('./codex-global-account');
const { CodexAppServerClient } = require('../main/codex-app-server-client');

// Codex permits resume across homes, but thread/fork requires its source
// rollout inside CODEX_HOME. Fork locally in the history home first, then let
// the ordinary resume path use the currently selected account. No inference,
// credentials migration or source-thread writer is needed.
async function prepareCrossAccountCodexFork(opts, {
  config, env = process.env,
  createClient = options => new CodexAppServerClient(options),
} = {}) {
  if (!opts.codexForkSid || config.codexBackend === 'api') return opts;
  const launch = prepareLaunch(opts, config, env);
  const historyHome = launch.opts.codexHistoryStorageHome;
  if (path.resolve(historyHome).toLowerCase() === path.resolve(launch.account.home).toLowerCase()) return opts;
  const sqliteHome = historySqliteHomeSync(historyHome, null, env);
  const client = createClient({ cwd: opts.cwd, env: { ...env, CODEX_HOME: historyHome },
    args: ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`] });
  try {
    await client.start();
    const result = await client.request('thread/fork', {
      threadId: opts.codexForkSid, path: launch.opts.resumeTranscriptPath,
      cwd: opts.cwd, model: opts.model, approvalPolicy: 'never', sandbox: 'read-only',
    });
    const thread = result.thread;
    if (!thread?.id || thread.id === opts.codexForkSid || !thread.path) {
      throw new Error('Codex 未返回独立分支及历史路径，未启动替代会话');
    }
    const relative = path.relative(historyHome, thread.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Codex 分支历史不在原历史目录内，未启动');
    const { codexForkSid, ...rest } = opts;
    return { ...rest, useResume: true, codexSid: thread.id,
      resumeTranscriptPath: thread.path, codexSessionsRoot: path.join(historyHome, 'sessions') };
  } finally {
    client.close();
    await client.waitForExit();
  }
}

module.exports = { prepareCrossAccountCodexFork };
