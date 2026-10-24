'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
class MeetingFrames {
  constructor(meetings) { this.m = meetings; this.tail = Promise.resolve(); this.closed = false; }
  extract(id, args = {}) {
    const times = args.timesMs;
    if (!Array.isArray(times) || !times.length || times.length > 6) return Promise.reject(new Error('每次指定1至6个会议时间点（毫秒）'));
    times.forEach(t => this.m.time(t));
    const crop = args.crop || { x: 0, y: 0, w: 1, h: 1 };
    if (![crop.x,crop.y,crop.w,crop.h].every(Number.isFinite) || crop.x<0 || crop.y<0 || crop.w<=0 || crop.h<=0 || crop.x+crop.w>1 || crop.y+crop.h>1) return Promise.reject(new Error('裁切范围无效'));
    const work = this.tail.catch(() => {}).then(async () => {
      if (this.closed) throw new Error('会议工具已关闭');
      const { BrowserWindow } = require('electron');
      const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } }); this.window = win;
      try {
        await win.loadFile(path.join(__dirname, 'meeting-video.html')); const frames = [];
        for (const at of times) {
          const located = this.m.recording.locate(id, at);
          const result = await win.webContents.executeJavaScript(`window.extractMeetingFrame(${JSON.stringify({url:located.url,seconds:located.offsetMs/1000,crop,maxWidth:args.detail === 'high' ? 1920 : 1280})})`);
          const actualAt = located.segment.at + Math.round(result.seconds * 1000);
          const suffix = createHash('sha256').update(JSON.stringify({at,crop,detail:args.detail})).digest('hex').slice(0,16);
          const file = `frame-${suffix}.jpg`; fs.writeFileSync(path.join(this.m.dir(id),file),Buffer.from(result.data,'base64'));
          frames.push({ requestedMs:at,at:actualAt,file,path:path.join(this.m.dir(id),file),width:result.width,height:result.height,data:result.data });
        }
        return frames;
      } finally { if (!win.isDestroyed()) win.destroy(); if (this.window === win) this.window = null; }
    });
    this.tail = work; return work;
  }
  close() { this.closed = true; if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}
module.exports = { MeetingFrames };
