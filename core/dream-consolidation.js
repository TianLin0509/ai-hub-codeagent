'use strict';
// core/dream-consolidation.js
//
// Seed / memory 孤岛整理器：把被改过的 seed AGENTS.md 副本和 Claude memory
// 孤岛桶蒸馏进分层规则文件。它**不采集普通 Session transcript**；UI 必须如实
// 展示这个边界，不能把定时运行等同于完整的跨 Session 自动沉淀。
//
// 设计约定（2026-07-31，与用户对齐）：
// - 改动自动落盘，不逐条征求同意；但每一次写入都必须可回溯、可回滚：
//   写前快照到 consolidation/snapshots/，写后追加 changelog.jsonl。
// - 自动规则只写进目标文件末尾的托管区（<!-- dream:begin/end -->），
//   绝不动手写区——月度压缩或人工整理时再并入正文。
// - 证据驱动：LLM 返回的每条沉淀必须带原文引用，无证据降级到 staging。
// - 进 LLM 前机械脱敏；目标文件白名单之外的路径一律拒写。
//
// 无 LLM 配置（默认 deepseek-api 缺 key）时不算失败：退化为「只采集」，
// 候选写进 changelog 等配置就绪后再跑。这是显式降级，summary.note 会写明。

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { projectSlug } = require('./claude-transcript-locator.js');

const DREAM_BEGIN = '<!-- dream:begin -->';
const DREAM_END = '<!-- dream:end -->';
const DREAM_SECTION_TITLE = '## 梦境沉淀（AI Hub 自动维护；要改规则请移到上面正文区，本区内容会被重写）';

const TARGET_LAYERS = new Set(['user_global', 'workspace', 'project', 'memory', 'staging']);
const MAX_CLAIM_CHARS = 300;
const MAX_EVIDENCE_CHARS = 400;
const MAX_ENTRIES_PER_CANDIDATE = 5;

const DEFAULT_CONSOLIDATION_CONFIG = {
  enabled: true,
  schedule: '03:40',
  provider: 'deepseek-api',
  model: 'deepseek-chat',
  maxCandidatesPerRun: 12,
  maxInputCharsPerCandidate: 12000,
  autoApply: true,
};

// ---------------------------------------------------------------------------
// 配置

function normalizeConsolidationConfig(raw) {
  const cfg = { ...DEFAULT_CONSOLIDATION_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.autoApply = cfg.autoApply !== false;
  cfg.schedule = /^\d{1,2}:\d{2}$/.test(String(cfg.schedule)) ? String(cfg.schedule) : DEFAULT_CONSOLIDATION_CONFIG.schedule;
  cfg.provider = String(cfg.provider || DEFAULT_CONSOLIDATION_CONFIG.provider);
  cfg.model = String(cfg.model || '').trim() || (cfg.provider === 'deepseek-api' ? 'deepseek-chat' : '');
  cfg.maxCandidatesPerRun = Math.max(1, Math.min(50, parseInt(cfg.maxCandidatesPerRun, 10) || DEFAULT_CONSOLIDATION_CONFIG.maxCandidatesPerRun));
  cfg.maxInputCharsPerCandidate = Math.max(2000, Math.min(60000, parseInt(cfg.maxInputCharsPerCandidate, 10) || DEFAULT_CONSOLIDATION_CONFIG.maxInputCharsPerCandidate));
  return cfg;
}

// ---------------------------------------------------------------------------
// 小工具

function dateSlug(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function todayStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 进 LLM 前的机械脱敏。宁可误伤（把正常文本打码）也不能漏密钥进第三方 API。
function redactSecrets(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***')
    .replace(/(api[_-]?key|apikey|secret|token|password|passwd|authorization)(\s*[:=]\s*["']?)[^\s"'\]]{6,}/gi,
      '$1$2***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer ***REDACTED***');
}

function isSymlinkOrJunction(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// seed 副本状态判定（与 workspace-service 的 seed-sha256 机制对齐）

function splitSeedHeader(content) {
  const m = String(content).match(/^<!--[\s\S]*?-->\r?\n\r?\n/);
  if (!m || !/由 AI Hub/.test(m[0])) return { header: null, body: String(content) };
  return { header: m[0], body: String(content).slice(m[0].length) };
}

function bodyHash(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

// 返回 'synced'（原样副本）| 'modified'（本地被改，知识待沉淀）| 'own'（非 Hub 托管）| null（无文件）
function seedCopyStatus(agentsPath) {
  if (!fileExists(agentsPath)) return null;
  let content;
  try { content = fs.readFileSync(agentsPath, 'utf8'); } catch { return null; }
  const { header, body } = splitSeedHeader(content);
  if (!header) return 'own';
  const marked = header.match(/seed-sha256:\s*([0-9a-f]{16})/);
  if (!marked) return 'own';
  return marked[1] === bodyHash(body) ? 'synced' : 'modified';
}

// ---------------------------------------------------------------------------
// 采集

function collectAgentsDiffCandidates(scratchRoot, maxChars, logger) {
  const candidates = [];
  let entries = [];
  try { entries = fs.readdirSync(scratchRoot, { withFileTypes: true }); } catch { return candidates; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scratchRoot, entry.name);
    const agentsPath = path.join(dir, 'AGENTS.md');
    if (seedCopyStatus(agentsPath) !== 'modified') continue;
    let content = '';
    try { content = fs.readFileSync(agentsPath, 'utf8'); } catch { continue; }
    const { body } = splitSeedHeader(content);
    candidates.push({
      kind: 'agents-diff',
      cwd: dir,
      sourcePath: agentsPath,
      excerpt: redactSecrets(body).slice(0, maxChars),
      truncated: body.length > maxChars,
    });
  }
  if (candidates.length) logger.log?.(`[dream] 发现 ${candidates.length} 份被改过的 seed AGENTS.md 副本`);
  return candidates;
}

function collectMemoryIslandCandidates(homeDir, maxChars, logger) {
  const candidates = [];
  // 规范库自身不是孤岛：它是所有 junction 的目标，内容本来就是共享的。
  // 同一个坑已经在巡检器和 mergeIslandBucket 各绊过一次（2026-08-01），这是第三处。
  const canonical = path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory');
  for (const root of ['.claude', '.claude-deepseek']) {
    const projectsDir = path.join(homeDir, root, 'projects');
    let buckets = [];
    try { buckets = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const memoryDir = path.join(projectsDir, bucket.name, 'memory');
      if (path.resolve(memoryDir) === path.resolve(canonical)) continue;
      // 已是 junction → 记忆已并入规范库，没有孤岛；真实目录且有文件才是孤岛。
      if (!dirExists(memoryDir) || isSymlinkOrJunction(memoryDir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(memoryDir, { withFileTypes: true })
          .filter(f => f.isFile() && /\.md$/i.test(f.name)).map(f => f.name);
      } catch { continue; }
      if (!files.length) continue;
      const parts = [];
      let used = 0;
      for (const name of files.sort()) {
        const fp = path.join(memoryDir, name);
        let text = '';
        try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        const room = maxChars - used;
        if (room <= 200) break;
        const clipped = redactSecrets(text).slice(0, Math.min(room, 4000));
        parts.push(`### ${name}\n${clipped}`);
        used += clipped.length;
      }
      candidates.push({
        kind: 'memory-island',
        cwd: bucket.name,
        sourcePath: memoryDir,
        excerpt: parts.join('\n\n'),
        truncated: used >= maxChars,
      });
    }
  }
  if (candidates.length) logger.log?.(`[dream] 发现 ${candidates.length} 个 memory 孤岛桶`);
  return candidates;
}

function collectCandidates(opts) {
  const { workspaceRoot, homeDir, config, logger } = opts;
  const maxChars = config.maxInputCharsPerCandidate;
  const scratchRoot = path.join(workspaceRoot, '_scratch');
  const all = [
    ...collectAgentsDiffCandidates(scratchRoot, maxChars, logger),
    ...collectMemoryIslandCandidates(homeDir, maxChars, logger),
  ];
  // 内容指纹：同一候选内容不变时下轮直接跳过蒸馏——同一个孤岛桶不值得每天烧一次 token。
  for (const c of all) {
    c.contentHash = crypto.createHash('sha256').update(c.excerpt || '', 'utf8').digest('hex').slice(0, 16);
  }
  const capped = all.slice(0, config.maxCandidatesPerRun);
  if (all.length > capped.length) {
    logger.warn?.(`[dream] 候选 ${all.length} 个超过上限 ${capped.length}，本次只处理前 ${capped.length} 个，其余下轮再说`);
  }
  return { candidates: capped, overflow: all.length - capped.length };
}

// ---------------------------------------------------------------------------
// LLM 通道

function postJson(endpoint, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      timeout: timeoutMs,
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => req.destroy(new Error(`llm request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const CLI_PROVIDERS = {
  'claude-cli': { cmd: 'claude', args: ['-p'] },
  'codex-cli': { cmd: 'codex', args: ['exec'] },
  'kimi-cli': { cmd: 'kimi', args: ['-p'] },
  'gemini-cli': { cmd: 'gemini', args: ['-p'] },
};

function callCliLlm(provider, prompt, timeoutMs) {
  const spec = CLI_PROVIDERS[provider];
  if (!spec) return Promise.reject(new Error(`未知 CLI provider: ${provider}`));
  return new Promise((resolve, reject) => {
    // prompt 走 stdin，避免 Windows 命令行长度上限与引号转义问题。
    const child = spawn(spec.cmd, spec.args, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(reject, new Error(`${provider} 调用超时`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => finish(reject, new Error(`${provider} 启动失败: ${e.message}`)));
    child.on('close', code => {
      if (code === 0 && stdout.trim()) finish(resolve, stdout);
      else finish(reject, new Error(`${provider} 退出码 ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 统一的 LLM 调用入口。deepseek-api 走 HTTP；其余走本机 CLI 订阅（headless）。
async function callLlm({ provider, model, deepseekApiKey, system, user, timeoutMs = 90000 }) {
  if (provider === 'deepseek-api') {
    if (!deepseekApiKey) throw new Error('DeepSeek API Key 未配置（consolidation 需要它，或改用 claude-cli 等订阅通道）');
    const { status, body } = await postJson('https://api.deepseek.com/chat/completions', {
      model: model || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }, { authorization: `Bearer ${deepseekApiKey}` }, timeoutMs);
    if (status !== 200) throw new Error(`DeepSeek HTTP ${status}: ${String(body).slice(0, 200)}`);
    const parsed = JSON.parse(body);
    const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
    if (!content) throw new Error('DeepSeek 返回为空');
    return content;
  }
  return callCliLlm(provider, `${system}\n\n${user}`, timeoutMs);
}

// ---------------------------------------------------------------------------
// 蒸馏（蒸馏与仲裁合并为一次调用：输入证据+目标层现状，输出结构化沉淀条目）

function buildDistillSystem(workspaceRoot) {
  return [
    '你是 AI Hub 的 seed / memory 孤岛整理器。输入只来自两类来源：被改过的临时 AGENTS.md seed 副本、Claude memory 孤岛桶。',
    '不要声称你看过普通 Session transcript、工具结果、commit/test 或用户纠正；这些不在本管线采集范围内。',
    '你的任务是从本轮明确给出的证据中提炼值得跨 session 沉淀的知识。',
    '',
    '目标层（target_layer 只能取其一）：',
    '- user_global：跨项目通用规则/偏好（同步写入用户级规则文件：Kimi/Codex 的 AGENTS.md、Claude 的 CLAUDE.md、Gemini 的 GEMINI.md）',
    `- workspace：${workspaceRoot} 工作根规则（写入 AGENTS.md+CLAUDE.md+GEMINI.md；新启动会话读取）`,
    '- project：某个具体项目专属的事实/规则（需给 project_path，必须在工作区内）',
    '- memory：反馈/偏好类记忆（写入 memory 规范库索引 MEMORY.md）',
    '- staging：拿不准、一次性、证据不足的——宁进 staging 不硬沉淀',
    '',
    '硬性要求：',
    '1. 每条必须给 evidence：从证据原文逐字引用的一小段（中文原文照抄）。没有原文支持的一律进 staging。',
    '2. claim 是一条可执行的规则或事实陈述，<=120 字，用祈使或陈述句，不要解释背景。',
    '3. 忽略以下内容：seed 副本里本来就有的模板规则（工作区边界、产物目录、Git 与迁移等套话）、',
    '   一次性的任务细节、路径里明显的临时信息、任何疑似密钥的内容。',
    '4. 最多 5 条。没有值得沉淀的就返回空 entries，这是完全正常的输出。',
    '5. 只输出 JSON，格式：{"entries":[{"target_layer":"...","project_path":"","claim":"...","type":"rule|fact|preference","confidence":0.0,"evidence":"..."}]}',
  ].join('\n');
}

function buildDistillUser(candidate, workspaceRoot) {
  const kindLabel = candidate.kind === 'agents-diff'
    ? `临时工作区 ${candidate.cwd} 的 AGENTS.md 被 session 改过（下面是改动后的全文，其中模板套话来自 ${workspaceRoot}\\AGENTS.md，新增/修改的才是知识）`
    : `一个 memory 孤岛桶（${candidate.cwd}）的内容，这些记忆没有被共享库收录`;
  return [
    `【证据来源】${kindLabel}`,
    `【证据路径】${candidate.sourcePath}`,
    '',
    candidate.excerpt,
    candidate.truncated ? '\n（证据过长已截断）' : '',
  ].join('\n');
}

function parseDistillOutput(raw) {
  let text = String(raw || '').trim();
  // CLI 通道可能裹一层 markdown fence 或前后废话；抠出第一个 { 到最后一个 }。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { entries: [], parseError: 'no-json' };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return { entries, parseError: null };
  } catch (e) {
    return { entries: [], parseError: e.message };
  }
}

function validateEntries(entries) {
  const out = [];
  for (const e of entries.slice(0, MAX_ENTRIES_PER_CANDIDATE)) {
    if (!e || typeof e !== 'object') continue;
    const layer = String(e.target_layer || '').trim();
    const claim = String(e.claim || '').trim().slice(0, MAX_CLAIM_CHARS);
    if (!claim) continue;
    const evidence = String(e.evidence || '').trim().slice(0, MAX_EVIDENCE_CHARS);
    // 无证据不许进正式层——这是防幻觉的硬门槛，不是建议。
    const finalLayer = TARGET_LAYERS.has(layer) && evidence ? layer : 'staging';
    out.push({
      target_layer: finalLayer,
      project_path: typeof e.project_path === 'string' ? e.project_path.trim() : '',
      claim,
      type: ['rule', 'fact', 'preference'].includes(e.type) ? e.type : 'rule',
      confidence: Math.max(0, Math.min(1, Number(e.confidence) || 0)),
      evidence: evidence || '(无原文证据，降级 staging)',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 落盘（托管区写入 + 快照 + changelog）

function mergeManagedSection(existing, newClaims, today) {
  const content = String(existing || '');
  const begin = content.indexOf(DREAM_BEGIN);
  const end = content.indexOf(DREAM_END);
  let before = content;
  let after = '';
  let oldLines = [];
  if (begin !== -1 && end !== -1 && end > begin) {
    before = content.slice(0, begin).replace(/\s+$/, '');
    after = content.slice(end + DREAM_END.length).replace(/^\s+/, '');
    oldLines = content.slice(begin + DREAM_BEGIN.length, end)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.startsWith('- '));
  }
  const norm = s => s.toLowerCase().replace(/[\s\p{P}\p{S}，。；：、]/gu, '');
  // 去重比的是「规则正文」而不是整行——行首日期前缀天天变，带着它比永远去不掉重。
  const claimOf = l => l.replace(/^-\s*\(\d{4}-\d{2}-\d{2}\)\s*/, '');
  const seen = new Set(oldLines.map(l => norm(claimOf(l))));
  const added = [];
  for (const c of newClaims) {
    const line = `- (${today}) ${c.claim}`;
    if (seen.has(norm(c.claim))) continue;
    seen.add(norm(c.claim));
    oldLines.push(line);
    added.push(c.claim);
  }
  const section = [DREAM_BEGIN, DREAM_SECTION_TITLE, ...oldLines, DREAM_END].join('\n');
  const parts = [before, section];
  if (after) parts.push(after);
  return { content: parts.filter(p => p !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', added };
}

// 目标层 → 实际要写的文件集合。多件套/多写保持逐字一致是用户既定规矩；
// 缺的文件不补建（同步已断的事实要让人看见）。Gemini 走 GEMINI.md 链，同权覆盖。
function resolveTargetFiles(entry, { homeDir, workspaceRoot }) {
  switch (entry.target_layer) {
    case 'user_global':
      return [
        path.join(homeDir, '.kimi-code', 'AGENTS.md'),
        path.join(homeDir, '.claude', 'CLAUDE.md'),
        path.join(homeDir, '.codex', 'AGENTS.md'),
        path.join(homeDir, '.gemini', 'GEMINI.md'),
      ];
    case 'workspace':
      return [
        path.join(workspaceRoot, 'AGENTS.md'),
        path.join(workspaceRoot, 'CLAUDE.md'),
        path.join(workspaceRoot, 'GEMINI.md'),
      ];
    case 'memory':
      return [path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory', 'MEMORY.md')];
    case 'project': {
      // 白名单校验：必须解析到工作区内、且不越出根。paranoid resolve 防 ../../ 逃逸。
      const resolved = path.resolve(String(entry.project_path || ''));
      const root = path.resolve(workspaceRoot);
      if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return [];
      return [path.join(resolved, 'AGENTS.md')];
    }
    default:
      return [];
  }
}

function appendChangelog(hubDataDir, record) {
  const dir = path.join(hubDataDir, 'consolidation');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'changelog.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
}

function snapshotBeforeWrite(hubDataDir, runId, targetPath) {
  const safeName = targetPath.replace(/[^A-Za-z0-9.-]/g, '_');
  const dir = path.join(hubDataDir, 'consolidation', 'snapshots', runId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  try { fs.copyFileSync(targetPath, dest); return dest; } catch { return null; }
}

function applyEntries(entries, ctx) {
  const { hubDataDir, homeDir, workspaceRoot, runId, autoApply, logger } = ctx;
  const result = { applied: [], staged: [], skipped: [], snapshots: [] };
  const stagingFile = path.join(hubDataDir, 'consolidation', 'staging.md');
  const today = todayStr();

  // 按目标文件分组，同一文件的多条沉淀一次读写完事。
  const byFile = new Map();
  for (const entry of entries) {
    if (entry.target_layer === 'staging' || !autoApply) {
      result.staged.push(entry);
      continue;
    }
    const files = resolveTargetFiles(entry, { homeDir, workspaceRoot });
    if (!files.length) {
      result.skipped.push({ entry, reason: 'target-not-allowed' });
      continue;
    }
    for (const f of files) {
      if (!byFile.has(f)) byFile.set(f, { layer: entry.target_layer, claims: [], entries: [] });
      byFile.get(f).claims.push(entry);
      byFile.get(f).entries.push(entry);
    }
  }

  for (const [file, group] of byFile) {
    if (!fileExists(file)) {
      // 三件套/双写里缺哪份不补建——同步已经断了的事实要让人看见，不静默修。
      result.skipped.push({ entry: group.entries[0], reason: `target-missing: ${file}` });
      logger.warn?.(`[dream] 目标文件不存在，跳过（不自动补建）：${file}`);
      continue;
    }
    const current = fs.readFileSync(file, 'utf8');
    const { content, added } = mergeManagedSection(current, group.claims, today);
    if (!added.length) {
      result.skipped.push({ entry: group.entries[0], reason: 'duplicate' });
      continue;
    }
    const snapshot = snapshotBeforeWrite(hubDataDir, runId, file);
    if (snapshot) result.snapshots.push(snapshot);
    fs.writeFileSync(file, content, 'utf8');
    result.applied.push({ file, layer: group.layer, claims: added });
    appendChangelog(hubDataDir, {
      runId, phase: 'apply', layer: group.layer, file,
      claims: added, snapshot,
      evidence: group.entries.map(e => ({ claim: e.claim, evidence: e.evidence, confidence: e.confidence })),
    });
    logger.log?.(`[dream] 沉淀 ${added.length} 条 → ${file}${snapshot ? '（快照 ' + path.basename(snapshot) + '）' : ''}`);
  }

  if (result.staged.length) {
    fs.mkdirSync(path.dirname(stagingFile), { recursive: true });
    const block = result.staged.map(e =>
      `- (${today}) [${e.target_layer}${autoApply ? '' : ' · autoApply=off'}] ${e.claim}\n  - 证据：${e.evidence}`
    ).join('\n');
    fs.appendFileSync(stagingFile, `\n## ${today}（run ${runId}）\n${block}\n`, 'utf8');
    appendChangelog(hubDataDir, { runId, phase: 'staging', file: stagingFile, count: result.staged.length, entries: result.staged });
    logger.log?.(`[dream] ${result.staged.length} 条进 staging：${stagingFile}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主流程

async function runConsolidation(opts) {
  const {
    homeDir = process.env.CLAUDE_HUB_HOME_DIR || os.homedir(),
    workspaceRoot,
    hubDataDir,
    getHubConfig,          // () => hub-config.getConfig()
    logger = console,
    now = () => Date.now(),
    llmCall = callLlm,     // 测试可注入假 LLM
    trigger = 'scheduled',
  } = opts;
  const runId = dateSlug(new Date(now()));
  const hubCfg = getHubConfig();
  const config = normalizeConsolidationConfig(hubCfg.consolidation);
  const summary = { runId, trigger, startedAt: new Date(now()).toISOString(), note: null };

  const { candidates, overflow } = collectCandidates({ workspaceRoot, homeDir, config, logger });
  // 增量去重：上一轮已成功蒸馏过的内容（指纹相同）直接跳过，LLM 失败的不标记、下轮重试。
  const prevState = readPrevState(hubDataDir);
  const processed = { ...(prevState.processed || {}) };
  const fresh = [];
  let dedupSkipped = 0;
  for (const c of candidates) {
    if (processed[c.contentHash]) dedupSkipped++;
    else fresh.push(c);
  }
  summary.candidates = candidates.length;
  summary.dedupSkipped = dedupSkipped;
  summary.overflow = overflow;
  appendChangelog(hubDataDir, {
    runId, phase: 'collect', trigger,
    candidates: candidates.map(c => ({ kind: c.kind, cwd: c.cwd, sourcePath: c.sourcePath, deduped: !!processed[c.contentHash] })),
    overflow,
    dedupSkipped,
  });
  if (!fresh.length) {
    summary.note = candidates.length ? 'all-deduped（候选内容均无变化，本轮零 LLM 开销）' : 'no-candidates';
    finishRun(hubDataDir, runId, summary, processed);
    return summary;
  }

  const hasLlm = config.provider === 'deepseek-api' ? !!hubCfg.deepseekApiKey : true;
  const allEntries = [];
  if (!hasLlm) {
    // 显式降级：没配 LLM 就只采集不蒸馏，候选已在 changelog 里，不会丢。
    summary.note = 'no-llm: 未配置 DeepSeek API Key（或改用订阅 CLI 通道），本次只采集未蒸馏';
    logger.warn?.(`[dream] ${summary.note}`);
  } else {
    for (const candidate of fresh) {
      try {
        const raw = await llmCall({
          provider: config.provider,
          model: config.model,
          deepseekApiKey: hubCfg.deepseekApiKey,
          system: buildDistillSystem(workspaceRoot),
          user: buildDistillUser(candidate, workspaceRoot),
        });
        const { entries, parseError } = parseDistillOutput(raw);
        if (parseError) {
          appendChangelog(hubDataDir, { runId, phase: 'error', candidate: candidate.sourcePath, error: `parse: ${parseError}` });
          continue;
        }
        // 蒸馏成功（含 entries=[] 的「没有可沉淀」）才标记指纹；失败的下轮重试。
        processed[candidate.contentHash] = { runId, at: new Date().toISOString() };
        const valid = validateEntries(entries);
        for (const e of valid) e._candidate = candidate.sourcePath;
        allEntries.push(...valid);
        appendChangelog(hubDataDir, { runId, phase: 'distill', candidate: candidate.sourcePath, entries: valid });
      } catch (error) {
        appendChangelog(hubDataDir, { runId, phase: 'error', candidate: candidate.sourcePath, error: String(error && error.message || error) });
        logger.warn?.(`[dream] 蒸馏失败（${candidate.sourcePath}）：${error && error.message}`);
      }
    }
  }

  summary.entries = allEntries.length;
  const applyResult = applyEntries(allEntries, {
    hubDataDir, homeDir, workspaceRoot, runId,
    autoApply: config.autoApply && hasLlm,
    logger,
  });
  summary.applied = applyResult.applied.length;
  summary.staged = applyResult.staged.length;
  summary.skipped = applyResult.skipped.length;
  if (!summary.note) summary.note = summary.applied ? 'ok' : (summary.staged ? 'staged-only' : 'nothing-durable');
  finishRun(hubDataDir, runId, summary, processed);
  return summary;
}

function readPrevState(hubDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(hubDataDir, 'consolidation', 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function finishRun(hubDataDir, runId, summary, processed) {
  const dir = path.join(hubDataDir, 'consolidation');
  fs.mkdirSync(dir, { recursive: true });
  summary.finishedAt = new Date().toISOString();
  // processed 规模设上限：只留最近 500 个指纹，防止 state.json 常年膨胀。
  const entries = Object.entries(processed || {}).slice(-500);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    lastRunId: runId,
    lastRunAt: summary.finishedAt,
    summary,
    processed: Object.fromEntries(entries),
  }, null, 2), 'utf8');
  appendChangelog(hubDataDir, { runId, phase: 'done', summary: { ...summary, finishedAt: undefined } });
}

// ---------------------------------------------------------------------------
// 定时调度：每天到点跑一次；Hub 错过点（没开机）则在启动后补跑。

function startDreamScheduler(opts) {
  const { logger = console, intervalMs = 15 * 60 * 1000 } = opts;
  let running = false;
  let timer = null;

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(opts.hubDataDir, 'consolidation', 'state.json'), 'utf8'));
    } catch { return {}; }
  };

  const isDue = () => {
    const hubCfg = opts.getHubConfig();
    const config = normalizeConsolidationConfig(hubCfg.consolidation);
    if (!config.enabled) return false;
    const [hh, mm] = config.schedule.split(':').map(Number);
    const nowD = new Date();
    const dueToday = new Date(nowD); dueToday.setHours(hh, mm, 0, 0);
    if (nowD < dueToday) return false;
    const lastRunAt = Date.parse(readState().lastRunAt || 0) || 0;
    return lastRunAt < dueToday.getTime();
  };

  const tick = async () => {
    if (running || !isDue()) return;
    running = true;
    try {
      const summary = await runConsolidation({ ...opts, trigger: 'scheduled' });
      logger.log?.(`[dream] 例行沉淀完成：候选 ${summary.candidates}，落盘 ${summary.applied || 0}，staging ${summary.staged || 0}（${summary.note}）`);
    } catch (error) {
      logger.warn?.(`[dream] 例行沉淀失败：${error && error.message}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(tick, 30 * 1000).unref?.(); // 启动 30s 后检查一次（补跑昨夜错过的）
  return {
    stop: () => timer && clearInterval(timer),
    runNow: () => runConsolidation({ ...opts, trigger: 'manual' }),
  };
}

module.exports = {
  DEFAULT_CONSOLIDATION_CONFIG,
  DREAM_BEGIN,
  DREAM_END,
  normalizeConsolidationConfig,
  redactSecrets,
  seedCopyStatus,
  buildDistillSystem,
  collectCandidates,
  callLlm,
  parseDistillOutput,
  validateEntries,
  mergeManagedSection,
  resolveTargetFiles,
  runConsolidation,
  startDreamScheduler,
};
