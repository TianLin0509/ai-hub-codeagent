'use strict';

// A logical turn is a workflow unit; a display message is a provider item.
// Keep this projection out of final-answer extraction and runtime decisions.
function displayTurns(turns) {
  const projected = (turns || []).flatMap(turn => {
    if (!Array.isArray(turn.displayMessages)) return [turn];
    const { displayMessages, ...base } = turn;
    const cards = displayMessages.filter(m => m && m.id && m.text).map(m => ({
      ...base, ...m, role: 'assistant', logicalTurnId: turn.id,
      thinking: null, toolCalls: [], usage: undefined, durationMs: undefined,
      nativeOutcome: null, presentation: undefined,
    }));
    // Tools and reasoning have their own stable, collapsed activity row. They
    // must never migrate between progress and final messages as items arrive.
    if (turn.thinking || turn.toolCalls?.length || !cards.length) cards.push({
      ...base, id: `${turn.id}:activity`, logicalTurnId: turn.id,
      text: '', phase: 'activity',
      nativeOutcome: cards.length && turn.nativeOutcome === 'completed' ? null : turn.nativeOutcome,
    });
    // Message completion is not turn completion. Keep one display-only link
    // to the logical turn, owned by its last result (never each progress item).
    const owner = [...cards].reverse().find(m => ['final_answer', 'final'].includes(m.phase))
      || [...cards].reverse().find(m => !['commentary', 'activity'].includes(m.phase));
    if (owner) owner.deliveryContext = {
      id: turn.id, source: turn.source, nativeOutcome: turn.nativeOutcome,
      stopReason: turn.stopReason, text: turn.text, toolCalls: turn.toolCalls,
    };
    if (owner && turn.source === 'claude-stream-json') {
      owner.usage = turn.usage;
      owner.durationMs = turn.durationMs ?? (turn.tsEnd > turn.ts ? turn.tsEnd - turn.ts : undefined);
      for (const card of cards) if (card.phase === 'activity') {
        card.usage = undefined; card.durationMs = undefined; card.tsEnd = card.ts;
      }
    }
    return cards;
  });
  // Steering inserts another user item inside the same App Server turn.
  // Restore provider item order instead of moving every user above every AI.
  for(let start=0;start<projected.length;) {
    const key=projected[start].displayTurnKey;
    let end=start+1;
    if(key)while(end<projected.length && projected[end].displayTurnKey===key)end++;
    if(key)projected.splice(start,end-start,...projected.slice(start,end)
      .sort((a,b)=>(a.itemOrder ?? Infinity)-(b.itemOrder ?? Infinity)));
    start=end;
  }
  return projected;
}

// Only provider-generated attachment envelopes are stripped. A literal <image>
// in a user prompt or code sample remains ordinary user text.
function userTextIdentity(text) {
  return String(text || '')
    .replace(/<image\b(?=[^>]*\bname=)(?=[^>]*\bpath=)[^>]*>\s*<\/image>/gi, ' ')
    .replace(/<image\b[^>]*\b(?:name|path)=[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function groupDisplayMessages(message, stored) {
  if(!Array.isArray(stored) || !stored.length)return undefined;
  const messages=stored.slice().sort((a,b)=>Number(a.phase==='activity')-Number(b.phase==='activity'));
  const text=String(message.content || '').trim();
  const settled=['completed','manual_extracted','errored','interrupted'].includes(message.status);
  if(settled && text && !messages.some(m=>m.text.trim()===text)
    && messages.map(m=>m.text).join('\n\n').trim()!==text) {
    messages.push({id:`${message.id}:result`,text,phase:'final_answer',ts:message.updatedAt || message.createdAt});
  }
  return messages.sort((a,b)=>Number(a.phase==='activity')-Number(b.phase==='activity'));
}

module.exports = { displayTurns, userTextIdentity, groupDisplayMessages };
