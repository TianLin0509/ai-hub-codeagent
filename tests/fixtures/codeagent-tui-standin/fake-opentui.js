'use strict';
// 公司 CodeAgent（opentui 全屏界面）的输出替身，只用于本机复现「点后台变卡」。
// 流量按公司取证（2026-10-10）对齐：每个会话约 24 块/秒、2～5 KB/秒；全屏备用屏幕、真彩色、
// 每块只改动少量格子（转圈动画 + 逐字追加正文），正文满屏后整块区域重画（opentui 不用终端滚动）。
const out = process.stdout;
const ESC = '\x1b[';
const TEXT = '物理层下行先做同步信号检测，再解主信息块，随后按系统信息配置初始接入。上行随机接入用前导码与定时提前量完成粗同步，调度器按信道质量分配资源块，HARQ 负责重传合并。';
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const intervalMs = Number(process.env.FAKE_TUI_INTERVAL_MS || 42);
let cols = out.columns || 120, rows = out.rows || 40;
let lines = [''], tick = 0, pos = 0;
const fg = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const bg = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;
const width = s => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const bodyTop = 3, bodyRows = () => Math.max(3, rows - 6), textCols = () => Math.max(20, cols - 6);
function rowText(i) { const t = lines[i] || ''; return bg(13, 17, 23) + fg(201, 209, 217) + t + ' '.repeat(Math.max(0, textCols() - width(t))); }
function drawBody() {
  const start = Math.max(0, lines.length - bodyRows()); let s = '';
  for (let r = 0; r < bodyRows(); r++) s += `${ESC}${bodyTop + r};3H` + rowText(start + r);
  return s;
}
function frame() {
  let s = `${ESC}?2026h${ESC}1;1H` + bg(22, 27, 34) + fg(88, 166, 255) + ' CodeAgent ' + fg(139, 148, 158) + '  model: standin   ctx 12%' + ' '.repeat(Math.max(0, cols - 37));
  s += drawBody();
  s += `${ESC}${rows - 2};1H` + bg(22, 27, 34) + fg(139, 148, 158) + '─'.repeat(cols);
  s += `${ESC}${rows - 1};1H` + bg(13, 17, 23) + fg(201, 209, 217) + '> ' + ' '.repeat(cols - 2) + `${ESC}?2026l`;
  return s;
}
function step() {
  tick++;
  let s = `${ESC}?2026h${ESC}${rows};2H` + bg(13, 17, 23) + fg(210, 153, 34) + SPIN[tick % SPIN.length] + fg(139, 148, 158) + ` 生成中 ${(tick * intervalMs / 1000).toFixed(1)}s  `;
  if (tick % 2 === 0) {
    const add = TEXT.slice(pos % TEXT.length, pos % TEXT.length + 3); pos += 3;
    const last = lines[lines.length - 1];
    if (width(last + add) > textCols()) {
      lines.push(add);
      if (lines.length > 2000) lines = lines.slice(-1000);
      s += lines.length > bodyRows() ? drawBody() : `${ESC}${bodyTop + lines.length - 1};3H` + rowText(lines.length - 1);
    } else {
      lines[lines.length - 1] = last + add;
      const visibleIdx = lines.length - 1 - Math.max(0, lines.length - bodyRows());
      s += `${ESC}${bodyTop + visibleIdx};3H` + rowText(lines.length - 1);
    }
  }
  out.write(s + `${ESC}?2026l`);
}
out.write(`${ESC}?1049h${ESC}?25l${ESC}2J` + frame());
out.on('resize', () => { cols = out.columns || cols; rows = out.rows || rows; out.write(`${ESC}2J` + frame()); });
const timer = setInterval(step, intervalMs);
// 测试用：输出一段时间后停下（终端内容随之静止，便于逐行核对屏幕）。
const stopAfter = Number(process.env.FAKE_TUI_STOP_AFTER_MS || 0);
if (stopAfter > 0) setTimeout(() => clearInterval(timer), stopAfter);
process.stdin.on('data', () => {}); process.stdin.resume();
