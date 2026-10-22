'use strict';
// DSH builds its isolated module links at startup. Windows indexing can hold
// a newly created directory briefly; retry only transient link failures.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
function installLinkRetry(platform = process.platform) {
  if (platform !== 'win32') return;
  const original = fs.symlinkSync;
  fs.symlinkSync = function (...args) {
    for (let attempt = 1; ; attempt++) {
      try { return original.apply(this, args); }
      catch (error) {
        if (attempt >= 5 || !['EBUSY', 'EPERM'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 100);
      }
    }
  };
  syncBuiltinESMExports();
}
installLinkRetry();
module.exports = { installLinkRetry };
