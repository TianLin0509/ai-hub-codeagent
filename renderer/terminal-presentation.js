'use strict';

// Recognize only the native bridge's exact opening banner. Anything else,
// including diagnostics, belongs to xterm and must be visible immediately.
const OPENING_BANNER = 'Codex 已连接。请使用 Hub 输入框发送消息。'.replace(/\s/g, '');
function classifyOpeningOutput(terminal, openingBanner = OPENING_BANNER) {
  const expected = openingBanner.replace(/\s/g, '');
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal' || buffer.baseY > 0 || buffer.cursorY >= 8) return 'output';
  let text = '';
  for (let i = 0; i < Math.min(buffer.length, 8); i++) {
    text += buffer.getLine(i)?.translateToString(true) || '';
  }
  text = text.replace(/\s/g, '');
  if (text === expected) return 'welcome';
  return expected.startsWith(text) ? 'pending' : 'output';
}

function mountTerminalPresentation({ document, host, cached, native, readOnly, focusComposer, openingBanner, engine = 'Codex' }) {
  host.classList.add('pty-surface');
  cached.container.classList.add('terminal-output-host');

  let welcome = null;
  let subscription = null;
  if (native && !cached._ptyHasOutput && !readOnly) {
    welcome = document.createElement('section');
    welcome.className = 'pty-presentation pty-welcome';
    welcome.hidden = true;
    welcome.setAttribute('aria-label', '输出视图欢迎页');
    welcome.innerHTML = '<div class="pty-welcome-body">'
      + '<div class="pty-welcome-mark" aria-hidden="true"><span>›</span><i></i></div>'
      + '<div class="pty-welcome-eyebrow">CODEX · 输出视图</div>'
      + '<h2>让想法开始运行</h2>'
      + '<p>在下方写下任务，<br>执行过程与输出会在这里展开。</p>'
      + '<button type="button" class="pty-welcome-compose">开始输入 <span aria-hidden="true">↗</span></button>'
      + '<div class="pty-welcome-hint">此处用于阅读输出，消息从 Hub 输入框发送</div></div>';
    welcome.querySelector('.pty-welcome-eyebrow').textContent = engine+' · 输出视图';
    welcome.querySelector('button').addEventListener('click', event => {
      event.stopPropagation();
      focusComposer();
    });
    host.appendChild(welcome);
    const update = () => {
      const state = classifyOpeningOutput(cached.terminal, openingBanner);
      const show = state === 'welcome';
      welcome.hidden = !show;
      host.classList.toggle('pty-awaiting-output', show);
      if (state === 'output') {
        cached._ptyHasOutput = true;
        subscription?.dispose();
        subscription = null;
      }
    };
    // Once real output appears, stop inspecting the buffer altogether.
    subscription = cached.terminal.onWriteParsed(update);
    update();
  }
  return {
    dispose() {
      subscription?.dispose();
      subscription = null;
      welcome?.remove();
      host.classList.remove('pty-awaiting-output', 'pty-surface');
    },
  };
}

module.exports = { classifyOpeningOutput, mountTerminalPresentation };
