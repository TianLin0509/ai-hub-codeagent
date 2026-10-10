'use strict';
const { Terminal } = require('@xterm/headless');

// Short-lived command observer: the visible xterm may be empty, replaying, or
// hidden behind cards. Reconstruct PTY truth without opening/resizing the CLI.
async function openCommandScreen(ipcRenderer, sessionId) {
  const queued = [];
  let terminal, replayed = false, disposed = false;
  const listener = (_event, packet) => {
    if (disposed || packet.sessionId !== sessionId) return;
    if (!replayed) queued.push(packet);
    else terminal.write(packet.data);
  };
  const dispose = () => {
    disposed = true;
    ipcRenderer.removeListener('terminal-data', listener);
    terminal?.dispose();
  };
  ipcRenderer.on('terminal-data', listener);
  try {
    const snapshot = await ipcRenderer.invoke('get-session-buffer-snapshot', sessionId);
    if (!snapshot || typeof snapshot.text !== 'string') throw new Error('无法读取 CLI 当前画面，请稍后重试');
    terminal = new Terminal({ cols: snapshot.baseCols || snapshot.cols || 120,
      rows: snapshot.baseRows || snapshot.rows || 30, scrollback: 0, allowProposedApi: true });
    const write = data => new Promise(resolve => terminal.write(data || '', resolve));
    await write(snapshot.text);
    for (const op of snapshot.operations || []) {
      if (op.type === 'resize') terminal.resize(op.cols, op.rows);
      else if (op.type === 'write') await write(op.data);
    }
    while (queued.length) {
      for (const packet of queued.splice(0)) {
        if (!packet.seq || packet.seq > snapshot.seq) await write(packet.data);
      }
    }
    replayed = true;
    return { dispose, text() {
      const b = terminal.buffer.active;
      const text = Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) || '').join('\n');
      return require('./command-screen-frame').groupInputTuningFrame(text);
    } };
  } catch (error) { dispose(); throw error; }
}
module.exports = { openCommandScreen };
