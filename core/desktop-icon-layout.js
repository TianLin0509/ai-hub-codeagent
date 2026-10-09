'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
function desktopLayoutScript(moduleDir = __dirname, resourcesPath = process.resourcesPath) {
  return resourcesPath && /\.asar(?:\.unpacked)?[\\/]/i.test(moduleDir)
    ? path.join(resourcesPath, 'scripts', 'desktop-icon-layout.ps1')
    : path.join(moduleDir, '..', 'scripts', 'desktop-icon-layout.ps1');
}

function verifyColumns(snapshot) {
  if (!snapshot || (snapshot.flags & 0x801) !== 0x801) throw new Error('Windows 未启用自动排列和竖列排列');
  const { spacingX, spacingY, icons } = snapshot;
  if (!Array.isArray(icons) || !Number.isFinite(spacingX) || !Number.isFinite(spacingY) || spacingX <= 0 || spacingY <= 0) throw new Error('无法核对桌面图标间距');
  const ordered = [...icons].sort((a, b) => a.index - b.index);
  const columns = [];
  for (const icon of ordered) {
    if (![icon.index, icon.x, icon.y].every(Number.isFinite)) throw new Error('桌面图标坐标无效');
    const previous = columns[columns.length - 1];
    if (!previous || icon.x !== previous.x) {
      if (previous && (Math.abs(icon.x - previous.x - spacingX) > 2 || Math.abs(icon.y - ordered[0].y) > 2)) throw new Error('图标没有按先竖列、再向右的顺序排列');
      columns.push({ x: icon.x, items: [icon] });
    } else {
      if (Math.abs(icon.y - previous.items[previous.items.length - 1].y - spacingY) > 2) throw new Error('图标竖列中仍有空隙');
      previous.items.push(icon);
    }
  }
  const rows = columns[0]?.items.length || 0;
  if (columns.some((column, index) => index < columns.length - 1 ? column.items.length !== rows : column.items.length > rows)) throw new Error('图标未排满前一列就换列');
  return { iconCount: icons.length, columns: columns.length, rowsPerColumn: rows, verified: true };
}

function createDesktopIconLayout({ testRoot, run = runFile, platform = process.platform } = {}) {
  async function arrange() {
    if (testRoot) {
      const names = [];
      for (const folder of ['Desktop', 'PublicDesktop']) {
        try { names.push(...(await fs.readdir(path.join(testRoot, folder))).filter(name => name !== 'desktop.ini' && !name.startsWith('.'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const snapshot = { flags: 0x801, spacingX: 90, spacingY: 100, icons: names.map((name, index) => ({ index, name, x: Math.floor(index / 6) * 90, y: index % 6 * 100 })) };
      const result = { ok: true, simulated: true, ...verifyColumns(snapshot), after: snapshot };
      await fs.writeFile(path.join(testRoot, 'desktop-icon-layout.json'), JSON.stringify(result, null, 2), 'utf8');
      return result;
    }
    if (platform !== 'win32') throw new Error('图标竖列排列目前仅支持 Windows 桌面');
    const script = desktopLayoutScript();
    let output;
    try { output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) {
      let detail = error.message;
      if (error.stdout) { try { detail = JSON.parse(error.stdout).error || detail; } catch { detail = String(error.stdout).trim() || detail; } }
      throw new Error('图标排列失败：' + detail);
    }
    let native;
    try { native = JSON.parse(output.stdout.trim()); } catch { throw new Error('Windows 未返回可核对的图标排列结果'); }
    if (!native.ok) throw new Error(native.error || 'Windows 桌面排列失败');
    return { ok: true, simulated: false, ...verifyColumns(native.after), before: native.before, after: native.after };
  }
  return { arrange };
}
module.exports = { createDesktopIconLayout, verifyColumns, desktopLayoutScript };
