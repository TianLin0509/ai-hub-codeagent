'use strict';

// Display state only. Neither member selection nor layout changes dispatch work.
function createGroupMemberSplit({ document: doc, host, before, services: s }) {
  const rooms = new Map();
  let room = null, visible = false;
  const root = doc.createElement('section'); root.className = 'group-member-split'; root.hidden = true;
  root.setAttribute('aria-label', '群聊成员双屏'); host.insertBefore(root, before);
  const roster = doc.createElement('div'); roster.className = 'gms-roster'; root.append(roster);
  const stage = doc.createElement('div'); stage.className = 'gms-stage'; root.append(stage);
  const divider = doc.createElement('div'); divider.className = 'session-pane-divider'; divider.tabIndex = 0;
  divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', '调整群聊双屏宽度'); divider.setAttribute('aria-orientation', 'vertical');
  const views = new Map();
  const panes = [0, 1].map(index => {
    const el = doc.createElement('section'); el.className = 'gms-pane'; el.dataset.side = String(index);
    const header = doc.createElement('header'); header.className = 'gms-header';
    const logo = doc.createElement('img'); logo.alt = '';
    const select = doc.createElement('select'); select.setAttribute('aria-label', index ? '右屏成员' : '左屏成员');
    const status = doc.createElement('span'); status.className = 'gms-status';
    const backstage = doc.createElement('button'); backstage.type = 'button'; backstage.textContent = '后台'; backstage.title = '查看此成员后台';
    const stop = doc.createElement('button'); stop.type = 'button'; stop.textContent = '停止此成员'; stop.className = 'gms-stop';
    const body = doc.createElement('div'); body.className = 'gms-body';
    const empty = doc.createElement('div'); empty.className = 'split-empty';
    const emptyText = doc.createElement('p');
    const resume = doc.createElement('button'); resume.type = 'button'; resume.textContent = '恢复此成员';
    empty.append(emptyText, resume); body.append(empty);
    const error = doc.createElement('div'); error.className = 'gms-error'; error.setAttribute('role', 'status'); error.hidden = true;
    header.append(logo, select, status, backstage, stop); el.append(header, error, body); stage.append(el);
    if (!index) stage.append(divider);
    const focus = () => { if (!room) return; room.focus = index; paintFocus(); };
    el.addEventListener('pointerdown', focus); el.addEventListener('focusin', focus);
    select.addEventListener('change', () => choose(index, select.value));
    backstage.addEventListener('click', () => { currentView(index)?.toggleMode(); paint(); });
    stop.addEventListener('click', async () => {
      const sid = room?.ids[index]; if (!sid) return;
      stop.disabled = true; error.hidden = true;
      try { await s.stop(sid); } catch (e) { error.textContent = '停止失败：' + e.message; error.hidden = false; }
      finally { paint(); }
    });
    resume.addEventListener('click', async () => {
      const sid = room?.ids[index]; if (!sid) return;
      resume.disabled = true; error.hidden = true;
      try { await s.resume(sid); } catch (e) { error.textContent = '恢复失败：' + e.message; error.hidden = false; }
      finally { resume.disabled = false; paint(); }
    });
    return { el, logo, select, status, backstage, stop, body, error, empty, emptyText, resume };
  });
  function currentView(index) { return views.get(room?.ids[index])?.view; }
  function paintFocus() { panes.forEach((p,i) => p.el.classList.toggle('focused', room?.focus === i)); }
  function ratio(value) {
    if (!room) return;
    room.ratio = Math.min(70, Math.max(30, value));
    stage.style.setProperty('--gms-left', room.ratio + '%'); divider.setAttribute('aria-valuenow', String(Math.round(room.ratio)));
    divider.setAttribute('aria-valuemin', '30'); divider.setAttribute('aria-valuemax', '70');
  }
  divider.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
    e.preventDefault(); ratio(e.key === 'Home' ? 50 : room.ratio + (e.key === 'ArrowLeft' ? -2 : 2));
  });
  divider.addEventListener('pointerdown', e => { divider.setPointerCapture(e.pointerId); });
  divider.addEventListener('pointermove', e => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const rect = stage.getBoundingClientRect(); ratio((e.clientX - rect.left) / rect.width * 100);
  });
  function choose(index, sid) {
    if (!room || !s.members(room.meeting).some(m => m.sid === sid)) return;
    const existing = room.ids.indexOf(sid);
    if (existing >= 0 && existing !== index) { room.focus = existing; paint(); panes[existing].select.focus(); return; }
    room.ids[index] = sid; room.focus = index; paint();
  }
  function saveViews() {
    for (const [sid, entry] of views) {
      // Hidden DOM has no usable geometry; retain its last visible snapshot.
      if (room && !entry.panel.hidden) room.reading.set(sid, entry.view.captureReading());
      entry.view.dispose(); entry.panel.remove();
    }
    views.clear();
  }
  function paint() {
    if (!room) return;
    const members = s.members(room.meeting).filter(m => m.sid);
    const valid = new Set(members.map(m => m.sid));
    room.ids = room.ids.map(id => valid.has(id) ? id : null);
    for (let i = 0; i < 2; i++) if (!room.ids[i]) room.ids[i] = members.find(m => !room.ids.includes(m.sid))?.sid || null;
    for (const [sid, entry] of views) {
      if (!valid.has(sid) || !s.session(sid) || s.session(sid).status === 'dormant') {
        if (!entry.panel.hidden) room.reading.set(sid, entry.view.captureReading());
        entry.view.dispose(); entry.panel.remove(); views.delete(sid); continue;
      }
      const shown = visible && room.ids.includes(sid);
      if (!shown && !entry.panel.hidden) room.reading.set(sid, entry.view.captureReading());
      if (!shown) { entry.view.setVisible(false); entry.panel.hidden = true; }
    }
    panes.forEach((p, index) => {
      const sid = room.ids[index], member = members.find(m => m.sid === sid), session = s.session(sid);
      const signature = JSON.stringify(members.map(m => [m.sid, m.label]));
      if (p.select.dataset.signature !== signature) {
        p.select.replaceChildren(...members.map(m => { const o = doc.createElement('option'); o.value = m.sid; o.textContent = m.label; return o; }));
        p.select.dataset.signature = signature;
      }
      p.select.value = sid || ''; p.select.disabled = !member;
      p.logo.hidden = !member; if (member) p.logo.src = s.logo(member.kind);
      p.status.textContent = member ? s.status(session) : '选择另一位成员';
      p.stop.disabled = !sid || !s.running(session);
      p.backstage.disabled = !sid || session?.status === 'dormant';
      p.empty.hidden = !!session && session.status !== 'dormant';
      p.emptyText.textContent = !sid ? '添加另一名成员后即可并排查看' : session?.status === 'dormant' ? '此成员正在休眠，记录和草稿已保存。' : '等待成员连接';
      p.resume.hidden = session?.status !== 'dormant';
      if (visible && sid && session && session.status !== 'dormant' && !views.has(sid)) {
        const panel = doc.createElement('div'); panel.className = 'terminal-panel gms-member-view'; panel.dataset.groupMember = sid;
        p.body.append(panel);
        try {
          const view = s.createView(sid, panel); panel._memberView = view;
          views.set(sid, { panel, view });
          view.restoreReading(room.reading.get(sid));
        } catch (e) { panel.remove(); p.error.textContent = '成员视图打开失败：' + e.message; p.error.hidden = false; }
      }
      const entry = views.get(sid);
      if (entry) {
        const wasHidden = entry.panel.hidden;
        if (entry.panel.parentElement !== p.body) p.body.append(entry.panel);
        entry.panel.hidden = !visible; entry.view.setVisible(visible); entry.view.updateStatus();
        if (visible && wasHidden) entry.view.restoreReading(room.reading.get(sid));
      }
      p.backstage.setAttribute('aria-pressed', String(entry?.view.mode() === 'pty'));
    });
    const rosterKey = JSON.stringify(members.map(m => [m.sid, m.label, s.status(s.session(m.sid)), room.ids.includes(m.sid)]));
    if (roster.dataset.signature !== rosterKey) {
      roster.dataset.signature = rosterKey;
      roster.replaceChildren(...members.map(m => {
        const item = doc.createElement('details'); item.className = 'gms-member-picker';
        const summary = doc.createElement('summary'); summary.textContent = `${m.label} · ${s.status(s.session(m.sid))}`;
        if (room.ids.includes(m.sid)) summary.classList.add('visible-member');
        item.append(summary);
        for (let index = 0; index < 2; index++) {
          const button = doc.createElement('button'); button.type = 'button'; button.textContent = index ? '在右屏查看' : '在左屏查看';
          button.addEventListener('click', () => { item.open = false; choose(index, m.sid); }); item.append(button);
        }
        return item;
      }));
    }
    ratio(room.ratio); paintFocus();
  }
  function open(meeting) {
    if (room?.meeting.id !== meeting.id) {
      saveViews();
      if (!rooms.has(meeting.id)) rooms.set(meeting.id, { meeting, mode: 'overview', ids: [meeting.focusedSub || null, null], focus: 0, ratio: 50, reading: new Map() });
      room = rooms.get(meeting.id);
    }
    room.meeting = meeting; setMode(room.mode);
  }
  function setMode(mode) {
    if (!room) return;
    if (visible && mode !== 'two') for (const [sid, entry] of views) {
      if (!entry.panel.hidden) room.reading.set(sid, entry.view.captureReading());
      entry.view.setVisible(false); entry.panel.hidden = true;
    }
    room.mode = mode === 'two' ? 'two' : 'overview'; visible = room.mode === 'two'; root.hidden = !visible;
    host.classList.toggle('gms-active', visible); paint(); s.onMode?.(room.mode);
  }
  return { root, open, setMode, mode: () => room?.mode || 'overview',
    refresh(meeting) { if (room?.meeting.id === meeting.id) { room.meeting = meeting; paint(); } },
    close() { saveViews(); visible = false; root.hidden = true; host.classList.remove('gms-active'); room = null; },
  };
}
module.exports = { createGroupMemberSplit };
