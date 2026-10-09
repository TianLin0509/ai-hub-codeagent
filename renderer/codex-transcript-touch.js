'use strict';

// xterm touch scrolling moves its local scrollback. A fullscreen Codex TUI
// owns the history instead, so feed single-finger vertical drags into the
// same mouse-wheel path as a physical wheel (including footer hit routing).
function attachCodexTranscriptTouch({ container, terminal, ownsTranscript, WheelEvent }) {
  let gesture = null;
  const reset = () => { gesture = null; };
  const start = event => {
    reset();
    if (!ownsTranscript() || event.touches.length !== 1) return;
    const t = event.touches[0];
    gesture = { id: t.identifier, x: t.clientX, y: t.clientY, lastY: t.clientY, dragging: false };
  };
  const move = event => {
    if (!gesture || !ownsTranscript() || event.touches.length !== 1) { reset(); return; }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) { reset(); return; }
    if (!gesture.dragging) {
      const dx = Math.abs(touch.clientX - gesture.x), dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
      if (dx >= dy) { reset(); return; }
      gesture.dragging = true;
    }
    const viewport = terminal.element?.querySelector('.xterm-viewport');
    if (!viewport) { reset(); return; }
    const deltaY = gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    event.preventDefault();
    event.stopPropagation();
    if (deltaY) viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY, deltaMode: 0,
      clientX: touch.clientX, clientY: touch.clientY,
    }));
  };
  const options = { capture: true, passive: false };
  container.addEventListener('touchstart', start, options);
  container.addEventListener('touchmove', move, options);
  container.addEventListener('touchend', reset, options);
  container.addEventListener('touchcancel', reset, options);
  return () => {
    for (const [type, fn] of [['touchstart', start], ['touchmove', move], ['touchend', reset], ['touchcancel', reset]]) {
      container.removeEventListener(type, fn, options);
    }
    reset();
  };
}

module.exports = { attachCodexTranscriptTouch };
