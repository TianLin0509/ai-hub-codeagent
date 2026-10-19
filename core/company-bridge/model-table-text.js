'use strict';
// 公司模型表（2026-10-18 按模型派活）在家里一端的整理与文字说明：家里 Hub 收到后清洗存下，
// 家里「问公司」MCP 列工具时、命令行 models 子命令和工具返回里用同一套写法讲给家里的 Agent。
// 模型表由公司一端 core/codeagent-model-route.js modelTable 生成，只有模型名、号数、忙闲，不含账号名。

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,95}$/;
const int = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

function sanitizeModelTable(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return null;
  const models = [];
  for (const m of raw.models.slice(0, 20)) {
    if (!m || !MODEL_ID.test(String(m.id || ''))) continue;
    if (models.some(x => x.id.toLowerCase() === String(m.id).toLowerCase())) continue;
    models.push({ id: String(m.id), label: String(m.label || m.id).slice(0, 40), primary: m.primary === true,
      accounts: int(m.accounts), working: int(m.working), free: Number.isFinite(Number(m.free)) ? int(m.free) : 0 });
  }
  const parallel = raw.parallel && typeof raw.parallel === 'object' ? { cap: int(raw.parallel.cap), working: int(raw.parallel.working) } : null;
  const table = { schema: 1, at: Number(raw.at) || null, peak: raw.peak === true, models, parallel };
  // 号 + 模型（2026-10-18 额度感知）：每个号一行，只有代称（个人 / 号 N），避让状态与原因、预计恢复、Credit。
  if (Array.isArray(raw.accountRows)) {
    table.accountRows = [];
    for (const a of raw.accountRows.slice(0, 20)) {
      const alias = String(a && a.alias || '');
      if (!ALIAS.test(alias) || table.accountRows.some(x => x.alias === alias)) continue;
      const av = a.avoid && typeof a.avoid === 'object' ? a.avoid : null;
      const cr = a.credit && typeof a.credit === 'object' && Number.isFinite(Number(a.credit.remaining)) ? a.credit : null;
      table.accountRows.push({ alias, pool: a.pool === true, models: (Array.isArray(a.models) ? a.models : []).map(String).filter(m => MODEL_ID.test(m)).slice(0, 20),
        defaultModel: MODEL_ID.test(String(a.defaultModel || '')) ? String(a.defaultModel) : '', activeSessions: int(a.activeSessions), working: int(a.working), free: int(a.free),
        avoid: av ? { kind: String(av.kind || 'quota').slice(0, 20), source: String(av.source || 'error').slice(0, 20), since: Number(av.since) || null,
          until: av.until == null ? null : Number(av.until) || null, reason: String(av.reason || '').replace(/[\r\n]+/g, ' ').slice(0, 300) } : null,
        // 默认模型和权限不符（个人账号，2026-10-19）：一句话说明，模型名原样
        ...(a.configNote ? { configNote: String(a.configNote).replace(/[\r\n]+/g, ' ').slice(0, 200) } : {}),
        credit: cr ? { remaining: Number(cr.remaining), pct: Number(cr.pct) || 0, bucket: String(cr.bucket || '').slice(0, 20), at: Number(cr.at) || null } : null });
    }
  }
  return table;
}
const ALIAS = /^(个人|号 \d{1,2})$/;

const clock = ms => { const d = new Date(Number(ms) + 8 * 3600000); return d.toISOString().slice(5, 16).replace('T', ' '); };

// 一个模型一行：名字（主力）：几个号能用，通道在处理几个，还能并行几个。
function describeModels(table, receivedAt) {
  if (!table || !Array.isArray(table.models) || !table.models.length) return '模型表未知（公司还没报过，或公司 Hub 版本较旧）：可以不指定模型，用公司默认';
  const head = `公司模型表（${receivedAt ? clock(receivedAt) + ' 收到；' : ''}公司现在是${table.peak ? '工作日忙时' : '闲时'}）：`;
  const lines = table.models.map(m => `- ${m.id}${m.primary ? '（日常主力）' : ''}：${m.accounts} 个号能用${m.avoided ? `（其中 ${m.avoided} 个在避让中）` : ''}，通道在处理 ${m.working} 个，还能并行 ${m.free} 个${m.free === 0 ? '（现在指定它会排队）' : ''}`);
  return [head, ...lines, ...describeAccounts(table)].join('\n');
}
// 各号一行：代称、模型、进行中会话、避让状态（原因、预计恢复）、Credit。
function describeAccounts(table) {
  const rows = table && Array.isArray(table.accountRows) ? table.accountRows : [];
  if (!rows.length) return [];
  return ['各号（account 参数用这里的代称）：', ...rows.map(a => {
    const state = a.avoid ? `避让中：${a.avoid.reason || '额度用完或限流'}` : `可用，还能并行 ${a.free} 个`;
    const credit = a.credit ? `，Credit 剩 ${a.credit.remaining}（${a.credit.pct}%${a.credit.bucket ? '，' + a.credit.bucket : ''}）` : '';
    const note = (a.configNote ? `；${a.configNote}（可用 company_act set-personal-model 修正）` : '') + (a.defaultNote ? `；${a.defaultNote}，不参与按模型派活` : '');
    return `- ${a.alias}：${a.defaultModel || (a.defaultNote ? '默认模型未知' : a.models[0] || '模型未知')}${a.models.length > 1 ? `（可切：${a.models.join('、')}）` : ''}，进行中 ${a.activeSessions} 个，${state}${credit}${note}`;
  })];
}

// ask_company 的工具描述里关于模型的一段：模型表 + 选择原则；模型表未知时如实说。
function modelGuide(entry) {
  const table = entry && entry.table;
  const known = table && Array.isArray(table.models) && table.models.length;
  const principle = '选模型（model 参数，可不填）：简单查询、定位、只读一两个文件 → 非主力或空闲的模型（如 DeepSeek）；跨模块推理、算法细节核对 → 日常主力模型（如 GLM）；'
    + '工作日忙时同事们都在用主力模型，简单任务优先交给非主力模型分流。还能并行为 0 的模型会排队，不急的可以换一个。'
    + '不填 = 公司默认（与以前相同）。模型名必须是表里的，写错会报错并列出可选项，不会被悄悄换成别的模型；指定的模型公司没有可用的号时不开会话、回执写明原因，可换模型重问。追问沿用原会话的模型。\n'
    + '选号（account 参数，可不填，写代称如「个人」「号 1」）：默认不填，交给公司自动路由——它会避开额度用完、限流或被暂停的号，撞到额度的轮次会自动换号重做一次；'
    + '只有明确理由才指定（例如要在某个号上复现、对比两个号的回答）。指定的号在避让中会直接报错并给出现在可用的号，不发出。';
  return (known ? describeModels(table, entry.receivedAt) : '模型表未知（公司还没报过，或公司 Hub 版本较旧）：可以不填 model；填了由公司核对，不认识会报错。') + '\n' + principle;
}

module.exports = { MODEL_ID, ALIAS, sanitizeModelTable, describeModels, describeAccounts, modelGuide };
