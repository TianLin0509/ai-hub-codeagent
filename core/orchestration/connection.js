'use strict';
const path = require('node:path');
function connectionFile(dataDir, sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) throw Error('无效的群成员会话编号');
  return path.join(dataDir, 'orchestration', 'connections', sessionId + '.json');
}
function commandFile(dataDir, sessionId) {
  return connectionFile(dataDir, sessionId).replace(/\.json$/, process.platform === 'win32' ? '.cmd' : '.sh');
}
module.exports = { connectionFile, commandFile };
