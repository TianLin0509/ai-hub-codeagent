'use strict';
const STORAGE_KEY = 'hub.navigationOrder.v1';

function normalizeNavigationOrder(saved, available) {
  const allowed = new Set(available), seen = new Set();
  return [...(Array.isArray(saved) ? saved : []), ...available].filter(id => {
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
}

function installNavigationOrder(doc = globalThis.document) {
  const list = doc?.querySelector('#scene-rail .rail-navigation');
  if (!list || list.dataset.orderInstalled) return;
  list.dataset.orderInstalled = 'true';
  const win = doc.defaultView, rail = doc.getElementById('scene-rail');
  const buttons = [...list.querySelectorAll('.btn-shell-nav')].filter(e => !e.hidden);
  const ids = buttons.map(e => e.id), byId = new Map(buttons.map(e => [e.id, e]));
  let storage, saved;
  try { storage = win.localStorage; saved = JSON.parse(storage.getItem(STORAGE_KEY)); } catch {}
  for (const id of normalizeNavigationOrder(saved, ids)) list.append(byId.get(id));
  for (const button of buttons) {
    button.dataset.orderHint = button.title;
    button.title += ' · 长按调整顺序';
    button.setAttribute('aria-keyshortcuts', 'F2');
    button.querySelectorAll('img').forEach(e => e.draggable = false);
  }
  const done = doc.createElement('button');
  done.type = 'button'; done.id = 'nav-edit-done'; done.textContent = '完成'; done.hidden = true;
  done.title = '保存顺序并结束编辑 (Escape)';
  rail.querySelector('.rail-drawer-head').append(done);
  let editing = false, pending = null, dragging = null, timer = null, suppressUntil = 0;
  const persist = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify([...list.children].filter(e => ids.includes(e.id)).map(e => e.id))); } catch {}
  };
  const cancelTimer = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const setEditing = value => {
    editing = value; rail.classList.toggle('rail-editing', value); done.hidden = !value;
    if (!value) { cancelTimer(); dragging?.classList.remove('nav-dragging'); dragging = null; pending = null; persist(); suppressUntil = Date.now() + 350; }
  };
  const beginDrag = button => { dragging = button; button.classList.add('nav-dragging'); };
  const buttonAt = target => {
    const e = target?.closest?.('.btn-shell-nav');
    return e && byId.has(e.id) && list.contains(e) ? e : null;
  };
  list.addEventListener('pointerdown', e => {
    const button = buttonAt(e.target);
    if (!button || e.button !== 0) return;
    pending = { button, x:e.clientX, y:e.clientY, pointerId:e.pointerId };
    if (editing) { e.preventDefault(); button.setPointerCapture(e.pointerId); beginDrag(button); return; }
    cancelTimer();
    timer = win.setTimeout(() => {
      timer = null;
      if (!pending) return;
      setEditing(true); suppressUntil = Date.now() + 350;
      button.setPointerCapture(pending.pointerId); beginDrag(button);
    }, 550);
  });
  doc.addEventListener('pointermove', e => {
    if (!pending) return;
    if (!editing) {
      if (Math.hypot(e.clientX-pending.x,e.clientY-pending.y)>7) { cancelTimer(); pending=null; }
      return;
    }
    if (!dragging) return;
    e.preventDefault();
    const bounds=list.getBoundingClientRect();
    if(e.clientY<bounds.top+22) list.scrollTop-=12;
    if(e.clientY>bounds.bottom-22) list.scrollTop+=12;
    const target=buttonAt(doc.elementFromPoint(e.clientX,e.clientY));
    if (!target || target===dragging) return;
    const box=target.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY < box.top+box.height/2 ? target : target.nextSibling);
  }, {passive:false});
  const endDrag = () => { cancelTimer(); pending=null; dragging?.classList.remove('nav-dragging'); if(dragging) persist(); dragging=null; };
  doc.addEventListener('pointerup',endDrag);
  doc.addEventListener('pointercancel',endDrag);
  win.addEventListener('blur',endDrag);
  doc.addEventListener('click', e => {
    if (buttonAt(e.target) && (editing || Date.now()<suppressUntil)) { e.preventDefault(); e.stopImmediatePropagation(); }
  },true);
  doc.addEventListener('pointerdown', e => { if(editing&&!rail.contains(e.target))setEditing(false); },true);
  list.addEventListener('contextmenu',e=>{ if(editing) e.preventDefault(); });
  doc.addEventListener('keydown', e => {
    const button=buttonAt(e.target);
    if(button&&e.key==='F2'){e.preventDefault();setEditing(true);return;}
    if(!editing)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();setEditing(false);return;}
    if(!button||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();
    const order=[...list.children].filter(el=>ids.includes(el.id)),i=order.indexOf(button);
    if(e.key==='ArrowUp'&&i>0)list.insertBefore(button,order[i-1]);
    if(e.key==='ArrowDown'&&i<order.length-1)list.insertBefore(button,order[i+1].nextSibling);
    button.focus();persist();
  },true);
  done.addEventListener('click',()=>setEditing(false));
  doc.addEventListener('hub:navigation-layout',()=>{if(editing)setEditing(false);});
  return { finish:()=>setEditing(false) };
}

module.exports = { STORAGE_KEY, normalizeNavigationOrder, installNavigationOrder };
