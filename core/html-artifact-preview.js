'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const PREVIEW_WIDTH = 1200;
const PREVIEW_HEIGHT = 675;
const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60_000;

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalRequestPath(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isAllowedPreviewRequest(requestUrl, artifactRoot) {
  let parsed;
  try { parsed = new URL(String(requestUrl || '')); } catch { return false; }
  if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return true;
  if (parsed.protocol !== 'file:') return false;
  try {
    return isPathInside(canonicalRequestPath(fileURLToPath(parsed)), canonicalRequestPath(artifactRoot));
  } catch {
    return false;
  }
}

function withTimeout(promise, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function previewCacheName(filePath, stat) {
  return `${crypto.createHash('sha256')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 32)}.png`;
}

async function prunePreviewCache(outputDir, now = Date.now()) {
  let entries = [];
  try { entries = await fs.promises.readdir(outputDir, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !/^[a-f0-9]{32}\.png$/i.test(entry.name)) return;
    const candidate = path.join(outputDir, entry.name);
    try {
      const stat = await fs.promises.stat(candidate);
      if (now - stat.mtimeMs > PREVIEW_RETENTION_MS) await fs.promises.unlink(candidate);
    } catch {}
  }));
}

function createHtmlArtifactPreviewRenderer(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
  const getOutputDir = typeof options.getOutputDir === 'function'
    ? options.getOutputDir
    : () => options.outputDir;
  const logger = options.logger || console;
  const loadTimeoutMs = Math.max(1_000, Number(options.loadTimeoutMs) || 12_000);

  return async function renderHtmlArtifactPreview(filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      const error = new Error('preview_not_file');
      error.code = 'preview_not_file';
      throw error;
    }
    const artifactPath = canonicalRequestPath(filePath);
    const artifactRoot = path.dirname(artifactPath);
    const configuredOutputRoot = String(getOutputDir() || '').trim();
    if (!configuredOutputRoot) {
      const error = new Error('preview_output_missing');
      error.code = 'preview_output_missing';
      throw error;
    }
    const outputRoot = path.resolve(configuredOutputRoot);
    const outputDir = path.join(outputRoot, 'notification-previews');
    await fs.promises.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, previewCacheName(artifactPath, stat));
    try {
      const cached = await fs.promises.stat(outputPath);
      if (cached.isFile() && cached.size > 0) return outputPath;
    } catch {}

    const partition = `hub-notification-preview-${crypto.randomBytes(10).toString('hex')}`;
    const win = new BrowserWindow({
      show: false,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      useContentSize: true,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        partition,
        offscreen: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
        disableDialogs: true,
      },
    });
    const webContents = win.webContents;
    const electronSession = webContents.session;
    const fileUrl = pathToFileURL(artifactPath).href;
    const downloadListener = (event) => event.preventDefault();
    const navigationListener = (event, url) => {
      if (String(url).split('#')[0] !== fileUrl.split('#')[0]) event.preventDefault();
    };

    try {
      webContents.setAudioMuted?.(true);
      webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      webContents.on?.('will-navigate', navigationListener);
      webContents.on?.('will-attach-webview', event => event.preventDefault());
      electronSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
      electronSession.on?.('will-download', downloadListener);
      electronSession.webRequest.onBeforeRequest(
        { urls: ['<all_urls>'] },
        (details, callback) => callback({ cancel: !isAllowedPreviewRequest(details.url, artifactRoot) }),
      );

      await withTimeout(win.loadURL(fileUrl), loadTimeoutMs, 'preview_load_timeout');
      try {
        await withTimeout(webContents.executeJavaScript(
          'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
          true,
        ), 1_500, 'preview_fonts_timeout');
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 120));
      const image = await withTimeout(webContents.capturePage(), 5_000, 'preview_capture_timeout');
      if (!image || image.isEmpty?.()) {
        const error = new Error('preview_empty_image');
        error.code = 'preview_empty_image';
        throw error;
      }
      const normalizedImage = typeof image.resize === 'function'
        ? image.resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, quality: 'best' })
        : image;
      const png = normalizedImage.toPNG();
      if (!Buffer.isBuffer(png) || png.length === 0) {
        const error = new Error('preview_empty_png');
        error.code = 'preview_empty_png';
        throw error;
      }
      const tempPath = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.writeFile(tempPath, png);
      try {
        await fs.promises.rename(tempPath, outputPath);
      } catch (error) {
        try { await fs.promises.unlink(tempPath); } catch {}
        if (error && error.code !== 'EEXIST') throw error;
      }
      prunePreviewCache(outputDir).catch(error => {
        try { logger.warn('[completion-notifier] preview cache prune failed:', error && error.code || 'unknown'); } catch {}
      });
      return outputPath;
    } finally {
      try { electronSession.webRequest.onBeforeRequest(null); } catch {}
      try { electronSession.removeListener?.('will-download', downloadListener); } catch {}
      try { webContents.removeListener?.('will-navigate', navigationListener); } catch {}
      try { if (!win.isDestroyed?.()) win.destroy(); } catch {}
    }
  };
}

module.exports = {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  createHtmlArtifactPreviewRenderer,
  isAllowedPreviewRequest,
  isPathInside,
  previewCacheName,
  prunePreviewCache,
};
