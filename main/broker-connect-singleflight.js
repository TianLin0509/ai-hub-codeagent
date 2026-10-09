'use strict';
const path = require('path');
// Concurrent card restores share service discovery/startup. Connections stay
// independently ordered, including their content baselines and control owner.
function createBrokerConnector(connect, connectExisting) {
  const starting = new Map();
  return async function acquire(options) {
    const resolved = path.resolve(options.dataDir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const pending = starting.get(key);
    if (pending) {
      const first = await pending;
      return connectExisting(resolved, first.metadata);
    }
    const task = Promise.resolve().then(() => connect({...options, dataDir:resolved}));
    starting.set(key, task);
    try { return await task; }
    finally { if (starting.get(key) === task) starting.delete(key); }
  };
}
module.exports = { createBrokerConnector };
