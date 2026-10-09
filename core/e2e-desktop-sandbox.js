'use strict';

// Isolated E2E Hubs run on the same desktop the user is typing on. They must
// never take keyboard focus, draw over the user's windows, flash the taskbar,
// or overwrite the system clipboard (2026-09-26: test windows and clipboard
// writes kept interrupting conversations in the production Hub).
//
// Only active for an isolated data dir (the caller checks) and an explicit
// CLAUDE_HUB_E2E_WINDOW_MODE, so production launches are untouched.

// Far outside every monitor. The window still renders (occlusion throttling is
// switched off below), so CDP input, layout and screenshots behave as in a
// visible window.
const OFFSCREEN = { x: -24000, y: -24000 };

function prepareBackgroundChromium(app) {
  // An off-screen or covered window is otherwise treated as hidden: no frames,
  // no requestAnimationFrame, timers clamped to 1 Hz.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

function keepWindowInBackground(win) {
  if (!win || win.__hubBackgroundE2E) return win;
  win.__hubBackgroundE2E = true;
  const setBounds = win.setBounds.bind(win);
  const showInactive = win.showInactive.bind(win);
  const park = () => {
    try {
      const [width, height] = win.getSize();
      setBounds({ ...OFFSCREEN, width: Math.max(width, 1280), height: Math.max(height, 800) });
    } catch {}
  };
  try { win.setSkipTaskbar(true); } catch {}
  // WS_EX_NOACTIVATE at the OS level: also covers activation that never goes
  // through the JS methods below (a page calling window.focus(), native
  // ActivateContents). CDP input and focus emulation do not need OS focus.
  try { win.setFocusable(false); } catch {}
  park();
  // Every path that would activate, raise or move the window onto a monitor.
  win.show = () => { park(); showInactive(); };
  win.showInactive = win.show;
  win.focus = () => {};
  win.moveTop = () => {};
  win.maximize = () => {};
  win.setFullScreen = () => {};
  win.center = () => {};
  win.setPosition = () => {};
  win.setAlwaysOnTop = () => {};
  win.flashFrame = () => {};
  win.setBounds = (bounds = {}, animate) => setBounds({ ...win.getBounds(), ...bounds, ...OFFSCREEN }, animate);
  // Hub logic asks whether the user is looking at the window (notifications,
  // unread marks). A visible test window used to be focused, so keep that.
  win.isFocused = () => true;
  const contents = win.webContents;
  try { contents.setBackgroundThrottling(false); } catch {}
  // Page-level focus without OS focus: document.hasFocus(), focus/blur events
  // and :focus styles behave as in the foreground window.
  try {
    contents.debugger.attach('1.3');
    void contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  } catch {}
  return win;
}

// In-memory system clipboard shared by Main and every renderer of this Hub.
function createFakeClipboard(nativeImage) {
  let store;
  const clear = () => { store = { text: '', html: '', rtf: '', bookmark: null, image: null, buffers: new Map(), files: [] }; };
  clear();
  const api = {
    clear,
    readText: () => store.text,
    writeText: value => { clear(); store.text = String(value ?? ''); },
    readHTML: () => store.html,
    writeHTML: value => { clear(); store.html = String(value ?? ''); },
    readRTF: () => store.rtf,
    writeRTF: value => { clear(); store.rtf = String(value ?? ''); },
    readBookmark: () => store.bookmark || { title: '', url: '' },
    writeBookmark: (title, url) => { clear(); store.bookmark = { title: String(title ?? ''), url: String(url ?? '') }; store.text = String(url ?? ''); },
    readImage: () => store.image || nativeImage.createEmpty(),
    writeImage: image => { clear(); store.image = image; },
    readBuffer: format => store.buffers.get(String(format)) || Buffer.alloc(0),
    writeBuffer: (format, buffer) => { store.buffers.set(String(format), Buffer.from(buffer)); },
    write: (data = {}) => {
      clear();
      if (data.text != null) store.text = String(data.text);
      if (data.html != null) store.html = String(data.html);
      if (data.rtf != null) store.rtf = String(data.rtf);
      if (data.image) store.image = data.image;
      if (data.bookmark != null) store.bookmark = { title: String(data.bookmark), url: String(data.text ?? '') };
    },
    availableFormats: () => [
      store.text && 'text/plain', store.html && 'text/html', store.rtf && 'text/rtf',
      store.image && 'image/png', store.files.length && 'Files', ...store.buffers.keys(),
    ].filter(Boolean),
    has: format => api.availableFormats().includes(String(format)),
    // Stand-in for `Set-Clipboard -LiteralPath` (a native file drop list).
    writeFiles: paths => { clear(); store.files = paths.map(String); },
    readFiles: () => [...store.files],
  };
  return api;
}

const RENDERER_OPS = new Set([
  'clear', 'readText', 'writeText', 'readHTML', 'writeHTML', 'readRTF', 'writeRTF', 'readBookmark',
  'writeBookmark', 'readBuffer', 'writeBuffer', 'write', 'availableFormats', 'has', 'readFiles',
  'readImageDataURL', 'writeImageDataURL',
]);

let activeFake = null;
// Main-side code that writes the clipboard without Electron (file drop lists via
// PowerShell) checks this first.
function activeFakeClipboard() {
  return activeFake;
}

function installFakeClipboard({ clipboard, nativeImage, ipcMain }) {
  const fake = createFakeClipboard(nativeImage);
  activeFake = fake;
  for (const [name, fn] of Object.entries(fake)) {
    if (typeof clipboard[name] === 'function') clipboard[name] = fn;
  }
  ipcMain.on('e2e:fake-clipboard', (event, op, args = []) => {
    try {
      if (!RENDERER_OPS.has(op)) throw new Error(`unsupported clipboard op ${op}`);
      let value;
      if (op === 'readImageDataURL') value = fake.readImage().toDataURL();
      else if (op === 'writeImageDataURL') value = fake.writeImage(nativeImage.createFromDataURL(String(args[0] || '')));
      else if (op === 'write') {
        const data = { ...(args[0] || {}) };
        if (data.image) data.image = nativeImage.createFromDataURL(String(data.image));
        value = fake.write(data);
      } else value = fake[op](...args);
      event.returnValue = { value };
    } catch (error) {
      event.returnValue = { error: error.message };
    }
  });
  return fake;
}

module.exports = {
  OFFSCREEN,
  prepareBackgroundChromium,
  keepWindowInBackground,
  createFakeClipboard,
  installFakeClipboard,
  activeFakeClipboard,
};
