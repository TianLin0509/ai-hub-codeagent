"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withinProject } = require("./session-search-projects");
const {
  transcriptMdPath,
  formatTime,
  toolSummary,
  quoteHeadings,
} = require("./session-transcript-md");

const COVERAGE =
  "素材来自昨日之我的已保存消息正文，不是无损 wire 归档。原历史解析可能省略工具结果、附件内容或被截断；不以缺失记录证明事情没有发生。";
const CONTEXT_RECORDS = 6;
function candidates(index, request = {}) {
  const excluded = new Set(request.excludeSessionIds || []);
  const count = index.db.prepare("SELECT count(*) AS n FROM docs WHERE session_key=? AND scope<>'title'");
  return index.db
    .prepare(
      `SELECT s.*, sources.signature, sources.stale
    FROM sessions s JOIN sources ON sources.key=s.source_key ORDER BY s.updated_at DESC`,
    )
    .all()
    .filter(
      (s) =>
        (request.roots || [request.cwd]).some((root) =>
          withinProject(s.cwd, root),
        ) &&
        !excluded.has(s.hub_session_id),
    )
    .map(s => ({ ...s, records: count.get(s.key).n }))
    .filter(s => s.records > 0)
    .map((s) => ({
      key: s.key,
      sourceKey: s.source_key,
      title: s.title,
      provider: s.provider,
      kind: s.kind,
      cwd: s.cwd,
      updatedAt: s.updated_at,
      hubSessionId: s.hub_session_id,
      transcriptPath: s.transcript_path,
      records: s.records,
      signature: String(s.signature || ""),
      stale: !!s.stale,
    }));
}
function exportHistory(index, request) {
  if (!path.isAbsolute(request.outputDir || ""))
    throw new Error("素材输出目录无效");
  const keys = [...new Set(request.keys || [])];
  fs.mkdirSync(request.outputDir, { recursive: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    cwd: request.cwd,
    coverage: COVERAGE,
    sessions: [],
    files: [],
  };
  const records = index.db.prepare(
    "SELECT event_id,role,speaker,scope,timestamp,ordinal,text FROM docs WHERE session_key=? AND scope<>'title' ORDER BY ordinal,id",
  );
  index.db.exec("BEGIN");
  try {
    // Metadata/signatures and records come from the same SQLite snapshot.
    const available = new Map(
      candidates(index, request).map((s) => [s.key, s]),
    );
    if (
      !keys.length ||
      keys.some((k) => !available.has(k) || available.get(k).stale)
    )
      throw new Error("素材已变化、没有正文或不属于当前项目，请重新选择");
    for (const [i, key] of keys.entries()) {
      const done = new Set(request.processedIds?.[key] || []);
      const session = {
        ...available.get(key),
        files: [],
        exportedRecords: 0,
        contextRecords: 0,
        eventIds: [],
      };
      const fullLog = transcriptMdPath(request.transcriptDir, session.sourceKey);
      if (fullLog && fs.existsSync(fullLog)) session.transcriptMd = fullLog;
      const digest = crypto.createHash("sha256");
      let chunk = "",
        part = 0;
      const flush = () => {
        if (!chunk) return;
        const name = `session-${i + 1}-${++part}.md`;
        const head = `# ${String(session.title || key).replace(/\s+/g, " ")}（素材 ${i + 1} · 第 ${part} 段）\n\n- sessionKey：${key}\n\n`;
        fs.writeFileSync(path.join(request.outputDir, name), head + chunk, "utf8");
        manifest.files.push(name);
        session.files.push(name);
        chunk = "";
      };
      // Each record keeps its event id in a comment so topics can cite it.
      const write = (record, context) => {
        const marker = `<!-- event:${record.event_id}${context ? " context" : ""} -->\n`;
        const note = context ? "（上文，已整理）" : "";
        const time = formatTime(record.timestamp);
        const line =
          record.scope === "tool"
            ? `${marker}> 工具${note} · ${toolSummary(record.text)}\n\n`
            : `${marker}### ${record.scope === "user" ? "我" : record.speaker || "AI"}${time ? " · " + time : ""}${note}\n\n${quoteHeadings(record.text).trim()}\n\n`;
        if (chunk.length + line.length > 128 * 1024) flush();
        chunk += line;
        digest.update(line);
      };
      // Already processed records are skipped; the few right before the
      // first new record are kept as lead-in context.
      let lead = [];
      for (const record of records.iterate(key)) {
        if (done.has(record.event_id)) {
          if (!session.exportedRecords) {
            lead.push(record);
            if (lead.length > CONTEXT_RECORDS) lead.shift();
          }
          continue;
        }
        for (const old of lead) write(old, true);
        session.contextRecords += lead.length;
        lead = [];
        write(record, false);
        session.eventIds.push(record.event_id);
        session.exportedRecords++;
      }
      flush();
      // A session with no new records still carries its refreshed signature,
      // so publishing marks it as processed.
      session.contentHash = digest.digest("hex");
      manifest.sessions.push(session);
    }
    if (!manifest.sessions.some((s) => s.exportedRecords))
      throw new Error("所选会话没有未整理的新记录");
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
  fs.writeFileSync(
    path.join(request.outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}
module.exports = { candidates, exportHistory, COVERAGE };
