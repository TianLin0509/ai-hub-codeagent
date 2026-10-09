'use strict';

// CP1252 is the Western decoding seen in the supplied screenshot. Use built-in
// decoders; never transcode normal Unicode, output streams or saved history.
const WESTERN = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
function westernByte(char) {
  const cp = char.codePointAt(0);
  if (cp < 256) return cp;
  const index = WESTERN.indexOf(char);
  return index < 0 ? null : index + 128;
}
const chineseCount = text => (text.match(/[\u3400-\u9fff]/g) || []).length;
function recoverRun(run) {
  if (run.length < 12 || !/[\u0080-\u00ff\u2010-\u203f\u20ac]/.test(run)) return run;
  const bytes = Uint8Array.from(Array.from(run,westernByte));
  for (const encoding of ['utf-8','gbk']) {
    let restored;
    try { restored = new TextDecoder(encoding,{fatal:true}).decode(bytes); }
    catch (_) { continue; }
    // High confidence only. Accented names, math, code, and short snippets
    // remain unchanged. The user must still review any proposed restoration.
    const punctuation = (run.match(/£[¬º¡¿»«]|¡[£¢°±]/g) || []).length;
    const utf8Markers = (run.match(/[äåæçèé][\u0080-\u00bf\u2010-\u203f\u20ac]/g) || []).length;
    if (chineseCount(restored) >= 6 && (encoding === 'gbk' ? punctuation >= 2 : utf8Markers >= 3)) return restored;
  }
  return run;
}
function inspectPasteText(text) {
  const original = String(text ?? '');
  let restored = '', run = '';
  const flush = () => { restored += recoverRun(run); run = ''; };
  for (const char of original) {
    if (westernByte(char) !== null) run += char;
    else { flush(); restored += char; }
  }
  flush();
  return restored === original ? null : {original,restored};
}

const pending = new WeakMap();
function choosePasteText(text,{document:doc}) {
  const candidate = inspectPasteText(text);
  if (!candidate) return Promise.resolve(text);
  // One decision at a time. Repeated Ctrl+V while a decision is pending must
  // not append duplicates after a single click.
  if (pending.has(doc)) return Promise.resolve(null);
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  pending.set(doc,promise);
  const trigger = doc.activeElement;
  const dialog = doc.createElement('dialog');
  dialog.className = 'hub-dialog paste-encoding-dialog';
  dialog.setAttribute('aria-label','粘贴文本恢复');
  const title = doc.createElement('h2'); title.textContent = '这段文字可能有编码乱码';
  const hint = doc.createElement('p'); hint.textContent = '预览恢复后的中文，选择要粘贴的版本。';
  const preview = doc.createElement('pre'); preview.className = 'paste-encoding-preview';
  preview.textContent = candidate.restored.slice(0,1600) + (candidate.restored.length > 1600 ? '\n…' : '');
  const original = doc.createElement('details');
  const summary = doc.createElement('summary'); summary.textContent = '查看原文';
  const raw = doc.createElement('pre'); raw.textContent = candidate.original.slice(0,1600);
  original.append(summary,raw);
  const actions = doc.createElement('footer'); actions.className = 'hub-dialog-actions';
  let finished = false;
  const finish = value => {
    if (finished) return; finished = true;
    if (dialog.open) dialog.close(); dialog.remove(); pending.delete(doc);
    if (trigger?.isConnected) trigger.focus({preventScroll:true});
    resolve(value);
  };
  for (const [key,label,value] of [['cancel','取消',null],['original','保留原文',candidate.original],['restore','恢复中文并粘贴',candidate.restored]]) {
    const button = doc.createElement('button'); button.type = 'button';
    button.className = 'hub-button' + (key === 'restore' ? ' hub-button-primary' : '');
    button.dataset.pasteChoice = key; button.textContent = label; button.autofocus = key === 'cancel';
    button.addEventListener('click',()=>finish(value)); actions.append(button);
  }
  dialog.append(title,hint,preview,original,actions);
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
  dialog.addEventListener('close',()=>finish(null));
  doc.body.append(dialog);
  try { dialog.showModal(); } catch (_) { finish(null); }
  return promise;
}
module.exports = {inspectPasteText,choosePasteText};
