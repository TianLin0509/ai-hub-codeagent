'use strict';

// The existing multi-select controller owns selection and clipboard feedback.
// This adapter supplies group message identity and member names, while the
// stable panel survives replacement of the conversation's child nodes.
function mountGroupCardSelection({ panel, getMeetingId, extractText, copyText }) {
  const document = panel.ownerDocument, window = document.defaultView;
  const bar = document.createElement('div');
  bar.className = 'card-multi-select-bar gc-multi-select-bar';
  bar.hidden = true;
  bar.innerHTML = '<span class="cms-count" aria-live="polite"></span>'
    + '<button type="button" class="cms-btn" data-multi-all>全选</button>'
    + '<button type="button" class="cms-btn cms-primary" data-multi-copy>一键复制</button>'
    + '<button type="button" class="cms-btn" data-multi-exit>取消</button>';
  panel.before(bar);
  const body = card => card.querySelector('.gc-journal-text') || card.querySelector('.mr-gc-bubble');
  const controller = require('./card-multi-select').createCardMultiSelectController({
    document, window, container: panel, copyText,
    getActiveSessionId: getMeetingId,
    cardSelector: '.mr-gc-msg', getCardId: card => card.dataset.gcMsgId,
    // Empty/pending/status placeholders and search-hidden cards cannot silently
    // inflate the selected count. Only the current rendered message range is selected.
    getCards: root => [...root.querySelectorAll('.mr-gc-msg[data-gc-msg-id]')]
      .filter(card => card.dataset.gcMsgId && !card.classList.contains('pending')
        && card.getClientRects().length && window.getComputedStyle(card).display !== 'none'
        && !card.querySelector('.mr-gc-empty-placeholder,.mr-gc-waiting') && body(card)?.textContent.trim()),
    getEntry: card => ({
      role: card.classList.contains('mine') ? 'user' : 'assistant',
      sender: card.querySelector('.mr-gc-name')?.textContent.trim() || 'AI',
      text: extractText(body(card)),
      time: card.dataset.readTurn ? `第 ${card.dataset.readTurn} 轮` : '',
    }),
    elements: { bar, count: bar.querySelector('.cms-count'), all: bar.querySelector('[data-multi-all]'),
      copy: bar.querySelector('[data-multi-copy]'), exit: bar.querySelector('[data-multi-exit]') },
  });
  controller.init();
  const enter = event => {
    const button = event.target.closest('[data-gc-multi-select]');
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    panel.querySelector('.mr-gc-messages')?._cardFollowController?.pause();
    controller.enter(button.closest('.mr-gc-msg')?.dataset.gcMsgId);
  };
  panel.addEventListener('click', enter);
  return {
    sync() { controller.setVisible(!!getMeetingId()); controller.syncDom(); },
    hide() { controller.setVisible(false); },
    destroy() { controller.destroy(); panel.removeEventListener('click', enter); bar.remove(); },
  };
}

module.exports = { mountGroupCardSelection };
