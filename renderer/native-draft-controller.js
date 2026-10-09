'use strict';

// One serialized stream per session. Main owns the durable revision; a stale
// window can retain its text but cannot overwrite a newer saved draft.
function createNativeDraftController({ sessionId, invoke, initialText = '', onRestore, onStatus }) {
  let view = { onRestore, onStatus }, current = null, pending, saving = false, failure = null;
  let changedBeforeRead = false;
  let desired = initialText;
  let activeSave = null;
  const status = error => view.onStatus?.(error, { saving: saving || pending !== undefined || !current });
  function pump() {
    if (saving) return activeSave;
    if (!current || failure || pending === undefined) return;
    saving = true;
    activeSave = (async () => {
      // Publish the promise before invoking callbacks that may change the draft.
      await Promise.resolve();
      try {
        while (!failure && pending !== undefined) {
          const text = pending; pending = undefined; status(null);
          const response = await invoke('native-draft:save', { sessionId, text, revision: current.revision });
          if (!response?.ok) throw new Error(response?.error || '草稿未能保存');
          current = response.record;
        }
      } catch (error) { failure = error; }
      finally { saving = false; status(failure); }
    })();
    return activeSave;
  }
  const ready = (async () => {
    try {
      const response = await invoke('native-draft:read', { sessionId });
      if (!response?.ok) throw new Error(response?.error || '草稿未能读取');
      current = response.record;
      if (changedBeforeRead) {
        if (current.text && current.text !== initialText && current.text !== pending) {
          throw new Error('读取到了另一份已保存草稿；本框新输入尚未保存，请先复制保存后重新打开');
        }
      } else if (current.text !== null) {
        if (initialText && current.text !== initialText) throw new Error('本框草稿与已保存版本不同；请先复制保留后重新打开');
        desired = current.text;
        view.onRestore?.(current.text);
      } else if (initialText) pending = initialText; // one-time import from the old browser draft
      await pump(); status(failure);
    } catch (error) { failure = error; status(error); }
  })();
  return {
    ready,
    async flush() {
      await ready;
      while (!failure && (saving || pending !== undefined)) await pump();
      if (failure) throw failure;
    },
    change(text) {
      if (typeof text !== 'string') throw new TypeError('Draft must be text');
      if (!saving && pending === undefined && !failure && current?.text === text) return;
      desired = text;
      if (!current) changedBeforeRead = true;
      pending = text; void pump(); status(failure);
    },
    attach(nextView) {
      view = nextView;
      if (current && !failure) view.onRestore?.(desired);
      status(failure);
    },
    get state() { return { current, pending, saving, failure }; },
  };
}
module.exports = { createNativeDraftController };
