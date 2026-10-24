'use strict';
function createMeetingHandlers(service) {
  const m = service.meetings;
  return {
    'meeting-status': r => m.status(r.id),
    'meeting-start': r => ({ ok: true, meeting: m.create(r) }),
    'meeting-capture': r => m.capture(r.id, r),
    'meeting-control': r => m.control(r.id, r.op, r.value),
    'meeting-asset': r => ({ ok: true, ...m.asset(r.id, r.seq) }),
    'meeting-recording': r => ({ ok: true, ...m.recording.index(r.id) }),
    'meeting-playback': r => ({ ok: true, ...m.recording.locate(r.id, r.at) }),
    'meeting-frames': async r => ({ ok: true, frames: await m.frames.extract(r.id, r) }),
    'meeting-asr-install': () => ({ ok: true, asr: m.asr.install() }),
    'meeting-export': async r => { const file = m.export(r.id); require('electron').shell.showItemInFolder(file); return { ok: true, file }; },
    'meeting-sources': async () => {
      const sources = await require('electron').desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
      return { ok: true, sources: sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })) };
    },
  };
}
module.exports = { createMeetingHandlers };
