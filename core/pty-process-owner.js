'use strict';

// Record immediately after native spawn, before yielding to any exit callback.
// A shutdown-time observation is too late: the PID may already be recycled.
const owners = new WeakMap();
function recordPtySpawn(pty) {
  const pid = Number(pty?.pid);
  if (Number.isSafeInteger(pid) && pid > 0 && !owners.has(pty)) {
    owners.set(pty, Object.freeze({ pty, pid, observedAt: Date.now() }));
  }
  return pty;
}
function ptyProcessOwner(pty) {
  return owners.get(pty?.isCliProvider ? pty.pty : pty);
}
module.exports = { recordPtySpawn, ptyProcessOwner };
