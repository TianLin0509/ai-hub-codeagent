'use strict';
// Prompt 检视：还原「这个 cwd 下起一个会话时，CLI 会往 API 请求里注入什么」。
//
// 为什么是"还原"而不是"抓包"：抓真实请求体需要把 CLI 的 API 流量转发到本地代理
// （ANTHROPIC_BASE_URL / model_providers.base_url），那是在生产链路上动刀，风险独立。
// 而用户真正要判断的是「CLAUDE.md / memory 有没有正常注入」——这部分完全由本地文件
// 决定，可以确定性还原。两个 CLI 的发现算法已用抓包逐条实测确认（2026-07-28）：
//
//   Claude Code 2.1.220
//     - 只读 CLAUDE.md / CLAUDE.local.md，**从不自动读 AGENTS.md**
//     - 从 cwd 一路向上找到盘符根，**不受 git 边界限制**
//     - cwd 会被 canonicalize（junction 解析成真实路径）→ 记忆桶跟着真实路径走
//     - AGENTS.md 只能靠 CLAUDE.md 里的 `@AGENTS.md` import 进来，且 import 只支持相对路径
//   Codex CLI 0.144.0
//     - 只读 AGENTS.md，从 project root 向下收集到 cwd，**不越过 project root**
//     - project root = 向上找到第一个含 `project_root_markers` 标记的祖先（默认 [".git"]）
//     - cwd **不做** junction 解析
//   Kimi Code CLI（2026-07-29 探针实测：4 组路径起真实会话，再从 wire.jsonl 的
//   systemPrompt 里逐条核对 `<!-- From: ... -->` 注入来源）
//     - 只读 AGENTS.md，规则与 Codex 相同：最近 .git 根向下收集到 cwd，不越过该根
//       （嵌套 git 仓库会挡住外层：repo 套 repo 时外层根那份读不到）
//     - **没有 .git 时退化为只读 cwd 自己那一份**，父目录 AGENTS.md 一份都不读
//     - 全局记忆 = ~/.kimi-code/AGENTS.md，永远注入
//     - 无 Claude 式 memory 桶（官方 slash-commands 全文核实：没有 /memory），
//       记忆检查与桶名塌缩检查对 kimi 无意义，buildHealth 已按 kind 跳过
//
// 记忆桶 = ~/.claude/projects/<slug(realpath(cwd))>/memory，slug 规则见 projectSlug()。

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_GLOBAL_REL = ['.claude', 'CLAUDE.md'];
const CODEX_GLOBAL_REL = ['.codex', 'AGENTS.md'];
const KIMI_GLOBAL_REL = ['.kimi-code', 'AGENTS.md'];
// 中文/全角字符会被 slug 规则压成短横，长度相同的中文目录名会塌缩到同一个桶。
const SLUG_COLLAPSE = /[^A-Za-z0-9]/g;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// Claude Code 的桶名算法：真实路径 → 非字母数字全部换成短横。
function projectSlug(p) {
  return path.resolve(String(p || '')).replace(SLUG_COLLAPSE, '-');
}

// junction / symlink 解析。路径不存在时退回原值（不抛）。
function realPath(p) {
  try {
    return fs.realpathSync.native(String(p || ''));
  } catch {
    return String(p || '');
  }
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function readText(file, maxBytes = 262144) {
  try {
    const buf = fs.readFileSync(file);
    return buf.slice(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

// cwd → 盘符根的所有祖先，从外到内（Claude 的注入顺序就是这个方向）。
function ancestorsOutsideIn(dir) {
  const out = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return out.reverse();
}

// `@path.md` 展开。2026-07-29 用本地捕获代理抓真实请求体实测（见文件头「实测口径」）：
// 相对路径与绝对路径**都会展开**，且 Claude 按解析后路径去重——已经在链里的文件
// 再被 @import 引一次不会产生第二份正文，那行 @ 只作为字面文本留在 prompt 里。
//
// 历史勘误：本函数原先写 `effective: !isAbsolute && size >= 0`（"绝对路径不展开"），
// 并据此在体检里报 bad。抓包证明是错的——探针里 `@C:/…/abs-target.md` 的正文
// 标记 MK_ABS_EXPAND_0003 确实出现在请求体中。误报已修。
function expandImports(text, baseDir) {
  const imports = [];
  if (!text) return imports;
  const re = /^@([^\s]+)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1];
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('/') || spec.startsWith('\\');
    const resolved = isAbsolute ? spec : path.resolve(baseDir, spec);
    const size = statSize(resolved);
    imports.push({
      spec,
      resolved,
      absolute: isAbsolute,
      exists: size >= 0,
      bytes: size < 0 ? 0 : size,
      // 目标存在即会被展开，与相对/绝对无关。是否真的产生新正文另看去重（见 buildAssembly）。
      effective: size >= 0,
    });
  }
  return imports;
}

// ---------- Claude 侧 ----------
function discoverClaudeChain(cwd) {
  const real = realPath(cwd);
  const entries = [];
  const seen = new Set();

  const pushFile = (file, source) => {
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    const bytes = statSize(file);
    if (bytes < 0) return;
    seen.add(key);
    const text = readText(file);
    entries.push({
      path: file,
      source,
      bytes,
      imports: expandImports(text, path.dirname(file)),
    });
  };

  pushFile(path.join(homeDir(), ...CLAUDE_GLOBAL_REL), 'user-global');
  for (const dir of ancestorsOutsideIn(real)) {
    pushFile(path.join(dir, 'CLAUDE.md'), 'project');
    pushFile(path.join(dir, 'CLAUDE.local.md'), 'local');
  }
  return { realCwd: real, junctionResolved: path.resolve(real).toLowerCase() !== path.resolve(cwd).toLowerCase(), entries };
}

// Claude 的项目规则只写在 CLAUDE.md / CLAUDE.local.md 里时，Codex / Kimi 从不读取。
// 不能只看「同目录有没有 AGENTS.md」：空壳、旧版或内容不同的 AGENTS.md 都会制造假 OK；
// 也不能只看 provider project root 到 cwd 的区间——无 marker 时两家明确只读 cwd，且 Hub
// seed + .vibe-root 会把等价规则搬到另一层。真正要核对的是两条**实际注入链的正文**：
// Claude 项目链上的每份规则，是否已完整出现在 provider 实际读取的某份 AGENTS.md 中。
function findUnmirroredClaudeRules(claudeEntries, providerEntries) {
  // “是否送达”只看最终注入结果；同一规则若已在 provider 全局文件中，也不该再报缺失。
  const providerRuleEntries = providerEntries || [];
  const providerPaths = new Set(providerRuleEntries.map(e => pathKey(e.path)));
  const providerBodies = providerRuleEntries
    .map(e => ruleBody(e.path))
    .filter(Boolean);

  const out = [];
  for (const entry of (claudeEntries || [])) {
    if (entry.source === 'user-global') continue;
    const body = ruleBody(entry.path);
    if (!body) continue;

    // seed 头会由 ruleBody 剥掉；AGENTS.md 可以在相同规则后追加 provider 专属说明，
    // 所以「正文完整包含」也算送达，不要求两个文件必须字节级完全相等。
    if (providerBodies.some(agentBody => ruleBlockIncluded(agentBody, body))) continue;

    // CLAUDE.md 只做一件事：@ 引入 provider 已经实际读取的 AGENTS.md。此时没有遗漏。
    const textWithoutComments = (readText(entry.path) || '').replace(/<!--[\s\S]*?-->/g, '');
    const nonImportText = textWithoutComments.replace(/^@([^\s]+)\s*$/gm, '').trim();
    const effectiveImports = (entry.imports || []).filter(im => im.effective);
    if (!nonImportText && effectiveImports.length > 0
      && effectiveImports.every(im => providerPaths.has(pathKey(im.resolved)))) continue;

    out.push({ path: entry.path, bytes: entry.bytes, source: entry.source });
  }
  return out;
}

function ruleBlockIncluded(container, block) {
  if (container === block) return true;
  return (`\n${container}\n`).includes(`\n${block}\n`);
}

// AGENTS.md 存在但同目录既没有 CLAUDE.md、也没有任何 CLAUDE.md 用 @ 引它 → Claude 读不到。
// 正文比对用：剥掉 HTML 注释块（seed 副本的自动生成头、"与 CLAUDE.md 保持一致"的说明），
// 统一换行和行尾空白后再比较。不能删除所有空白：Markdown 的缩进、代码块和单词边界
// 都可能有语义，`ab c` 与 `a bc` 也绝不能被误判成同一份规则。
function ruleBody(file) {
  const text = readText(file);
  if (text === null) return null;
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

// 同目录 CLAUDE.md 与 AGENTS.md 正文逐字相同 = 刻意的双写镜像（一份给 Claude、一份给
// Codex/Kimi），Claude 读 CLAUDE.md 就已经拿到全部规则，什么都没漏。
//
// 2026-07-29 三方审查：原实现只比路径不比内容，把 C:\Workspace 这种镜像报成「AGENTS.md 读不到」，
// 且建议加 `@AGENTS.md`——照做会真的展开出第二份完全相同的正文（约 1.4KB/次会话），
// 而 :306 的 redundant 检查抓不到它（那里只查 CLAUDE.md 链）。等于一边教人制造重复、
// 一边看不见自己造的重复。现在镜像不再算 orphan。
function findOrphanAgentsMd(cwd, chain) {
  const real = realPath(cwd);
  const imported = new Set();
  for (const e of chain) {
    for (const im of e.imports) {
      if (im.effective) imported.add(im.resolved.toLowerCase());
    }
  }
  // 链上每一份 CLAUDE.md 的正文指纹。镜像关系不一定在同目录——工作区根写一份
  // CLAUDE.md，Hub 再把等价的 AGENTS.md seed 到子目录，此时子目录那份的规则同样
  // 早已由上级 CLAUDE.md 送达，报 orphan 依旧是误报。
  const chainBodies = new Set();
  for (const e of chain) {
    const b = ruleBody(e.path);
    if (b) chainBodies.add(b);
  }

  const orphans = [];
  for (const dir of ancestorsOutsideIn(real)) {
    const agents = path.join(dir, 'AGENTS.md');
    if (statSize(agents) < 0) continue;
    if (imported.has(agents.toLowerCase())) continue;
    const body = ruleBody(agents);
    if (body && chainBodies.has(body)) continue;   // 镜像，规则已由链上某份 CLAUDE.md 送达
    orphans.push({ path: agents, bytes: statSize(agents) });
  }
  return orphans;
}

// ---------- Codex 侧 ----------
function readCodexRootMarkers() {
  const cfg = readText(path.join(homeDir(), '.codex', 'config.toml'), 65536) || '';
  // TOML allows the key bare or quoted; a rewrite of config.toml on 2026-09-25 switched it to
  // "project_root_markers", and a bare-only match silently fell back to [".git"].
  const m = cfg.match(/^\s*(?:project_root_markers|"project_root_markers"|'project_root_markers')\s*=\s*\[([^\]]*)\]/m);
  if (!m) return { markers: ['.git'], configured: false };
  const markers = m[1].split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return { markers: markers.length ? markers : ['.git'], configured: true };
}

function discoverCodexChain(cwd) {
  const { markers, configured } = readCodexRootMarkers();
  // Codex 不解析 junction —— 故意用字面 cwd
  const literal = path.resolve(cwd);
  let projectRoot = null;
  let cur = literal;
  for (;;) {
    if (markers.some(mk => statSize(path.join(cur, mk)) >= 0 || fs.existsSync(path.join(cur, mk)))) {
      projectRoot = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }

  const entries = [];
  const globalAgents = path.join(homeDir(), ...CODEX_GLOBAL_REL);
  if (statSize(globalAgents) >= 0) {
    entries.push({ path: globalAgents, source: 'user-global', bytes: statSize(globalAgents) });
  }
  // 找不到 marker 时 Codex 只看 cwd 自己
  const dirs = projectRoot
    ? ancestorsOutsideIn(literal).filter(d => d === projectRoot || d.startsWith(projectRoot + path.sep))
    : [literal];
  for (const dir of dirs) {
    const f = path.join(dir, 'AGENTS.md');
    const b = statSize(f);
    if (b >= 0) entries.push({ path: f, source: 'project', bytes: b });
  }
  return { literalCwd: literal, projectRoot, markers, markersConfigured: configured, entries };
}

// ---------- Kimi 侧 ----------
// 2026-07-29 探针实测（见文件头）：规则与 Codex 相同，但 markers 固定 ['.git']
// （kimi 没有 project_root_markers 配置），全局文件是 ~/.kimi-code/AGENTS.md。
function discoverKimiChain(cwd) {
  const literal = path.resolve(cwd);
  let projectRoot = null;
  let cur = literal;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      projectRoot = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }

  const entries = [];
  const globalAgents = path.join(homeDir(), ...KIMI_GLOBAL_REL);
  if (statSize(globalAgents) >= 0) {
    entries.push({ path: globalAgents, source: 'user-global', bytes: statSize(globalAgents) });
  }
  // 找不到 .git 时 Kimi 只看 cwd 自己（探针实测：父目录一份都不读）
  const dirs = projectRoot
    ? ancestorsOutsideIn(literal).filter(d => d === projectRoot || d.startsWith(projectRoot + path.sep))
    : [literal];
  for (const dir of dirs) {
    const f = path.join(dir, 'AGENTS.md');
    const b = statSize(f);
    if (b >= 0) entries.push({ path: f, source: 'project', bytes: b });
  }
  return { literalCwd: literal, projectRoot, markers: ['.git'], markersConfigured: false, entries };
}

// ---------- 记忆 ----------
function inspectMemory(cwd, configDirName = '.claude') {
  const real = realPath(cwd);
  const slug = projectSlug(real);
  const bucket = path.join(homeDir(), configDirName, 'projects', slug);
  const memDir = path.join(bucket, 'memory');
  // DeepSeek 的 transcript/settings 虽在 .claude-deepseek 隔离，但 Hub 设计明确让两家
  // memory 都共享主 Claude 规范库；不能拿 .claude-deepseek 的 home 桶当 canonical。
  const canonical = path.join(homeDir(), '.claude', 'projects', projectSlug(homeDir()), 'memory');

  const out = {
    slug,
    bucket,
    memoryDir: memDir,
    canonicalDir: canonical,
    state: 'NOBUCKET',
    isLink: false,
    linkTarget: null,
    files: 0,
    indexBytes: 0,
    indexPath: path.join(memDir, 'MEMORY.md'),
    sharesCanonical: false,
  };

  let st = null;
  try { st = fs.lstatSync(memDir); } catch { return out; }
  out.isLink = st.isSymbolicLink();
  if (out.isLink) {
    try { out.linkTarget = fs.readlinkSync(memDir); } catch { out.linkTarget = null; }
  }
  let names = [];
  try { names = fs.readdirSync(memDir).filter(n => n.toLowerCase().endsWith('.md')); } catch { names = []; }
  out.files = names.length;
  out.indexBytes = Math.max(0, statSize(out.indexPath));
  out.sharesCanonical = realPath(memDir).toLowerCase() === realPath(canonical).toLowerCase();

  if (out.isLink) out.state = out.sharesCanonical ? 'LINKED' : 'WRONG_LINK';
  else if (out.files === 0) out.state = 'EMPTY_REAL';
  else out.state = 'PRIVATE_REAL';
  return out;
}

// ---------- 体检 ----------
function usesClaudeMemory(kind) {
  return kind === 'claude';
}

function usesCodexRules(kind) {
  return kind === 'codex' || kind === 'deepseek';
}

function buildHealth(insp) {
  const checks = [];
  const push = (level, title, detail) => checks.push({ level, title, detail });

  const chain = insp.claude ? insp.claude.entries : [];
  if (usesClaudeMemory(insp.kind)) {
    if (chain.length === 0) {
      push('bad', 'CLAUDE.md 一份都没读到', '这个 cwd 向上到盘符根都没有 CLAUDE.md，模型只有内置系统提示词。');
    } else {
      const total = chain.reduce((s, e) => s + e.bytes, 0);
      push('ok', `CLAUDE.md 链 ${chain.length} 份`, `共 ${total} 字节，从外到内注入。`);
    }
    // 真正的问题是「引了但目标不存在」——那行 @ 会当字面文本留在 prompt 里，规则并没进去。
    const deadImports = chain.flatMap(e => e.imports).filter(im => !im.exists);
    if (deadImports.length) {
      push('bad', `${deadImports.length} 处 @import 目标不存在`,
        `这行 @ 会原样留在 prompt 里当普通文本，被引的规则根本没进去：${deadImports[0].spec}`);
    }
    // 引了一份已经在链上的文件 = 死配置。Claude 按解析后路径去重，不会重复注入，
    // 但这行 @ 本身仍占几十字节，且容易让人误以为"多注入了一份"。
    const chainKeys = new Set(chain.map(e => pathKey(e.path)));
    const redundant = chain.flatMap(e => e.imports)
      .filter(im => im.exists && chainKeys.has(pathKey(im.resolved)));
    if (redundant.length) {
      push('warn', `${redundant.length} 处 @import 是多余的`,
        `目标已经在 CLAUDE.md 链上、会被自动注入，Claude 按路径去重不会注入第二遍。删掉这行更干净：${redundant[0].spec}`);
    }
    if (insp.orphanAgents && insp.orphanAgents.length) {
      push('warn', `${insp.orphanAgents.length} 份 AGENTS.md 读不到`,
        `Claude 从不自动读 AGENTS.md。在同目录加一个 CLAUDE.md 写 @AGENTS.md 才会生效：${insp.orphanAgents[0].path}`);
    }
  }

  if (usesCodexRules(insp.kind)) {
    const cx = insp.codex || { entries: [] };
    if (!cx.projectRoot) {
      push('warn', '没找到 project root 标记',
        `markers=[${cx.markers.join(', ')}]，向上都没命中 → Codex 只读 cwd 自己的 AGENTS.md。`);
    } else {
      push('ok', `project root = ${cx.projectRoot}`, `markers=[${cx.markers.join(', ')}]，从这一层向下收集。`);
    }
    push(cx.entries.length ? 'ok' : 'bad', `AGENTS.md ${cx.entries.length} 份`,
      cx.entries.length ? `共 ${cx.entries.reduce((s, e) => s + e.bytes, 0)} 字节。` : '一份都没读到。');
    const codexBlind = findUnmirroredClaudeRules(insp.claude && insp.claude.entries, cx.entries);
    if (codexBlind.length) {
      push('bad', `${codexBlind.length} 份 Claude 规则未完整送到 Codex`,
        `${codexBlind[0].path} 有 ${codexBlind[0].bytes} 字节，但 Codex 实际读取的 AGENTS.md 链里没有找到完整正文。`
        + '请把需要共享的规则同步到 Codex project root 至 cwd 之间的一份 AGENTS.md。');
    }
    if (insp.claude && insp.claude.junctionResolved) {
      push('warn', 'cwd 走的是 junction',
        `Codex 不解析 junction，记忆与会话会按字面路径 ${cx.literalCwd} 记账，而不是真实路径 ${insp.claude.realCwd}。`);
    }
  }

  if (insp.kind === 'kimi') {
    const km = insp.kimi || { entries: [] };
    if (!km.projectRoot) {
      push('warn', '没找到 .git，Kimi 只读 cwd 自己的 AGENTS.md',
        '2026-07-29 探针实测：无 git 时父目录的 AGENTS.md 一份都不读。经 Hub 启动会在确实无 git 且无自有 AGENTS.md 的 cwd 托管一份哈希可刷新副本；不要为此在 C:\\Workspace 聚合根 git init。');
    } else {
      push('ok', `project root = ${km.projectRoot}`, 'markers=[.git]，从这一层向下收集到 cwd（嵌套 git 仓库会挡住外层）。');
    }
    push(km.entries.length ? 'ok' : 'bad', `AGENTS.md ${km.entries.length} 份`,
      km.entries.length ? `共 ${km.entries.reduce((s, e) => s + e.bytes, 0)} 字节（含全局 ~/.kimi-code/AGENTS.md）。` : '一份都没读到（连全局 ~/.kimi-code/AGENTS.md 都没有）。');
    const kimiBlind = findUnmirroredClaudeRules(insp.claude && insp.claude.entries, km.entries);
    if (kimiBlind.length) {
      push('bad', `${kimiBlind.length} 份 Claude 规则未完整送到 Kimi`,
        `${kimiBlind[0].path} 有 ${kimiBlind[0].bytes} 字节，但 Kimi 实际读取的 AGENTS.md 链里没有找到完整正文。`
        + '请把需要共享的规则同步到最近 .git 根至 cwd 之间的一份 AGENTS.md；无 .git 时要放在 cwd。');
    }
    // Kimi 没有 Claude 式 memory 桶（官方文档无 /memory），下面的记忆桶检查
    // 与桶名塌缩检查对 kimi 都是假警告，按 kind 跳过。
  }

  // 记忆桶是 Claude Code 独有机制；DeepSeek 已迁移到 Codex runtime。
  // 2026-07-29 三方审查：原守卫写的是 `kind !== 'kimi'`，只挡住了 kimi，**codex 照跑**——
  // 而 buildInspection 给 codex 传的 configDirName 是 '.claude'，于是 Codex 会话的面板上
  // 显示的是 Claude 的记忆库（实测报「记忆已接入规范库 156 条」，Codex 一条都读不到）。
  // 假 OK 比没有检查更坏，改成与上面 :290 那行同一套 kind 判据。
  if (usesClaudeMemory(insp.kind)) {
  const mem = insp.memory;
  if (mem.state === 'LINKED' || mem.sharesCanonical) {
    push('ok', '记忆已接入规范库', `${mem.files} 条 · 索引 ${mem.indexBytes} 字节`);
  } else if (mem.state === 'WRONG_LINK') {
    push('bad', '记忆链接指向了别处', `当前链接：${mem.linkTarget || mem.memoryDir}；规范库：${mem.canonicalDir}。Hub 不会擅自覆盖这条链接。`);
  } else if (mem.state === 'PRIVATE_REAL') {
    push('warn', `记忆是独立的 ${mem.files} 条`, `这个桶尚未链到规范库；下次 Claude/DeepSeek spawn 会先备份并合并，再换 junction。桶：${mem.slug}`);
  } else if (mem.state === 'EMPTY_REAL') {
    push('bad', '记忆目录是空的真实目录',
      '正常 spawn 会自动把它改名留底并换成 junction；若重开会话后仍存在，请查看 memory link 错误日志。');
  } else {
    push('warn', '还没有记忆桶', '首次会话会新建一个空目录；若不经 Hub 启动就会变成上面那种「永久不共享」状态。');
  }

  if (insp.slugCollapsed) {
    push('warn', '目录名含非 ASCII，桶名已塌缩',
      `${mem.slug} —— 同一父目录下字数相同的中文名会撞进同一个桶，会话与记忆会混。`);
  }
  }
  return checks;
}

function buildInspection(opts = {}) {
  const cwd = opts.cwd || homeDir();
  const kind = (opts.kind || 'claude').toLowerCase();
  const configDirName = '.claude';

  const claude = discoverClaudeChain(cwd);
  const orphanAgents = findOrphanAgentsMd(cwd, claude.entries);
  const codex = discoverCodexChain(cwd);
  const kimi = discoverKimiChain(cwd);
  const memory = inspectMemory(cwd, configDirName);
  const slugCollapsed = /--{2,}|-{3,}/.test(memory.slug);

  const insp = { cwd, kind, claude, codex, kimi, orphanAgents, memory, slugCollapsed };
  insp.health = buildHealth(insp);

  const ruleBytes = usesCodexRules(kind)
    ? codex.entries.reduce((s, e) => s + e.bytes, 0)
    : kind === 'kimi'
      ? kimi.entries.reduce((s, e) => s + e.bytes, 0)
      : claude.entries.reduce((s, e) => s + e.bytes, 0);
  insp.totals = {
    ruleBytes,
    memoryIndexBytes: usesClaudeMemory(kind) ? memory.indexBytes : 0,
    memoryFiles: usesClaudeMemory(kind) ? memory.files : 0,
    // 粗估：混合中英按 3.2 字节/token，仅用于量级参考
    approxRuleTokens: Math.round(ruleBytes / 3.2),
  };
  return insp;
}

// ============================================================================
// raw 原文层：把「面板里列出来的每个文件」变成可点开、可校验的磁盘实读原文。
//
// 三条诚实红线（不许越）：
//   1. 只读磁盘，不编造。拿不到的东西（CLI 内置系统提示词、工具定义、请求瞬间
//      现算的环境块）一律进 UNAVAILABLE_PARTS 如实标注，绝不合成一段假文本冒充。
//   2. 内容是「磁盘实读原文」（contentTruth = 'disk-verbatim'），顺序是「按实测
//      规则还原」——CLAUDE.md 链的外→内顺序是抓包实测确认的（orderTruth =
//      'measured'），@import 展开位置和记忆索引插入位置只是近似（'approx'）。
//   3. 每份原文都带 sha256 + 字节数 + mtime，用户可以自己 Get-FileHash 对一遍。
// ============================================================================

// 单次返回的正文上限。超过就分段，由调用方带 offset 续读——绝不静默截断。
const RAW_MAX_SLICE = 262144;          // 单文件单次 256KB
const ASM_MAX_SEGMENT_BYTES = 200000;  // 拼装预览里单段最多带回 200KB 正文
const ASM_MAX_TOTAL_BYTES = 600000;    // 拼装预览正文总量上限，超出的段只给元信息
const ASSEMBLY_JOIN = '\n\n';          // 段与段之间的分隔（计入总偏移，不属于任何段）

// 拿不到的部分。写死在这里，UI 直接展示——宁可说「拿不到」也不编。
const UNAVAILABLE_PARTS = [
  { label: 'CLI 内置系统提示词', why: '由 CLI 二进制内部拼装后直接发往 API，不落磁盘，本机读不到。' },
  { label: '工具定义（Read / Edit / Bash …）', why: '同样由 CLI 内部生成，随版本变化，Hub 无从获取。' },
  { label: '环境信息块（工作目录、git 状态、当前日期）', why: 'CLI 在发请求那一刻现算，事后无法复现当时的值。' },
  { label: '对话历史与运行期 system-reminder', why: '取决于会话进行到哪一步，不属于「这个 cwd 会注入什么」的范畴。' },
];

// Windows 路径比较必须 resolve + 大小写不敏感，否则 c:\x 与 C:\X 会被判成两条路径。
function pathKey(p) {
  const abs = path.resolve(String(p || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// 按字节切片会把 UTF-8 多字节字符劈两半（分页边界出现乱码）。
// 这里把切点回退到最近的字符起始字节：续字节的高两位固定是 10。
function alignUtf8Boundary(buf, at) {
  if (at <= 0) return 0;
  if (at >= buf.length) return buf.length;
  let i = at;
  let back = 0;
  while (i > 0 && back < 4 && (buf[i] & 0xC0) === 0x80) { i--; back++; }
  return i;
}

// UTF-8 首字节 → 这个字符占几字节（用于 limit 比一个字符还短时的兜底）
function utf8CharLen(b) {
  if (b >= 0xF0) return 4;
  if (b >= 0xE0) return 3;
  if (b >= 0xC0) return 2;
  return 1;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 把一次 inspection 里出现过的所有磁盘路径摊平成可点击条目。
// 顺序 = 面板展示顺序，也是白名单的唯一来源。
function collectRawSources(insp) {
  const out = [];
  const inspectionKind = (insp && insp.kind) || 'claude';
  const claudeMemoryApplies = usesClaudeMemory(inspectionKind);
  const claude = (insp && insp.claude) || {};
  (claude.entries || []).forEach((e, i) => {
    out.push({
      id: `claude:${i}`, group: 'claude', kind: 'claude-md',
      path: e.path, label: path.basename(e.path), source: e.source,
      bytes: e.bytes, exists: true, injected: claudeMemoryApplies,
    });
    (e.imports || []).forEach((im, j) => {
      out.push({
        id: `import:${i}:${j}`, group: 'claude', kind: 'import',
        path: im.resolved, label: `@${im.spec}`, source: 'import', parent: e.path,
        bytes: im.bytes, exists: !!im.exists, injected: claudeMemoryApplies && !!im.effective,
      });
    });
  });
  ((insp && insp.orphanAgents) || []).forEach((o, i) => {
    out.push({
      id: `orphan:${i}`, group: 'orphan', kind: 'agents-md',
      path: o.path, label: path.basename(o.path), source: 'orphan',
      bytes: o.bytes, exists: true, injected: false,
    });
  });
  (((insp && insp.codex) || {}).entries || []).forEach((e, i) => {
    out.push({
      id: `codex:${i}`, group: 'codex', kind: 'agents-md',
      path: e.path, label: path.basename(e.path), source: e.source,
      bytes: e.bytes, exists: true, injected: (insp && insp.kind) === 'codex',
    });
  });
  (((insp && insp.kimi) || {}).entries || []).forEach((e, i) => {
    out.push({
      id: `kimi:${i}`, group: 'kimi', kind: 'agents-md',
      path: e.path, label: path.basename(e.path), source: e.source,
      bytes: e.bytes, exists: true, injected: (insp && insp.kind) === 'kimi',
    });
  });
  const mem = (insp && insp.memory) || {};
  if (claudeMemoryApplies && mem.indexPath) {
    const size = statSize(mem.indexPath);
    out.push({
      id: 'memory:index', group: 'memory', kind: 'memory-index',
      path: mem.indexPath, label: 'MEMORY.md', source: 'memory',
      bytes: size < 0 ? 0 : size, exists: size >= 0, injected: size > 0,
    });
  }
  return out;
}

// 白名单 = 这次 inspection 真实产出的那批路径。renderer 传任何别的路径都拒。
function buildRawAllowlist(insp) {
  const seen = new Set();
  const list = [];
  for (const s of collectRawSources(insp)) {
    const key = pathKey(s.path);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(path.resolve(s.path));
  }
  return list;
}

// 越权判定。返回命中的 source（含 label），没命中返回 null——调用方据此拒绝。
function resolveAllowedSource(insp, requested) {
  const raw = String(requested == null ? '' : requested);
  if (!raw.trim()) return null;
  const key = pathKey(raw);
  for (const s of collectRawSources(insp)) {
    if (pathKey(s.path) === key) return s;
  }
  return null;
}

// 单个文件的原文读取。offset/limit 支持分页；sha256 永远算的是**整份文件**，
// 这样用户 Get-FileHash 出来的值能直接对上，不受分页影响。
function readRawFile(file, opts = {}) {
  const abs = path.resolve(String(file || ''));
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (error) {
    return { ok: false, code: 'NOT_FOUND', path: abs, error: `读不到这个文件（可能刚被删除或没有权限）：${abs}` };
  }
  if (!st.isFile()) {
    return { ok: false, code: 'NOT_FILE', path: abs, error: `不是普通文件，拒绝读取：${abs}` };
  }
  let buf = null;
  try {
    buf = fs.readFileSync(abs);
  } catch (error) {
    return { ok: false, code: 'READ_ERROR', path: abs, error: (error && error.message) || String(error) };
  }

  const total = buf.length;
  const wantOffset = Number.isFinite(Number(opts.offset)) ? Math.trunc(Number(opts.offset)) : 0;
  const wantLimit = Number.isFinite(Number(opts.limit)) ? Math.trunc(Number(opts.limit)) : RAW_MAX_SLICE;
  const offset = alignUtf8Boundary(buf, Math.max(0, Math.min(total, wantOffset)));
  // limit 非法（<=0 / NaN）一律退回上限，别把它当成「只读 1 字节」
  const limit = wantLimit > 0 ? Math.min(RAW_MAX_SLICE, wantLimit) : RAW_MAX_SLICE;
  let end = alignUtf8Boundary(buf, Math.min(total, offset + limit));
  // limit 比一个字符还短时 align 会把 end 拉回 offset —— 那样调用方永远推不动分页，
  // 这里至少吐一个完整字符。
  if (end <= offset && offset < total) end = Math.min(total, offset + utf8CharLen(buf[offset]));
  const slice = buf.slice(offset, end);
  const hex = sha256Hex(buf);

  return {
    ok: true,
    path: abs,
    totalBytes: total,
    sha256: hex,
    sha256_12: hex.slice(0, 12),
    mtimeMs: st.mtimeMs,
    mtime: new Date(st.mtimeMs).toISOString(),
    offset,
    end,
    sliceBytes: slice.length,
    eof: end >= total,
    text: slice.toString('utf8'),
    contentTruth: 'disk-verbatim',
  };
}

// 完整拼装预览：把「这个 cwd 下真正会注入的规则块」按实测顺序拼起来，
// 并给出每段在拼装结果里的起止字节偏移，让用户能逐段对号。
//
// 顺序依据（core 头部注释里那批抓包结论）：
//   claude 系 → ~/.claude/CLAUDE.md，然后 cwd 祖先从外到内的 CLAUDE.md / CLAUDE.local.md
//   codex    → project root 向下到 cwd 的 AGENTS.md
//   kimi     → ~/.kimi-code/AGENTS.md，然后最近 .git 根向下到 cwd 的 AGENTS.md（无 memory 索引段）
//   记忆索引 MEMORY.md 确实会进 prompt，但插入位置由 CLI 决定，这里排在最后（近似）
function buildAssembly(insp, opts = {}) {
  const asmKind = ((insp && insp.kind) || 'claude');
  const isCodex = usesCodexRules(asmKind);
  const isKimi = asmKind === 'kimi';
  const claudeMemoryApplies = usesClaudeMemory(asmKind);
  const maxSeg = Math.max(1, Number(opts.maxSegmentBytes) || ASM_MAX_SEGMENT_BYTES);
  const maxTotal = Math.max(1, Number(opts.maxTotalBytes) || ASM_MAX_TOTAL_BYTES);

  const picked = [];
  if (isCodex) {
    (((insp && insp.codex) || {}).entries || []).forEach((e, i) => picked.push({
      id: `codex:${i}`, path: e.path, label: path.basename(e.path), role: e.source, orderTruth: 'measured',
    }));
  } else if (isKimi) {
    (((insp && insp.kimi) || {}).entries || []).forEach((e, i) => picked.push({
      id: `kimi:${i}`, path: e.path, label: path.basename(e.path), role: e.source, orderTruth: 'measured',
    }));
  } else {
    (((insp && insp.claude) || {}).entries || []).forEach((e, i) => {
      picked.push({ id: `claude:${i}`, path: e.path, label: path.basename(e.path), role: e.source, orderTruth: 'measured' });
      (e.imports || []).forEach((im, j) => {
        if (!im.effective) return;
        picked.push({
          id: `import:${i}:${j}`, path: im.resolved, label: `@${im.spec}`,
          role: 'import', parent: e.path, orderTruth: 'approx',
        });
      });
    });
  }
  const mem = (insp && insp.memory) || {};
  if (claudeMemoryApplies && mem.indexPath && statSize(mem.indexPath) > 0) {
    picked.push({ id: 'memory:index', path: mem.indexPath, label: 'MEMORY.md', role: 'memory-index', orderTruth: 'approx' });
  }

  const segments = [];
  let cursor = 0;
  let emitted = 0;   // 已经附带正文的字节数（控总量）
  let appended = 0;  // 已拼进去的段数（决定要不要先补分隔符）
  // 去重（2026-07-29 修）：discoverClaudeChain 内部对链文件去过重，但 @import 解析出来的
  // 路径没跟链文件比过——于是「链里已有 X + 某个 CLAUDE.md 又 @import 了 X」会被拼成两段，
  // 假报"重复注入"。抓包实测 Claude 按解析后路径去重，只注入一次。这里对齐真实行为：
  // 重复的段仍然列出来（用户要能看见这行 @ 是死配置），但标 duplicateOf 且不占偏移、不计字节。
  const seenPaths = new Set();
  for (const p of picked) {
    const key = pathKey(p.path);
    if (seenPaths.has(key)) {
      segments.push({
        ...p, duplicateOf: key, missing: false, bytes: 0,
        start: cursor, end: cursor, text: '', textBytes: 0,
        note: '这份文件前面已经注入过，Claude 按路径去重不会再注入一遍——这行 @import 是死配置。',
      });
      continue;
    }
    let buf = null;
    try { buf = fs.readFileSync(p.path); } catch { buf = null; }
    if (!buf) {
      // 列出来但读不到：如实标 missing，不占偏移
      segments.push({ ...p, missing: true, bytes: 0, start: cursor, end: cursor, text: '', textBytes: 0 });
      continue;
    }
    if (appended > 0) cursor += Buffer.byteLength(ASSEMBLY_JOIN, 'utf8');
    const hex = sha256Hex(buf);
    let mtime = null;
    try { mtime = new Date(fs.statSync(p.path).mtimeMs).toISOString(); } catch { mtime = null; }

    const seg = {
      ...p,
      missing: false,
      bytes: buf.length,
      start: cursor,
      end: cursor + buf.length,
      sha256: hex,
      sha256_12: hex.slice(0, 12),
      mtime,
      contentTruth: 'disk-verbatim',
      text: '',
      textBytes: 0,
      textTruncated: false,
      textOmitted: false,
    };
    if (emitted >= maxTotal) {
      // 总量已经爆了：只给元信息，让用户单点这一条看全文
      seg.textOmitted = true;
    } else {
      const cap = Math.min(maxSeg, maxTotal - emitted);
      const cut = alignUtf8Boundary(buf, Math.min(buf.length, cap));
      seg.text = buf.slice(0, cut).toString('utf8');
      seg.textBytes = cut;
      seg.textTruncated = cut < buf.length;
      emitted += cut;
    }
    segments.push(seg);
    seenPaths.add(key);
    cursor += buf.length;
    appended += 1;
  }

  const complete = segments.every(s => s.missing || (!s.textTruncated && !s.textOmitted));
  return {
    kind: isCodex ? asmKind : isKimi ? 'kimi' : 'claude',
    cwd: (insp && insp.cwd) || null,
    segments,
    segmentCount: segments.filter(s => !s.missing && !s.duplicateOf).length,
    totalBytes: cursor,
    joiner: ASSEMBLY_JOIN,
    complete,          // true = 下面 segments 的 text 拼起来就是完整拼装结果
    unavailable: UNAVAILABLE_PARTS.map(x => ({ ...x })),
    note: '内容为磁盘实读原文；顺序按实测发现规则还原，标 approx 的段落插入位置只是近似。',
  };
}

module.exports = {
  projectSlug,
  realPath,
  ancestorsOutsideIn,
  expandImports,
  discoverClaudeChain,
  discoverCodexChain,
  discoverKimiChain,
  findOrphanAgentsMd,
  findUnmirroredClaudeRules,
  readCodexRootMarkers,
  inspectMemory,
  buildHealth,
  buildInspection,
  // raw 原文层
  RAW_MAX_SLICE,
  UNAVAILABLE_PARTS,
  pathKey,
  alignUtf8Boundary,
  collectRawSources,
  buildRawAllowlist,
  resolveAllowedSource,
  readRawFile,
  buildAssembly,
};
