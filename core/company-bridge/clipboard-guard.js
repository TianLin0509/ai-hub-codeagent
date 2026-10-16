'use strict';
// 往 CodeAgent 粘贴之前，剪贴板里有图片就先清掉（2026-10-16 用户定：「读取剪贴板之前先清空一下，只清空这一次，
// 然后赶紧粘贴，避免影响我的正常复制粘贴操作」）。
// CodeAgent 收到终端粘贴时会自己去读剪贴板，有图片就在提问前插「[Image #0]」，再把看图结果一起交给模型：
// 同事桌面上的截图就这样进了上下文，回执也因此对不上（Q-1015-03 第 4 轮、Q-1016-01 第 2/4/6 轮）。
// 1.0.8 的做法是发送期间把图片拿开、发完放回；但 CodeAgent 读剪贴板比 Hub 认定「已发出」更晚，而且会读好几次
// （第 2 轮的一次粘贴插了 3 个占位符），放回去的图片照样被读到。所以改成清掉不放回：
//   - 只在有图片时动手，纯文字的剪贴板一概不碰；
//   - 同一次复制里带的文字（例如从 Word 复制，图片和文字一起进剪贴板）当场写回，只去掉图片。
const IMAGE_FORMAT = /^image\/|png|bitmap|dib|jpe?g/i;

function hasImage(clipboard) {
  try { return clipboard.availableFormats().some(f => IMAGE_FORMAT.test(f)); } catch { return false; }
}

// 返回 { cleared, keptText }；出错不抛，粘贴照常进行。
function dropImage(clipboard) {
  if (!clipboard || !hasImage(clipboard)) return { cleared: false, keptText: false };
  try {
    let text = '';
    try { text = clipboard.readText() || ''; } catch { text = ''; }
    clipboard.clear();
    if (text) clipboard.writeText(text);
    return { cleared: true, keptText: !!text };
  } catch { return { cleared: false, keptText: false }; }
}

module.exports = { dropImage, hasImage };
