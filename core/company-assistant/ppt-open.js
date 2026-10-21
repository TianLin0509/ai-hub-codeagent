'use strict';
const { spawn } = require('node:child_process');

// Invoked only by a user's Open-page click, after the index resolves the file.
// Keep existing PowerPoint documents open; neither process nor presentation is closed.
async function openSlide(file, page) {
  if (process.platform !== 'win32' || !/\.pptx?$/i.test(file)) return false;
  const script = [
    '$ErrorActionPreference="Stop"',
    '$file=[Environment]::GetEnvironmentVariable("HUB_PPT_OPEN_FILE")',
    '$page=[int][Environment]::GetEnvironmentVariable("HUB_PPT_OPEN_PAGE")',
    'try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application") } catch { $app=New-Object -ComObject PowerPoint.Application }',
    '$presentation=$null',
    'foreach ($candidate in $app.Presentations) { if ($candidate.FullName -eq $file) { $presentation=$candidate; break } }',
    'if ($null -eq $presentation) { $presentation=$app.Presentations.Open($file,$true,$false,$true) }',
    'if ($page -lt 1 -or $page -gt $presentation.Slides.Count) { throw "索引页码已超出当前文稿，请更新索引" }',
    '$app.Visible=$true',
    '$presentation.Windows.Item(1).Activate()',
    '$presentation.Windows.Item(1).View.GotoSlide($page)',
  ].join('\n');
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, HUB_PPT_OPEN_FILE: file, HUB_PPT_OPEN_PAGE: String(page) } });
    const timeout = setTimeout(() => { child.kill(); resolve(false); }, 60000);
    child.on('error', () => { clearTimeout(timeout); resolve(false); });
    child.on('close', code => { clearTimeout(timeout); resolve(code === 0); });
  });
}

module.exports = { openSlide };
