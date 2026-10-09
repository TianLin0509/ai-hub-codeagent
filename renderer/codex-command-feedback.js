'use strict';

function createCodexCommandFeedback(doc, host) {
  const panel = doc.createElement('section');
  panel.className = 'codex-command-feedback'; panel.hidden = true;
  panel.setAttribute('role', 'status');
  const header = doc.createElement('div'), title = doc.createElement('strong'), close = doc.createElement('button');
  const body = doc.createElement('pre');
  close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '收起命令结果');
  close.addEventListener('click', () => { panel.hidden = true; });
  header.append(title, close); panel.append(header, body); host.append(panel);
  return { show(command, text, failed = false) {
    title.textContent = command.split(/\s/)[0] + (failed ? ' · 未执行' : ' · 命令结果');
    body.textContent = text;
    panel.classList.toggle('failed', failed); panel.hidden = false;
  }, clear() { panel.hidden = true; } };
}

module.exports = { createCodexCommandFeedback };
