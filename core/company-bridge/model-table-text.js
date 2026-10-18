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
  return { schema: 1, at: Number(raw.at) || null, peak: raw.peak === true, models, parallel };
}

const clock = ms => { const d = new Date(Number(ms) + 8 * 3600000); return d.toISOString().slice(5, 16).replace('T', ' '); };

// 一个模型一行：名字（主力）：几个号能用，通道在处理几个，还能并行几个。
function describeModels(table, receivedAt) {
  if (!table || !Array.isArray(table.models) || !table.models.length) return '模型表未知（公司还没报过，或公司 Hub 版本较旧）：可以不指定模型，用公司默认';
  const head = `公司模型表（${receivedAt ? clock(receivedAt) + ' 收到；' : ''}公司现在是${table.peak ? '工作日忙时' : '闲时'}）：`;
  const lines = table.models.map(m => `- ${m.id}${m.primary ? '（日常主力）' : ''}：${m.accounts} 个号能用，通道在处理 ${m.working} 个，还能并行 ${m.free} 个${m.free === 0 ? '（现在指定它会排队）' : ''}`);
  return [head, ...lines].join('\n');
}

// ask_company 的工具描述里关于模型的一段：模型表 + 选择原则；模型表未知时如实说。
function modelGuide(entry) {
  const table = entry && entry.table;
  const known = table && Array.isArray(table.models) && table.models.length;
  const principle = '选模型（model 参数，可不填）：简单查询、定位、只读一两个文件 → 非主力或空闲的模型（如 DeepSeek）；跨模块推理、算法细节核对 → 日常主力模型（如 GLM）；'
    + '工作日忙时同事们都在用主力模型，简单任务优先交给非主力模型分流。还能并行为 0 的模型会排队，不急的可以换一个。'
    + '不填 = 公司默认（与以前相同）。模型名必须是表里的，写错会报错并列出可选项，不会被悄悄换成别的模型；指定的模型公司没有可用的号时不开会话、回执写明原因，可换模型重问。追问沿用原会话的模型。';
  return (known ? describeModels(table, entry.receivedAt) : '模型表未知（公司还没报过，或公司 Hub 版本较旧）：可以不填 model；填了由公司核对，不认识会报错。') + '\n' + principle;
}

module.exports = { MODEL_ID, sanitizeModelTable, describeModels, modelGuide };
