'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

async function writeAll(handle,text) {
  const bytes=Buffer.from(text,'utf8');let offset=0;
  while(offset<bytes.length){
    const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset);
    if(!Number.isInteger(bytesWritten)||bytesWritten<=0)throw new Error('原始记录导出写入未完成');
    offset+=bytesWritten;
  }
}
const exportChunkText = text => text.isWellFormed() ? text : '[UTF-16 JSON] '+JSON.stringify(text);

function registerCodexBackstageIpc(ipcMain, { sessionManager }) {
  function nativeFor(sessionId) {
    const native = sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId) || sessionManager.getNativeClaude?.(sessionId);
    if (!native?.readBackstage) throw new Error('当前会话没有原生后台记录');
    return native;
  }
  ipcMain.handle('codex:backstage-read', async (_event, payload = {}) => {
    try {
      const { mode, before, after, since, limit, id, history } = payload;
      const result = await nativeFor(payload.sessionId).readBackstage({ mode, before, after, since, limit, id, history:history === true });
      return { ok:true, ...result };
    } catch (error) { return { ok:false, message:error.message }; }
  });
  ipcMain.handle('codex:backstage-export', async (_event, payload = {}) => {
    let file, handle;
    try {
      const native = nativeFor(payload.sessionId);
      const provider = native.options?.kind && require('../../core/acp-profiles').isAcpKind(native.options.kind)
        ? native.label : sessionManager.getNativeClaude?.(payload.sessionId) === native ? 'Claude' : 'Codex';
      const { dialog, shell } = require('electron');
      const selected = await dialog.showSaveDialog({ title:`导出 ${provider} 原始记录`,
        defaultPath:`${provider.toLowerCase()}-backstage-${new Date().toISOString().slice(0,10)}.txt`,
        filters:[{ name:'文本记录', extensions:['txt'] }] });
      if (selected.canceled || !selected.filePath) return { ok:true, canceled:true };
      await native.prepareBackstageExport?.();
      file = selected.filePath + '.' + randomUUID() + '.partial';
      handle = await fs.promises.open(file, 'wx');
      await writeAll(handle,`${provider} 原始记录（后台采集；未采集的历史和 stderr 不可补录）\n跨块的单独 UTF-16 码元以 [UTF-16 JSON] 标记保存，避免编码替换丢失。\n\n`);
      let after = 0, end = null;
      do {
        const page = await native.readBackstage({ mode:'raw', after, limit:16 });
        if (page.unsupported) throw new Error(page.message);
        if (end == null) end = page.end;
        for (const chunk of page.chunks || []) {
          if (chunk.seq > end) break;
          await writeAll(handle,`[${new Date(chunk.stamp).toISOString()}] ${chunk.id} / ${chunk.field} / v${chunk.generation}\n`);
          await writeAll(handle,exportChunkText(chunk.text) + '\n'); after = chunk.seq;
        }
        if (!page.chunks?.length || after >= end) break;
      } while (true);
      await handle.sync(); await handle.close(); handle = null;
      await fs.promises.rename(file, selected.filePath); file = null;
      shell.showItemInFolder(selected.filePath);
      return { ok:true, filePath:selected.filePath };
    } catch (error) {
      if (handle) try { await handle.close(); } catch (closeError) { console.error('[codex-backstage-export]', closeError.message); }
      // Keep an incomplete export identifiable instead of silently presenting
      // it as a complete record or overwriting another task's output.
      return { ok:false, message:error.message + (file ? `；未完成文件保留在 ${file}` : '') };
    }
  });
}
module.exports = { registerCodexBackstageIpc, writeAll, exportChunkText };
