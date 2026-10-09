'use strict';
// One answer per web account: is the login fine, lost, or not known yet.
//
// Proof that the login works: a check that saw the account signed in (its login cookie, or
// a website check the person asked for), or a tool (生图 / 圆桌 / 中转) that finished a job on
// it. A lost login: a check that saw it signed out, or a tool that hit a login wall. The newer
// wins. Opening the page moves "上次同步" but proves nothing.
//
// A human-verification wall that a tool met is not a lost login: the person browsing the
// same site is usually fine (2026-10-07: the second ChatGPT account read "需要人机验证" while
// it worked normally). It is shown as a note about the web tools and never raises the badge.
// A site never seen signed in that a check found signed out is just "not signed in".
const TOOL_LABEL = { images: '生图', roundtable: '网页圆桌', bridge: '中转' };
// Pauses that say nothing about this login: set by the Hub's own check or as a safety hold.
const QUIET_PAUSE = new Set(['account-check']);

function accountHealth({ site = {}, activity, paused, now = Date.now() } = {}) {
  const proofs = [], lost = [], walls = [];
  const byCheck = site.source === 'cookie' ? 'cookie' : 'check';
  if (site.checkedAt && site.verified !== false && site.reason !== 'headless_challenge') {
    if (site.state === 'signed_in') proofs.push({ at: site.checkedAt, by: byCheck });
    else if (site.state === 'signed_out') lost.push({ at: site.checkedAt, by: byCheck, kind: 'signed_out' });
  }
  // An earlier check that saw it signed in: kept when a later check overwrote the result.
  if (site.lastSignedInAt && site.lastSignedInAt !== site.checkedAt) proofs.push({ at: site.lastSignedInAt, by: 'check' });
  for (const [source, step] of Object.entries(activity?.sources || {})) {
    if (!TOOL_LABEL[source]) continue;
    if (step.lastSuccessAt) proofs.push({ at: step.lastSuccessAt, by: source });
    if (step.outcome === 'login_required') lost.push({ at: step.at, by: source, kind: 'signed_out' });
    else if (step.outcome === 'verification_required') walls.push({ at: step.at, by: source });
  }
  if (paused && paused.until > now && !QUIET_PAUSE.has(paused.source) && !['safety_hold', 'cooldown'].includes(paused.kind)) walls.push({ at: paused.at || paused.since || now, by: 'paused', until: paused.until });
  const latest = list => list.reduce((a, b) => (b.at > (a?.at || 0) ? b : a), null);
  const proof = latest(proofs), problem = latest(lost);
  // A cookie says the login is there, not that automation gets past the site's check.
  const toolProof = latest(proofs.filter(p => p.by !== 'cookie'));
  const wall = latest(walls);
  const openedAt = activity?.openedAt || 0;
  const synced = [proof, openedAt ? { at: openedAt, by: 'opened' } : null].reduce((a, b) => (b && b.at > (a?.at || 0) ? b : a), null);
  const base = { syncedAt: synced?.at || 0, syncedBy: synced?.by || '', proofAt: proof?.at || 0, proofBy: proof?.by || '',
    ...(wall && wall.at > (toolProof?.at || 0) ? { automation: wall } : {}) };
  if (problem && problem.at > (proof?.at || 0)) {
    if (!proof && ['check', 'cookie'].includes(problem.by)) return { ...base, state: 'off', problem };
    return { ...base, state: 'attention', problem };
  }
  return { ...base, state: proof ? 'ok' : 'unknown' };
}
module.exports = { accountHealth, TOOL_LABEL };
