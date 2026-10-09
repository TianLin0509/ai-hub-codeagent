'use strict';

const { SessionSearchEngine } = require('./session-search-engine.js');

let engine = null;
let closing = false;

function withRuntime(status) {
  const memory = process.memoryUsage();
  return {
    ...(status || {}),
    runtime: {
      pid: process.pid,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
    },
  };
}

function send(message) {
  try { if (process.connected) process.send(message); } catch {}
}

function fatal(error) {
  send({ type: 'fatal', error: error && error.message ? error.message : String(error) });
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}

async function handle(message = {}) {
  if (message.type === 'init') {
    if (engine) return withRuntime(engine.status());
    engine = new SessionSearchEngine(message.options || {}, status => send({ type: 'status', status: withRuntime(status) }));
    return withRuntime(engine.status());
  }
  if (message.type === 'close') {
    closing = true;
    if (engine) await engine.close();
    engine = null;
    return { closed: true };
  }
  if (!engine) throw new Error('session search child is not initialized');
  if (message.type === 'status') return withRuntime(engine.status());
  if (message.type === 'refresh') return engine.refresh(message.snapshot || {}, { force: message.force === true, immediate: message.immediate === true });
  if (message.type === 'search') return engine.search(message.request || {}, message.snapshot || {});
  if (message.type === 'preview') return engine.preview(message.request || {});
  if (message.type === 'memory-candidates') return require('./memory-history').candidates(engine.index, message.request || {});
  if (message.type === 'memory-export') return require('./memory-history').exportHistory(engine.index, { ...(message.request || {}), transcriptDir: engine.options.transcriptDir });
  if (message.type === 'transcript') return engine.transcriptFor(message.request || {});
  throw new Error(`Unknown session-search child message: ${message.type}`);
}

process.on('message', message => {
  Promise.resolve(handle(message))
    .then(result => {
      send({ id: message && message.id, result });
      if (message && message.type === 'close') {
        try { process.disconnect(); } catch {}
        setImmediate(() => process.exit(0));
      }
    })
    .catch(error => {
      if (message && message.type === 'init') fatal(error);
      else send({ id: message && message.id, error: error && error.message ? error.message : String(error) });
    });
});

process.on('disconnect', () => {
  if (closing) return;
  try { if (engine) engine.close(); } catch {}
  process.exit(0);
});
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
