const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
// Codex 偶尔会把 Windows 路径写成 C:\\Users\\...、C:Users\...，或输出
// 含空格的绝对路径。原 ABS_PATH_RE 对这些都会漏掉。这个补充表达式只负责
// Windows drive 路径；匹配范围仍以“文件扩展名”收口，避免把整段普通句子吞掉。
const WINDOWS_FILE_PATH_RE = /(?<![A-Za-z0-9])(?:[\\/]?[A-Za-z]:(?:[\\/]+|(?=[^\\/\s'"`<>|]+[\\/])))(?:[^\\/:*?"<>|'`\r\n]+[\\/]+)*[^\\/:*?"<>|'`\r\n]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
const WINDOWS_PATH_TOKEN_RE = /(?<![A-Za-z0-9])(?:[\\/]?[A-Za-z]:(?:[\\/]+|(?=[^\\/\s'"`<>|]+[\\/])))(?:[^\\/:*?"<>|'`\s()[\],;!]+[\\/]+)*[^\\/:*?"<>|'`\s()[\],;!]+[\\/]?/g;
// Full-width colon is a frequent Chinese prose separator ("路径：docs/a.md"),
// not part of the relative path. Excluding it prevents the regex from greedily
// starting at the label and resolving a nonexistent "路径：docs/..." token.
const REL_PATH_RE = /(?<![^:*?"<>|\r\n\s：])(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n\s：]+[\\/])+[^\\/:*?"<>|\r\n\s：]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
const ABS_DIR_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n]+[\\/])+[^\\/:*?"<>|\r\n]+[\\/]?/g;
const REL_DIR_RE = /(?<![^:*?"<>|\r\n：])(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n：]+[\\/]){1,}[^\\/:*?"<>|\r\n：]+[\\/]?/g;
const REL_BARE_RE = /(?<![^\\/:*?"<>|\r\n\s])[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![\w.-])|(?<![^\\/:*?"<>|\r\n\s])[^\\/:*?"<>|\r\n\s.]{2,}(?![\w.-])/g;
const URL_RE = /\bhttps?:\/\/[\w\-.~]+(?::\d+)?(?:[\/?#][^\s<>"'`\\]*)?/g;
const FILE_URL_RE = /\bfile:\/\/[^\s<>"'`]+/gi;
const PREVIEW_PATH_RE = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp|svg|pdf|csv|tsv|json|jsonl|js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|txt|log|ya?ml|toml|ini|cfg|conf|sh|bat|ps1|xml|sql|r|rb|php|swift|kt|lua|zig|asm|css|scss|less)$/i;
const HUB_IMG_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\.ai-hub-community[\\/]images[\\/][^\s]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

const REL_PATH_CACHE = new Map();
const REL_PATH_CACHE_MAX = 256;
const REL_PATH_CACHE_TTL_MS = 5000;

function _cleanPathCandidate(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, '').trim();
  s = s.replace(/^[`'"\u201c\u201d\u2018\u2019(<\[]+/, '');
  s = s.replace(/[`'"\u201c\u201d\u2018\u2019)>.,;:!\]]+$/, '');
  return s;
}

function _expandHomePath(filePath) {
  if (/^~[\\/]/.test(filePath)) {
    try { return path.join(os.homedir(), filePath.slice(2)); } catch {}
  }
  return filePath;
}

function _decodePathCandidate(value) {
  const raw = String(value || '');
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// 修正 AI 常见的“看起来像 Windows 绝对路径、但分隔符写错”情形。
// 只在 drive/UNC 形态上动刀；普通相对路径保持原样，避免改变用户真实语义。
function _repairLocalPathCandidate(raw) {
  let s = _cleanPathCandidate(_decodePathCandidate(raw));
  if (!s) return s;

  // Markdown/file URL 有时会留下 /C:/... 形态。
  s = s.replace(/^[\\/](?=[A-Za-z]:[\\/])/, '');

  if (/^[A-Za-z]:/.test(s)) {
    // C:Users\me\a.md 在 Hub 的使用语境里几乎总是漏了根分隔符，而不是
    // 有意使用 Windows 的 drive-relative 语义。仅当后文仍有分隔符时修正。
    if (/^[A-Za-z]:[^\\/]/.test(s) && /[\\/]/.test(s.slice(2))) {
      s = s.slice(0, 2) + '\\' + s.slice(2);
    }
    s = s.slice(0, 2) + s.slice(2).replace(/[\\/]+/g, '\\');
    try { return path.win32.normalize(s); } catch { return s; }
  }

  if (/^[\\/]{2,}/.test(s)) {
    const rest = s.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '\\');
    try { return path.win32.normalize('\\\\' + rest); } catch { return '\\\\' + rest; }
  }
  return s;
}

function _isAbsLocalPath(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath)
    || /^\\\\[^\\/:*?"<>|\r\n\s]+\\/.test(filePath)
    || /^~[\\/]/.test(filePath);
}

function _statPathQuiet(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function _normalizeLocalPathForOpen(openPath, cwd, requireExistsForRel = true) {
  let p = _repairLocalPathCandidate(openPath);
  if (!p) return null;
  p = _expandHomePath(p);
  if (_isAbsLocalPath(p)) return p;
  if (!cwd) return null;
  let abs = null;
  try { abs = path.resolve(cwd, p); } catch { return null; }
  if (requireExistsForRel && !fs.existsSync(abs)) return null;
  return abs;
}

function classifyLocalPathHref(href, cwd = null) {
  let displayPath = _cleanPathCandidate(_decodePathCandidate(href));
  if (!displayPath) return null;
  if (/^(?:https?:|mailto:|data:|javascript:|#)/i.test(displayPath)) return null;

  if (/^file:/i.test(displayPath)) {
    try {
      const openPath = _repairLocalPathCandidate(fileURLToPath(displayPath));
      return openPath ? { displayPath, openPath } : null;
    } catch {
      return null;
    }
  }

  const repaired = _repairLocalPathCandidate(displayPath);
  if (_isAbsLocalPath(repaired)) {
    return { displayPath, openPath: repaired };
  }

  // Markdown 的相对 href 没有 URL scheme。仅把明确的本地路径形态升级，
  // 普通网页相对链接/锚点继续保留 marked 的默认行为。
  const looksRelative = /^\.{1,2}[\\/]/.test(displayPath)
    || /[\\/]/.test(displayPath)
    || PREVIEW_PATH_RE.test(displayPath);
  if (!looksRelative || /^[\\/]/.test(displayPath)) return null;
  const openPath = cwd
    ? _normalizeLocalPathForOpen(displayPath, cwd, false)
    : displayPath;
  return openPath ? { displayPath, openPath } : null;
}

function _isDirectoryPath(filePath) {
  const st = _statPathQuiet(filePath);
  return !!(st && st.isDirectory());
}

function _resolveRelPathIfExists(cwd, relPath) {
  const key = `${cwd}|${relPath}`;
  const now = Date.now();
  const hit = REL_PATH_CACHE.get(key);
  if (hit && now - hit.ts < REL_PATH_CACHE_TTL_MS) {
    REL_PATH_CACHE.delete(key);
    REL_PATH_CACHE.set(key, hit);
    return hit.absPath;
  }
  let absPath = null;
  try {
    const candidate = path.resolve(cwd, relPath);
    if (fs.existsSync(candidate)) absPath = candidate;
  } catch {}
  REL_PATH_CACHE.set(key, { absPath, ts: now });
  if (REL_PATH_CACHE.size > REL_PATH_CACHE_MAX) {
    const oldestKey = REL_PATH_CACHE.keys().next().value;
    REL_PATH_CACHE.delete(oldestKey);
  }
  return absPath;
}

function _addCandidate(candidates, start, end, openPath, isUrl = false) {
  if (!openPath || end < start) return;
  const overlapsExisting = candidates.some(c => !(end < c.start || start > c.end));
  if (overlapsExisting) return;
  candidates.push({ start, end, openPath, isUrl });
}

function collectPathCandidates(text, cwd = null, opts = {}) {
  const candidates = [];
  text = String(text || '');
  let m;
  FILE_URL_RE.lastIndex = 0;
  while ((m = FILE_URL_RE.exec(text))) {
    const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const openPath = _repairLocalPathCandidate(fileURLToPath(trimmed));
      if (openPath) _addCandidate(candidates, m.index, m.index + trimmed.length - 1, openPath);
    } catch {
      // A malformed file URL is not upgraded into a clickable local path.
    }
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (trimmed.length >= 'http://x'.length) {
      _addCandidate(candidates, m.index, m.index + trimmed.length - 1, trimmed, true);
    }
  }

  WINDOWS_FILE_PATH_RE.lastIndex = 0;
  while ((m = WINDOWS_FILE_PATH_RE.exec(text))) {
    const raw = _cleanPathCandidate(m[0]);
    const repaired = _repairLocalPathCandidate(raw);
    if (repaired) {
      _addCandidate(candidates, m.index, m.index + m[0].length - 1, repaired);
    }
  }

  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(text))) {
    _addCandidate(candidates, m.index, m.index + m[0].length - 1, _repairLocalPathCandidate(m[0]));
  }

  if (opts.includeDirectories !== false) {
    WINDOWS_PATH_TOKEN_RE.lastIndex = 0;
    while ((m = WINDOWS_PATH_TOKEN_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const fullPath = _repairLocalPathCandidate(raw);
      if (fullPath && _isDirectoryPath(fullPath)) {
        _addCandidate(candidates, m.index, m.index + m[0].length - 1, fullPath);
      }
    }

    ABS_DIR_RE.lastIndex = 0;
    while ((m = ABS_DIR_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const fullPath = _normalizeLocalPathForOpen(raw, cwd, false);
      if (fullPath && _isDirectoryPath(fullPath)) {
        _addCandidate(candidates, m.index, m.index + m[0].length - 1, fullPath);
      }
    }
  }

  if (cwd) {
    REL_PATH_RE.lastIndex = 0;
    while ((m = REL_PATH_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const absPath = _resolveRelPathIfExists(cwd, raw);
      if (absPath) _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
    }

    if (opts.includeDirectories !== false) {
      REL_DIR_RE.lastIndex = 0;
      while ((m = REL_DIR_RE.exec(text))) {
        const raw = _cleanPathCandidate(m[0]);
        if (PREVIEW_PATH_RE.test(raw)) continue;
        const absPath = _resolveRelPathIfExists(cwd, raw);
        if (absPath && _isDirectoryPath(absPath)) {
          _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
        }
      }
    }

    REL_BARE_RE.lastIndex = 0;
    while ((m = REL_BARE_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const absPath = _resolveRelPathIfExists(cwd, raw);
      if (!absPath) continue;
      const st = _statPathQuiet(absPath);
      if (!st) continue;
      if (st.isDirectory() || PREVIEW_PATH_RE.test(absPath)) {
        _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
      }
    }
  }

  return candidates.sort((a, b) => a.start - b.start);
}

module.exports = {
  ABS_PATH_RE,
  WINDOWS_FILE_PATH_RE,
  WINDOWS_PATH_TOKEN_RE,
  REL_PATH_RE,
  ABS_DIR_RE,
  REL_DIR_RE,
  REL_BARE_RE,
  URL_RE,
  FILE_URL_RE,
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  _cleanPathCandidate,
  _repairLocalPathCandidate,
  _expandHomePath,
  _isAbsLocalPath,
  _statPathQuiet,
  _normalizeLocalPathForOpen,
  classifyLocalPathHref,
  _isDirectoryPath,
  _resolveRelPathIfExists,
};
