'use strict';

// Ctrl + mouse wheel zooms what is under the pointer, as in a browser
// (2026-10-14 用户: cards, immersive reading and preview). It shares the
// settings of Ctrl+= / Ctrl+- / Ctrl+0:
//   - terminal / backstage output: terminal font size;
//   - everything else in the Hub (session cards, group chat, immersive
//     reading): the reading size, which scales the cards through --main-zoom.
// The preview handles its own wheel zoom (and an embedded page's wheel arrives
// from the main process), so an event it already took is left alone.
// A mouse notch is 100 px at 100% but shrinks with any zoom around the target
// (83 px with the Hub's UI at 120%, 91 px inside a preview at 110%), so one
// event of half a notch or more is one step, and never more than one.
// Touchpads send many small deltas; they add up to half a notch first.
const NOTCH = 50;
const IDLE_RESET_MS = 400;
const LABEL_MS = 900;

function wheelDeltaPixels(event) {
  if (event.deltaMode === 1) return event.deltaY * 33;
  if (event.deltaMode === 2) return event.deltaY * 800;
  return event.deltaY;
}

function createWheelStepper({ notch = NOTCH, idleResetMs = IDLE_RESET_MS, now = () => Date.now() } = {}) {
  let pending = 0, lastAt = 0;
  // Returns +n to zoom in, -n to zoom out, 0 while a notch is still building.
  return delta => {
    const t = now();
    if (t - lastAt > idleResetMs || Math.sign(delta) !== Math.sign(pending)) pending = 0;
    lastAt = t;
    pending += delta;
    if (Math.abs(pending) < notch) return 0;
    const step = pending < 0 ? 1 : -1;
    pending = 0;
    return step;
  };
}

function createZoomLabel(doc) {
  let el = null, timer = null;
  return {
    show(text, rect) {
      if (!el) {
        el = doc.createElement('div');
        el.className = 'hub-zoom-label';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        doc.body.append(el);
      }
      el.textContent = text;
      const box = rect && rect.width ? rect : { left: 0, top: 0, width: doc.defaultView.innerWidth };
      el.style.left = `${Math.round(box.left + box.width / 2)}px`;
      el.style.top = `${Math.round(Math.max(0, box.top) + 14)}px`;
      el.hidden = false;
      el.classList.add('visible');
      clearTimeout(timer);
      timer = setTimeout(() => { el.classList.remove('visible'); }, LABEL_MS);
    },
  };
}

function installCtrlWheelZoom({
  window: win, document: doc,
  getReadingSize, setReadingSize, getTerminalSize, setTerminalSize,
  defaultReadingSize = 16,
}) {
  const stepper = createWheelStepper();
  const label = createZoomLabel(doc);
  const terminalOf = event => (event.target && event.target.closest ? event.target.closest('.xterm, .codex-backstage') : null);
  // xterm consumes wheel events to scroll; take Ctrl + wheel before it does.
  win.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    const terminal = terminalOf(event);
    if (!terminal) return;
    event.preventDefault();
    event.stopPropagation();
    const steps = stepper(wheelDeltaPixels(event));
    if (!steps) return;
    setTerminalSize(getTerminalSize() + steps);
    label.show(`终端字号 ${getTerminalSize()}`, terminal.getBoundingClientRect());
  }, { capture: true, passive: false });
  win.addEventListener('wheel', event => {
    if (!event.ctrlKey || event.defaultPrevented) return;
    // Never let Chromium zoom the whole window; the Hub decides what grows.
    event.preventDefault();
    const steps = stepper(wheelDeltaPixels(event));
    if (!steps) return;
    const target = event.target && event.target.closest ? event.target : null;
    setReadingSize(getReadingSize() + steps);
    const area = target && target.closest('.msg-overlay, #meeting-room-panel, .terminal-panel, .gms-member-view');
    label.show(`阅读缩放 ${Math.round(getReadingSize() / defaultReadingSize * 100)}%`, area ? area.getBoundingClientRect() : null);
  }, { passive: false });
  return { label };
}

module.exports = { installCtrlWheelZoom, createWheelStepper, wheelDeltaPixels, createZoomLabel };
