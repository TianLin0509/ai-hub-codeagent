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
// september：回到 9 月的做法（公司版默认）；october：10 月的做法（主仓库默认）。
// 环境变量 AI_HUB_BACKSTAGE_PATH=september|october 可覆盖，便于在同一安装包上做对照。
function backstagePath({ env = process.env, community } = {}) {
  const v = String(env.AI_HUB_BACKSTAGE_PATH || '').trim().toLowerCase();
  if (v === 'september' || v === 'october') return v;
  if (community === undefined) community = require('./distribution').community;
  return community ? 'september' : 'october';
}

function keepsTerminalBehindCards(options) {
  return backstagePath(options) === 'september';
}

module.exports = { backstagePath, keepsTerminalBehindCards };
