'use strict';
// 卡片上的「查看完整 Prompt」入口。渲染进程只拿结构化结果，不做任何文件系统访问。
//
// 三个 channel：
//   prompt-inspect           结构化检视（路径 + 字节数 + 体检结论）
//   prompt-inspect-raw       单个来源的磁盘原文（带 sha256 / mtime，支持分页）
//   prompt-inspect-assemble  按真实注入顺序拼装的整段预览（带每段起止偏移）
//
// 安全底线：raw / assemble **绝不能**退化成「renderer 可读任意文件」的后门。
// 主进程每次都用会话自己的 cwd 重新跑一遍 buildInspection()，拿它的产出当白名单，
// 只有这次检视里真实出现过的路径才允许读；路径比较走 path.resolve + Windows
// 大小写不敏感（见 core/prompt-inspect.js 的 pathKey）。白名单由主进程现算，
// 永远不采信 renderer 传来的任何列表。

const {
  buildInspection,
  buildAssembly,
  readRawFile,
  resolveAllowedSource,
  buildRawAllowlist,
} = require('../../core/prompt-inspect.js');

function registerPromptInspectIpc(ipcMain, deps) {
  const { sessionManager } = deps;

  // cwd / kind 的解析口径三个 channel 必须完全一致，否则白名单会和面板对不上。
  function resolveTarget(req) {
    let cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : null;
    let kind = typeof req.kind === 'string' && req.kind ? req.kind : null;
    if ((!cwd || !kind) && req.sessionId && sessionManager) {
      const s = sessionManager.getSession(req.sessionId);
      if (s) {
        if (!cwd) cwd = s.cwd || null;
        if (!kind) kind = s.kind || null;
      }
    }
    return { cwd, kind: kind || 'claude' };
  }

  ipcMain.handle('prompt-inspect', (_e, payload) => {
    const req = payload && typeof payload === 'object' ? payload : {};
    const { cwd, kind } = resolveTarget(req);
    if (!cwd) return { ok: false, code: 'NO_CWD', error: '这个会话没有记录 cwd，无法还原注入内容' };

    try {
      return { ok: true, data: buildInspection({ cwd, kind }) };
    } catch (error) {
      return { ok: false, code: 'INSPECT_FAILED', error: (error && error.message) ? error.message : String(error) };
    }
  });

  // 单个来源的磁盘原文。payload: { sessionId?, cwd?, kind?, path, offset?, limit? }
  ipcMain.handle('prompt-inspect-raw', (_e, payload) => {
    const req = payload && typeof payload === 'object' ? payload : {};
    const { cwd, kind } = resolveTarget(req);
    if (!cwd) return { ok: false, code: 'NO_CWD', error: '这个会话没有记录 cwd，无法校验路径归属' };
    const wanted = typeof req.path === 'string' ? req.path : '';
    if (!wanted.trim()) return { ok: false, code: 'NO_PATH', error: '没有指定要查看的文件路径' };

    let insp;
    try {
      insp = buildInspection({ cwd, kind });
    } catch (error) {
      return { ok: false, code: 'INSPECT_FAILED', error: (error && error.message) ? error.message : String(error) };
    }

    // 白名单校验：只允许本次 inspection 里真实出现过的路径
    const source = resolveAllowedSource(insp, wanted);
    if (!source) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        error: `拒绝读取：${wanted} 不在这个 cwd 的注入来源里。这个通道只开放本次检视列出的文件。`,
      };
    }

    const raw = readRawFile(source.path, { offset: req.offset, limit: req.limit });
    if (!raw.ok) return { ok: false, code: raw.code, error: raw.error, data: { path: raw.path } };
    return {
      ok: true,
      data: {
        ...raw,
        id: source.id,
        label: source.label,
        group: source.group,
        sourceKind: source.kind,
        source: source.source,
        injected: source.injected,
      },
    };
  });

  // 完整拼装预览。payload: { sessionId?, cwd?, kind? }
  ipcMain.handle('prompt-inspect-assemble', (_e, payload) => {
    const req = payload && typeof payload === 'object' ? payload : {};
    const { cwd, kind } = resolveTarget(req);
    if (!cwd) return { ok: false, code: 'NO_CWD', error: '这个会话没有记录 cwd，无法还原注入内容' };

    try {
      const insp = buildInspection({ cwd, kind });
      const asm = buildAssembly(insp);
      return { ok: true, data: { ...asm, allowlistSize: buildRawAllowlist(insp).length } };
    } catch (error) {
      return { ok: false, code: 'ASSEMBLE_FAILED', error: (error && error.message) ? error.message : String(error) };
    }
  });
}

module.exports = { registerPromptInspectIpc };
