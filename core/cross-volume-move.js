'use strict';

// 跨盘移动（2026-10-07）：工作区和产物根开始同时存在于 C: 与 D:，rename / 硬链接跨卷会抛 EXDEV。
// 这里只在 EXDEV 时退为「复制 → 删除原件」，同卷仍走原子 rename。
// 安全边界：
//   · 目标必须不存在（文件用 COPYFILE_EXCL，目录用 errorOnExist）；
//   · 源本身或目录内任何一层是符号链接 / junction 就整体拒绝——不穿透链接复制，也不递归删除链接目标；
//   · 复制失败只清理本次新建的目标；删除原件失败时两处都保留并报错，不丢数据。

const fs = require('node:fs');
const path = require('node:path');

async function assertNoLinks(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) throw new Error('目录内含链接，跨盘移动已停止，原文件保留');
      if (stat.isDirectory()) stack.push(full);
    }
  }
}

async function copyThenRemove(source, target) {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('链接不能跨盘移动，原文件保留');
  if (stat.isFile()) {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    try { await fs.promises.utimes(target, stat.atime, stat.mtime); } catch {}
    try { await fs.promises.unlink(source); } catch (error) {
      try { await fs.promises.unlink(target); } catch {}
      throw error;
    }
    return;
  }
  if (!stat.isDirectory()) throw new Error('此项目不是普通文件或文件夹');
  await assertNoLinks(source);
  try {
    await fs.promises.cp(source, target, {
      recursive: true, errorOnExist: true, force: false, dereference: false, preserveTimestamps: true,
    });
  } catch (error) {
    // 目标在调用前不存在、源内无链接，所以这里删的只是本次复制出的半成品。
    try { await fs.promises.rm(target, { recursive: true, force: true }); } catch {}
    throw error;
  }
  try {
    await fs.promises.rm(source, { recursive: true });
  } catch (error) {
    throw new Error(`已复制到 ${target}，但删除原位置失败（${error.message}）；两处都已保留，请手动核对`);
  }
}

async function moveEntry(source, target) {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    await copyThenRemove(source, target);
  }
}

module.exports = { moveEntry, copyThenRemove, assertNoLinks };
