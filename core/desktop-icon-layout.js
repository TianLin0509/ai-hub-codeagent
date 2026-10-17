'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
// 打包后先找 app.asar.unpacked/scripts（package.json 的 asarUnpack），再找 resources/scripts（extraResources）。
// 2026-10-17 公司版「排齐图标」报缺脚本：一键更新只替换 app.asar 和 app.asar.unpacked，resources/scripts 停在
// 基线安装包的样子，基线之后才加的脚本永远到不了。增量包格式不能改（老客户端会拒收不认识的路径、升级失败），
// 所以把脚本放进增量包本来就覆盖的解包目录。
function desktopLayoutScript(moduleDir = __dirname, resourcesPath = process.resourcesPath, exists = fsSync.existsSync) {
  if (!(resourcesPath && /\.asar(?:\.unpacked)?[\\/]/i.test(moduleDir))) return path.join(moduleDir, '..', 'scripts', 'desktop-icon-layout.ps1');
  const unpacked = path.join(resourcesPath, 'app.asar.unpacked', 'scripts', 'desktop-icon-layout.ps1');
  return exists(unpacked) ? unpacked : path.join(resourcesPath, 'scripts', 'desktop-icon-layout.ps1');
}

// PowerShell 的输出：脚本自己按 UTF-8 写；它启动失败时（如找不到脚本）是系统代码页（中文 Windows 为 GBK）。
function decodeOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const utf8 = Buffer.from(value).toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(value); } catch { return utf8; }
}

// 失败时给人看的一句话：优先脚本自己报的 JSON 错误；否则去掉 PowerShell 的版权横幅，只留真正的错误行。
function failureDetail(error) {
  const stdout = decodeOutput(error && error.stdout).trim();
  const stderr = decodeOutput(error && error.stderr).trim();
  for (const text of [stdout, stderr]) { try { const parsed = JSON.parse(text); if (parsed && parsed.error) return parsed.error; } catch {} }
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^Windows PowerShell$|Microsoft Corporation|aka\.ms\/pscore|^版权所有|^Copyright/i.test(line));
  return lines.join(' ').slice(0, 300) || (error && error.message) || '未知错误';
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

function createDesktopIconLayout({ testRoot, run = runFile, platform = process.platform, exists = file => fsSync.existsSync(file) } = {}) {
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
    // 2026-10-14 公司版：导出包漏了这两个脚本，PowerShell 找不到文件就吐出乱码的版权横幅。先查文件，缺了直接说清。
    for (const file of [script, script.replace(/\.ps1$/i, '.cs')]) {
      if (!exists(file)) throw new Error(`图标排列失败：缺少排列脚本 ${path.basename(file)}，请更新 Hub`);
    }
    let output;
    // -ExecutionPolicy Bypass：公司电脑常把脚本执行策略设为受限，只对这一次调用放开。
    try { output = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 15000, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { throw new Error('图标排列失败：' + failureDetail(error)); }
    let native;
    try { native = JSON.parse(decodeOutput(output.stdout).trim()); } catch { throw new Error('Windows 未返回可核对的图标排列结果'); }
    if (!native.ok) throw new Error(native.error || 'Windows 桌面排列失败');
    return { ok: true, simulated: false, ...verifyColumns(native.after), before: native.before, after: native.after };
  }
  return { arrange };
}
module.exports = { createDesktopIconLayout, verifyColumns, desktopLayoutScript, decodeOutput, failureDetail };
