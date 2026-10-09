'use strict';
// Only used to hydrate existing groups after renderer/main restart. JSON parsing
// stays off the Electron main thread. Live updates arrive at the write boundary.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { summarizeGroupState } = require('./dev-workbench-feed');
parentPort.on('message', async ({ requestId, file, type, dataDir, meeting }) => {
  if(type==='task'){
    try { parentPort.postMessage({requestId,task:await require('./dev-task-view').readTask(dataDir,meeting)}); }
    catch(error){parentPort.postMessage({requestId,error:error.message || String(error)});}
    return;
  }
  try {
    const size = fs.statSync(file).size;
    if (size > 64 * 1024 * 1024) throw new Error('旧群聊记录超过 64 MB，未自动载入；请进入群聊查看。新的汇报仍会自动推送。');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('群聊记录格式无效');
    parentPort.postMessage({ requestId, summary: summarizeGroupState(state) });
  } catch (error) {
    parentPort.postMessage({ requestId, error: error.code === 'ENOENT' ? null : error.message, missing: error.code === 'ENOENT' });
  }
});
