'use strict';

// Local read only: unlike the dashboard's recent-60 feed, a session keeps all
// of its conversations across restarts. Both bridge directions share storage.
function sessionHistory(db, role, sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) throw new Error('会话编号无效');
  const read = table => db.prepare(`SELECT payload FROM ${table} WHERE json_extract(payload, '$.sessionId')=? ORDER BY updated DESC`)
    .all(sessionId).map(row=>JSON.parse(row.payload));
  return {ok:true,role,threads:read('bridge_threads'),
    ...(role==='home' ? {consults:read('consult_threads')} : {askHome:read('home_threads')})};
}
module.exports={sessionHistory};
