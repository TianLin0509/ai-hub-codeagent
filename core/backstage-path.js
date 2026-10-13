'use strict';
// 「后台」按钮走哪条路径（2026-10-11，公司「点后台卡死、随后黑屏」）。
//
// 线索：同一台公司电脑上，基于 9 月 Hub 代码的 CodeTeam 一切正常，换成 10 月的 Hub 后才出现。
// Electron 41.2 与 xterm 5.5 在 9、10 月没变，10 月在点「后台」这条路径上加了三处改动：
//   - 10-03 136e13ec：卡片视图卸掉终端的 Canvas 绘制层，每次点后台重新创建；
//   - 10-03 d676f451：卡片视图不再按窗口尺寸调整终端和 CLI 的行列数（停在 80×24），
//     点后台时才一次性改到实际尺寸，CLI 随之整屏重画；
//   - 10-08 4164c127：卡片视图把终端 display:none，点后台再显示出来并整块重排。
// 9 月的做法是终端一直按实际尺寸显示在卡片下面、绘制层常驻，点后台只是把卡片层藏起来。
//
// september：9 月的做法；october：10 月的做法。
// 2026-10-11 先只给公司版、社区版改回 9 月做法（公司电脑点后台最长卡顿 542→58 毫秒）；
// 2026-10-13 用户在自用版上也遇到点后台卡顿，主仓库一并改成 9 月做法。本机对照
// （tests/perf-backstage-click.js，长对话替身、1720×926 窗口、开显卡）：点后台 9 月 46～48 毫秒画面更新，
// 10 月 123～174 毫秒；从后台回卡片 9 月 43～44 毫秒，10 月 387～775 毫秒。代价是卡片视图里当前会话
// 还在输出时，常驻的终端照常绘制，界面与显卡进程各多约 15～20%（单核计）。
// 环境变量 AI_HUB_BACKSTAGE_PATH=september|october 可覆盖，便于在同一安装包上做对照。
function backstagePath({ env = process.env } = {}) {
  const v = String(env.AI_HUB_BACKSTAGE_PATH || '').trim().toLowerCase();
  return v === 'october' ? 'october' : 'september';
}

function keepsTerminalBehindCards(options) {
  return backstagePath(options) === 'september';
}

module.exports = { backstagePath, keepsTerminalBehindCards };
