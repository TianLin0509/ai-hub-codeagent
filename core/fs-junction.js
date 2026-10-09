'use strict';
const fs = require('node:fs');

// Windows can briefly reject a new junction after writes/renames with a
// sharing violation. Bound this filesystem readiness wait; never replace an
// existing path or turn a persistent error into success.
const READY_BUDGET_MS = 2000;
const RETRY_INTERVAL_MS = 20;
function createJunctionSync(target, link) {
  const deadline = Date.now() + READY_BUDGET_MS;
  let waiter;
  for (;;) {
    try {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      return;
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EBUSY' || Date.now() >= deadline) throw error;
      // lstat also detects dangling links; existsSync would miss those.
      let absent = false;
      try { fs.lstatSync(link); } catch (statError) { if (statError.code === 'ENOENT') absent = true; }
      if (!absent) throw error;
      waiter ||= new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waiter, 0, 0, Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }
}
module.exports = { createJunctionSync };
