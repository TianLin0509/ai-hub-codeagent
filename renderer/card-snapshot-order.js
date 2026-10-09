'use strict';

// 增量刷新挂上的新卡按快照顺序就位：插到下一张已在页面上的卡之前；
// 快照里排在最后的新卡（真正更新的内容）留在末尾。已有卡的位置不动。
// ids 是本次快照的卡片 id（已按显示顺序），idsBefore 是挂载前页面上已有的 id。
function placeNewCardsInSnapshotOrder(container, ids, idsBefore, cardFor) {
  let anchor = null, moved = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const card = id && cardFor(id);
    if (!card) continue;
    if (anchor && !idsBefore.has(id) && card.nextElementSibling !== anchor) {
      container.insertBefore(card, anchor);
      moved++;
    }
    anchor = card;
  }
  return moved;
}

module.exports = { placeNewCardsInSnapshotOrder };
