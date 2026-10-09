'use strict';

const os = require('node:os');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

function writeTerminal(terminal, text) {
  if (!text) return Promise.resolve();
  return new Promise(resolve => terminal.write(String(text), resolve));
}

function terminalOptions(cols, rows, scrollback) {
  return {
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    ...(process.platform === 'win32' ? {
      windowsPty: {
        backend: 'conpty',
        buildNumber: parseInt(os.release().split('.').pop(), 10) || 0,
      },
    } : {}),
  };
}

async function compact(job = {}) {
  const terminal = new Terminal(terminalOptions(
    Math.max(2, Number(job.baseCols) || 120),
    Math.max(1, Number(job.baseRows) || 30),
    Math.max(0, Number(job.scrollback) || 0),
  ));
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  try {
    await writeTerminal(terminal, job.base);
    for (const operation of Array.isArray(job.operations) ? job.operations : []) {
      if (operation.type === 'resize') {
        const cols = Math.max(2, Number(operation.cols) || terminal.cols);
        const rows = Math.max(1, Number(operation.rows) || terminal.rows);
        if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      } else if (operation.type === 'write') {
        await writeTerminal(terminal, operation.data);
      }
    }
    return Buffer.from(
      addon.serialize({ scrollback: Math.max(0, Number(job.scrollback) || 0) }),
      'utf8',
    ).toString('utf8');
  } finally {
    try { addon.dispose(); } catch {}
    try { terminal.dispose(); } catch {}
  }
}

process.once('message', (job) => {
  compact(job)
    .then((base) => {
      if (typeof process.send === 'function') {
        process.send({ ok: true, base }, () => process.disconnect?.());
      }
    })
    .catch((error) => {
      if (typeof process.send === 'function') {
        process.send({
          ok: false,
          error: error && error.message ? error.message : String(error),
        }, () => process.disconnect?.());
      }
    });
});
