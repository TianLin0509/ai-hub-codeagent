'use strict';

// Reading state belongs to the source message, not the current DOM position.
const choices = new Map();
const boundDocuments = new WeakSet();
function key(details) {
  const card = details.closest?.('[data-turn-id], [data-gc-msg-id]');
  if (!card) return null;
  const message = details.closest('[data-message-id]');
  return JSON.stringify([card.dataset.sessionId || card.dataset.sourceSid || '',
    card.dataset.turnId || card.dataset.gcMsgId, message?.dataset.messageId || '', details.className]);
}
function restore(card) {
  const doc = card?.ownerDocument;
  if (!doc) return;
  if (!boundDocuments.has(doc)) {
    boundDocuments.add(doc);
    // Record the explicit action before a synchronous live patch can replace it.
    // Programmatic `open` restoration must never overwrite the user's choice.
    doc.addEventListener('click', event => {
      const summary = event.target.closest?.('summary');
      const details = summary?.parentElement;
      if (!details?.matches('details.conversation-long-message')) return;
      const id = key(details);
      if (id) choices.set(id, !details.open);
    }, true);
  }
  for (const details of card.querySelectorAll('details.conversation-long-message')) {
    const id = key(details);
    if (choices.has(id)) details.open = choices.get(id);
  }
}
module.exports = { key, restore };
