'use strict';

// Isolated E2E only (Main sets CLAUDE_HUB_E2E_FAKE_CLIPBOARD_ACTIVE after
// checking the data dir): every clipboard read/write in this renderer goes to
// Main's in-memory clipboard, never the user's system clipboard. See
// core/e2e-desktop-sandbox.js.
function installRendererFakeClipboard({ electron, navigator }) {
  const { clipboard, ipcRenderer, nativeImage } = electron;
  const call = (op, ...args) => {
    const reply = ipcRenderer.sendSync('e2e:fake-clipboard', op, args);
    if (reply && reply.error) throw new Error(reply.error);
    return reply ? reply.value : undefined;
  };
  const replacements = {
    clear: () => call('clear'),
    readText: () => call('readText'),
    writeText: value => call('writeText', String(value ?? '')),
    readHTML: () => call('readHTML'),
    writeHTML: value => call('writeHTML', String(value ?? '')),
    readRTF: () => call('readRTF'),
    writeRTF: value => call('writeRTF', String(value ?? '')),
    readBookmark: () => call('readBookmark'),
    writeBookmark: (title, url) => call('writeBookmark', title, url),
    readBuffer: format => Buffer.from(call('readBuffer', format) || []),
    writeBuffer: (format, buffer) => call('writeBuffer', format, Buffer.from(buffer)),
    readImage: () => nativeImage.createFromDataURL(call('readImageDataURL') || ''),
    writeImage: image => call('writeImageDataURL', image && image.toDataURL ? image.toDataURL() : ''),
    write: (data = {}) => call('write', { ...data, image: data.image && data.image.toDataURL ? data.image.toDataURL() : undefined }),
    availableFormats: () => call('availableFormats'),
    has: format => call('has', format),
  };
  for (const [name, fn] of Object.entries(replacements)) {
    if (typeof clipboard[name] === 'function') clipboard[name] = fn;
  }
  if (navigator && navigator.clipboard) {
    navigator.clipboard.writeText = async value => { call('writeText', String(value ?? '')); };
    navigator.clipboard.readText = async () => call('readText');
  }
  return replacements;
}

module.exports = { installRendererFakeClipboard };
