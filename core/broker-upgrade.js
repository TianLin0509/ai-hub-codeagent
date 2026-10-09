'use strict';
function compareVersion(a, b) {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some(n => !Number.isSafeInteger(n) || n < 0)) return 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
function createBrokerUpgrade({ broker, build, onReady, logger = console }) {
  let wanted = null, scheduled = false, failure = '';
  const info = () => wanted ? { status: broker.draining ? 'draining' : 'pending',
    reason: failure || (broker.draining ? '共享后台正在空闲交接' : '后台更新将在全部会话空闲、审批与工作流结束后应用'),
    current: build.version, target: wanted.version } : null;
  async function drain() {
    scheduled = false;
    if (!wanted || broker.draining) return;
    const records = [...broker.records.values()];
    if (records.some(r => r.pendingCommands || r.starting || (!r.exited && !r.canTransfer().ok))) return;
    // Gate new work before the first await; never interrupt a running turn.
    broker.draining = true;
    try {
      await Promise.all(records.map(record => record.exited ? undefined : new Promise((resolve, reject) => {
        const session = record.session;
        const cleanup = () => { clearTimeout(timeout); session.off('exit', done); session.off('action-error', failed); };
        const done = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(new Error(String(error?.message || error))); };
        const timeout = setTimeout(() => failed('旧 writer 尚未确认释放，保留后台，未强制交接'), 15_000);
        timeout.unref?.();
        session.once('exit', done); session.once('action-error', failed);
        try { session.kill(); } catch (error) { failed(error); }
      })));
      for (const record of records) { clearTimeout(record.cleanupTimer); record.toolRoute?.dispose(); }
      broker.records.clear();
      await onReady();
    } catch (error) {
      // A partial close is not permission to start another writer. Keep the
      // service fenced and expose the reason instead of killing it on timeout.
      failure = '共享后台交接待核对：' + error.message;
      logger.warn('[broker-upgrade]', failure);
    }
  }
  function check() {
    if (!wanted || broker.draining || scheduled) return;
    scheduled = true; setImmediate(() => { void drain(); });
  }
  return {
    info, check,
    request(next) {
      if (next?.fingerprint && next.fingerprint !== build.fingerprint && compareVersion(next.version, wanted?.version || build.version) > 0) {
        wanted = { version: next.version, fingerprint: next.fingerprint };
      }
      check(); return info();
    },
  };
}
module.exports = { createBrokerUpgrade, compareVersion };
