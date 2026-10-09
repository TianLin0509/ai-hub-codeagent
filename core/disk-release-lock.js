'use strict';

// Use an OS-owned named pipe, like the project's unit-suite lock. A crashed
// Windows process releases it automatically, without deleting a stale lock file.
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

function acquireDiskReleaseLock(key = 'aihub-disk-release-cleanup-v1') {
  const name = `aihub-disk-release-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', error => {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) {
        const busy = new Error('另一个窗口正在清理，请稍后重试'); busy.code = 'EEXIST'; reject(busy);
      } else reject(error);
    });
    server.once('listening', () => resolve(() => new Promise(done => server.close(done))));
    server.listen(address);
  });
}
module.exports = { acquireDiskReleaseLock };
