"""AI Hub PPT adapter. Only queries the existing Doctor index; no organizer imports."""
import json
import sys
from pptutor_core.library import Library, PptutorError
from pptutor_core.report import render, prepare


def execute(req):
    op = req.get("op", "status")
    if op not in ("status", "catalog", "search", "read", "report"):
        raise PptutorError("READ_ONLY", "PPT 素材库仅支持状态、目录、搜索、读页和汇总。")
    if op == "report":
        checked = prepare(req["decision"], req["evidence"])
        conditions = {c["id"]: c["text"] for c in checked["task"]["conditions"]}
        return {"ok": True, "report": render(req["decision"], req["evidence"], req.get("detail", "brief")),
                "verified_rows": [{"id": row["id"], "relevance": row["effective_relevance"], "use": row["use"], "reason": row["reason"], "quote": row["quote"],
                                   "conditions": [{"text": conditions[c["condition_id"]], "status": c["status"]} for c in row["assessments"]]}
                                  for row, _page in checked["usable"] + checked["excluded"]],
                "recommendations": [{"id": row["id"], "relevance": row["effective_relevance"]} for row, _page in checked["usable"]]}
    with Library(req.get("db"), req.get("roots", [])) as lib:
        if op == "status":
            result = lib.status()
            if req.get("includePaths"):
                result["documents"] = [dict(row) for row in lib.conn.execute("SELECT path,page_count FROM files WHERE status='ok' AND lower(ext) IN ('.pptx','.ppt')")]
            return result
        if op == "catalog":
            return lib.catalog(req.get("fileId"), req.get("offset", 0), req.get("limit", 30))
        if op == "search":
            plan = req.get("plan") or {"query": req.get("query", ""), "queries": [req.get("query", "")]}
            return lib.search(plan, req.get("limit", 30), req.get("perQuery", 60))
        refs = req.get("refs")
        if refs is None:
            refs = []
            for rid in req.get("ids", []):
                parts = str(rid).split(":")
                if len(parts) != 2:
                    raise PptutorError("INVALID_REFERENCE", "页引用格式为 file_id:page。")
                refs.append({"file_id": int(parts[0]), "page": int(parts[1])})
        return lib.read(refs, req.get("neighbors", 0))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        req = json.load(sys.stdin)
        if not isinstance(req, dict):
            raise ValueError("请求必须为 JSON 对象")
        result = execute(req)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": {"code": getattr(exc, "code", "PPT_READ_FAILED"),
                                               "message": str(exc)}}, ensure_ascii=False))
        sys.exit(2)
