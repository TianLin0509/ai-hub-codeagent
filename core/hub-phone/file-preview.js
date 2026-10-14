'use strict';
// 手机上预览会话里提到的本机文件（App 2.1.1，2026-10-13 用户：「对话中的 html、png 能否也在手机上打开预览？
// 点击后再向电脑请求……本机只缓存最新的 10 个文件」）。
// 只发这个会话卡片里出现过的路径；只认网页与图片；手机带上它缓存的版本（修改时间、大小、指纹），
// 电脑上没变就只回「未变化」，手机直接用缓存。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const PAGE = { '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml' };
const EXTS = Object.keys(IMAGE).concat(Object.keys(PAGE));
// 云中继单条上限 8MB，消息加密后再做一次 base64（约 ×1.34），明文 JSON 控制在 5.4MB 以内。
const BUDGET = Math.floor(5.4 * 1024 * 1024);
const IMAGE_RAW_MAX = Math.floor(3.8 * 1024 * 1024);   // 原图不超过这个就原样发（base64 后约 5.1MB）
const LONG_EDGE = 2400;
const READ_MAX = 60 * 1024 * 1024;
const PATH_RE = /[A-Za-z]:[\\/][^\s`'"<>|*?\r\n，。；：）」】]+?\.(?:html?|png|jpe?g|gif|webp|svg)(?![A-Za-z0-9])/gi;

function norm(p) { return String(p || '').replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase(); }

// 卡片文字与工具参数里出现过的 Windows 绝对路径（只认上面的扩展名）。
// 返回 Map：规范化小写路径 → 原样路径（显示用）。
function mentionedPaths(texts) {
  const out = new Map();
  for (const t of texts) for (const m of String(t || '').replace(/\\\\/g, '\\').matchAll(PATH_RE)) {
    const p = path.win32.normalize(m[0]), k = norm(p);
    if (!out.has(k)) out.set(k, p);
  }
  return out;
}

function turnTexts(turns) {
  const texts = [];
  for (const t of turns || []) {
    texts.push(t.text || '');
    for (const c of Array.isArray(t.toolCalls) ? t.toolCalls : []) {
      try { texts.push(JSON.stringify(c.input || {})); } catch {}
      if (typeof c.result === 'string') texts.push(c.result.slice(0, 20000));
    }
  }
  return texts;
}

// 路径本身的合法性：本机盘符绝对路径、无 .. 段、扩展名在白名单里。返回规范化后的路径或抛出人话错误。
function checkPath(raw) {
  const p = String(raw || '').trim();
  if (!/^[A-Za-z]:[\\/]/.test(p) || p.length > 1000) throw Error('只能预览电脑本机磁盘上的文件');
  if (p.split(/[\\/]/).some(seg => seg === '..')) throw Error('文件路径无效');
  const file = path.win32.normalize(p);
  const ext = path.extname(file).toLowerCase();
  if (!EXTS.includes(ext)) throw Error('手机上只能预览网页和图片（html、png、jpg、gif、webp、svg）');
  return file;
}

function fingerprint(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32); }

// 网页里相对路径（或本机绝对路径）引用的图片、样式、脚本内联进来，手机离线也能看全；外链保持原样。
function inlineHtml(html, file, budget) {
  const dir = path.dirname(file);
  let skipped = 0, inlined = 0, size = Buffer.byteLength(html);
  const resolveLocal = ref => {
    let r = String(ref || '').trim();
    if (!r || /^(?:data:|https?:|\/\/|#|mailto:|javascript:|about:|blob:)/i.test(r)) return null;
    r = r.replace(/^file:\/\/\/?/i, '').split(/[?#]/)[0];
    try { r = decodeURIComponent(r); } catch {}
    const abs = /^[A-Za-z]:[\\/]/.test(r) ? path.win32.normalize(r) : path.win32.resolve(dir, r);
    try { const st = fs.statSync(abs); return st.isFile() && st.size <= 20 * 1024 * 1024 ? abs : null; } catch { return null; }
  };
  const take = (abs, asText) => {
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime = IMAGE[ext] || (ext === '.svg' ? 'image/svg+xml' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'application/octet-stream');
    const value = asText ? buf.toString('utf8') : `data:${mime};base64,${buf.toString('base64')}`;
    const add = Buffer.byteLength(value);
    if (size + add > budget) { skipped++; return null; }
    size += add; inlined++; return value;
  };
  let out = html.replace(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, tag => {
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]; const abs = href && resolveLocal(href);
    if (!abs) return tag; const css = take(abs, true); return css == null ? tag : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  });
  out = out.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const abs = resolveLocal(src); if (!abs) return tag; const js = take(abs, true);
    return js == null ? tag : `<script${a}${b}>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  out = out.replace(/(<(?:img|source|image|video)\b[^>]*?\b(?:src|href|poster)=)(["'])([^"']+)\2/gi, (all, head, q, ref) => {
    const abs = resolveLocal(ref); if (!abs) return all; const uri = take(abs, false); return uri == null ? all : head + q + uri + q;
  });
  out = out.replace(/url\((["']?)([^)"']+)\1\)/gi, (all, q, ref) => {
    const abs = resolveLocal(ref); if (!abs || !IMAGE[path.extname(abs).toLowerCase()]) return all; const uri = take(abs, false); return uri == null ? all : `url("${uri}")`;
  });
  return { html: out, inlined, skipped };
}

// 图片太大时在电脑上缩到长边 2400 像素（JPEG）；用 Electron 自带的图片解码，不额外装依赖。
function shrinkImage(buf, nativeImage) {
  if (!nativeImage) return null;
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height));
  const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img;
  for (const q of [85, 70, 55]) { const out = resized.toJPEG(q); if (out.length <= IMAGE_RAW_MAX) return { data: out, mime: 'image/jpeg', width: resized.getSize().width, height: resized.getSize().height }; }
  return null;
}

/**
 * 读一个文件准备发给手机。have 是手机缓存的版本；没变时 status=not_modified，不带内容。
 * 返回 { status:'ok'|'not_modified', name, kind:'image'|'html', mime, mtime, size, sha, data?|html?, note? }
 */
function buildPreview(file, have, { nativeImage = null } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw Error('电脑上找不到这个文件，可能已被移动或删除'); }
  if (!st.isFile()) throw Error('这不是一个文件');
  if (st.size > READ_MAX) throw Error('文件太大，请在电脑上看');
  const buf = fs.readFileSync(file);
  const sha = fingerprint(buf), mtime = Math.round(st.mtimeMs), size = st.size;
  const ext = path.extname(file).toLowerCase(), name = path.basename(file);
  const base = { name, mtime, size, sha, kind: IMAGE[ext] ? 'image' : 'html' };
  if (have && have.sha === sha) return { status: 'not_modified', ...base };
  if (IMAGE[ext]) {
    if (buf.length <= IMAGE_RAW_MAX) return { status: 'ok', ...base, mime: IMAGE[ext], data: buf.toString('base64') };
    const small = shrinkImage(buf, nativeImage);
    if (!small) throw Error('图片太大，请在电脑上看');
    return { status: 'ok', ...base, mime: small.mime, data: small.data.toString('base64'), note: `原图 ${(size / 1048576).toFixed(1)} MB，手机上显示缩小版（${small.width}×${small.height}）` };
  }
  const text = buf.toString('utf8');
  if (Buffer.byteLength(text) > BUDGET) throw Error('文件太大，请在电脑上看');
  if (ext === '.svg') return { status: 'ok', ...base, mime: PAGE[ext], html: text };
  const r = inlineHtml(text, file, BUDGET);
  return { status: 'ok', ...base, mime: 'text/html', html: r.html, ...(r.skipped ? { note: `有 ${r.skipped} 个本地图片或样式太大，没有带上` } : {}) };
}

module.exports = { checkPath, mentionedPaths, turnTexts, buildPreview, inlineHtml, norm, EXTS, BUDGET, IMAGE_RAW_MAX };
