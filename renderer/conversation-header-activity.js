'use strict';

function renderHeaderActivity(content = '', count = '', hidden = false) {
  return `<details class="conversation-header-activity" data-copy-exclude${hidden ? ' hidden' : ''}><summary title="展开或收起活动记录">活动${count === '' ? '' : ' ' + count}</summary><div class="conversation-header-activity-panel">${content}</div></details>`;
}

// Keep original cards as stable source anchors. Only their disclosure nodes
// move; result copy / show-all still resolve the source turn via data-turn.
function restoreActivitySources(container) {
  if (!container?.querySelectorAll) return;
  for (const node of container.querySelectorAll('[data-activity-source]')) {
    const source = node._activitySource;
    if (source?.parentElement === container) source.querySelector('.turn-content').appendChild(node);
    else node.remove();
  }
}

function syncHeaderActivities(container, responseCards) {
  if (!container?.querySelectorAll) return;
  restoreActivitySources(container);
  const seen = new Set();
  for (const card of container.querySelectorAll(':scope > .turn-card')) {
    if (seen.has(card)) continue;
    const group = responseCards(card);
    group.forEach(c => seen.add(c));
    const host = group[0];
    const disclosure = host.querySelector('.conversation-header-activity');
    if (!disclosure) continue;
    const panel = disclosure.querySelector('.conversation-header-activity-panel');
    let count = 0, hasActivity = false;
    for (const source of group) {
      source.classList.remove('conversation-activity-relocated');
      const own = source.querySelector('.conversation-header-activity');
      if (own && own !== disclosure) own.hidden = true;
      const content = source.querySelector('.turn-content');
      for (const node of content.querySelectorAll(':scope > .turn-activity-rail, :scope > .turn-thinking')) {
        node._activitySource = source;
        node.dataset.activitySource = source.dataset.turnId;
        panel.appendChild(node);
        hasActivity = true;
        if (node.classList.contains('turn-activity-rail')) count += Number(node.dataset.activityCount || 0);
      }
      // Empty activity cards add no second row, avatar, timestamp or duration.
      // An interrupted/failed outcome still has a visible body at its source.
      if (source !== host && source.dataset.phase === 'activity' && content.querySelector('.turn-body-empty')) {
        source.classList.add('conversation-activity-relocated');
      }
    }
    disclosure.hidden = !hasActivity;
    disclosure.querySelector('summary').textContent = '活动' + (count ? ' ' + count : '');
  }
}

module.exports = { renderHeaderActivity, restoreActivitySources, syncHeaderActivities };
