"""Build Hub's own text index from explicitly selected folders; never write PPTs."""
import hashlib
import json
import os
import posixpath
import sqlite3
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from pptutor_core.text import TOKEN, normalize

MAX_XML = 12 * 1024 * 1024
MAX_PACKAGE_XML = 96 * 1024 * 1024
MAX_PAGES = 4000
NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NS_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def tokenize(text):
    base = TOKEN.findall(normalize(text))
    return " ".join(base + [t[i:i+3] for t in base if t.isascii() and len(t) >= 3 for i in range(len(t)-2)])


def linked(path):
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def extract(source):
    """Use presentation relationships for real slide order; include notes/SmartArt."""
    with zipfile.ZipFile(source) as package:
        infos = {i.filename: i for i in package.infolist()}
        spent = 0

        def xml(name):
            nonlocal spent
            info = infos.get(name)
            if info is None:
                raise ValueError("PPTX 缺少 " + name)
            if info.file_size > MAX_XML or spent + info.file_size > MAX_PACKAGE_XML:
                raise ValueError("页面 XML 超过读取上限，未截断入库")
            spent += info.file_size
            raw = package.read(info)
            if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
                raise ValueError("XML 含不支持的实体定义")
            return ET.fromstring(raw)

        def relations(part):
            name = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
            if name not in infos:
                return {}
            result = {}
            for rel in xml(name):
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target", "")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(part), target)) if not target.startswith("/") else target.lstrip("/")
                if resolved.startswith("../") or "\\" in resolved:
                    raise ValueError("PPTX 内部引用超出包范围")
                result[rel.get("Id")] = (resolved, rel.get("Type", "").rsplit("/", 1)[-1])
            return result

        presentation = xml("ppt/presentation.xml")
        rels = relations("ppt/presentation.xml")
        slides = presentation.findall("./" + NS_P + "sldIdLst/" + NS_P + "sldId")
        if not slides or len(slides) > MAX_PAGES:
            raise ValueError("PPTX 页数为空或超过 4000 页")
        pages = []
        for slide in slides:
            part, kind = rels.get(slide.get(NS_R + "id"), (None, None))
            if kind != "slide":
                raise ValueError("PPTX 页面引用无效")
            pieces = []
            root = xml(part)
            for paragraph in root.iter(NS_A + "p"):
                value = "".join(t.text or "" for t in paragraph.iter(NS_A + "t"))
                if value.strip():
                    pieces.append(value)
            # Referred notes and diagram data are text evidence, not visual analysis.
            for extra, relation in relations(part).values():
                if relation not in ("notesSlide", "diagramData") or extra not in infos:
                    continue
                more = xml(extra)
                for shape in more.iter(NS_P + "sp") if relation == "notesSlide" else [more]:
                    if relation == "notesSlide" and any(ph.get("type") in ("sldNum", "dt", "hdr", "ftr", "sldImg") for ph in shape.iter(NS_P + "ph")):
                        continue
                    for paragraph in shape.iter(NS_A + "p"):
                        value = "".join(t.text or "" for t in paragraph.iter(NS_A + "t"))
                        if value.strip():
                            pieces.append(value)
            pages.append("\n".join(pieces))
        return pages


def progress(value):
    print(json.dumps(value, ensure_ascii=False), file=sys.stderr, flush=True)


def under(file, folder):
    try:
        Path(file).relative_to(Path(folder))
        return True
    except ValueError:
        return False


def run(request):
    roots = request.get("roots", [])
    if not isinstance(roots, list) or not 1 <= len(roots) <= 3 or any(not isinstance(r, str) or not Path(r).is_absolute() for r in roots):
        raise ValueError("请选择 1–3 个完整文件夹路径")
    roots = list(dict.fromkeys(str(Path(r).resolve()) for r in roots))
    db_path = Path(request["db"])
    if db_path.exists():
        # Check ownership through a read-only connection before PRAGMA/schema writes.
        try:
            with sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True) as existing:
                owner = existing.execute("SELECT value FROM meta WHERE key='hub_index_owner'").fetchone()
                if owner is None or owner[0] != "company-assistant-v1":
                    raise ValueError("foreign index")
        except (sqlite3.Error, ValueError) as exc:
            raise ValueError("目标并非 Hub 自建索引，不会修改") from exc
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=2)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript("""
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, path TEXT UNIQUE, name TEXT, name_norm TEXT, ext TEXT,
        size INTEGER, mtime REAL, content_hash TEXT, page_count INTEGER, status TEXT, indexed_at REAL, mtime_ns INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS pages_raw(file_id INTEGER, page_no INTEGER, raw_text TEXT, PRIMARY KEY(file_id,page_no));
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(content, file_id UNINDEXED, page_no UNINDEXED);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    connection.execute("INSERT OR REPLACE INTO meta VALUES('hub_index_owner','company-assistant-v1')")
    connection.execute("INSERT OR REPLACE INTO meta VALUES('index_version','7')")
    connection.commit()
    stats = dict(scanned=0, indexed=0, unchanged=0, failed=0, skippedPpt=0, skippedLinks=0, files=0, pages=0, errors=[], roots=roots)
    seen, failed_roots = set(), set()
    for folder in roots:
        root = Path(folder)
        if not root.is_dir():
            failed_roots.add(folder)
            stats["errors"].append(dict(path=folder, error="文件夹不可用，保留原索引"))
            continue

        def walk_error(exc):
            failed_roots.add(folder)
            stats["errors"].append(dict(path=str(exc.filename), error=str(exc)))

        for directory, subdirs, files in os.walk(root, followlinks=False, onerror=walk_error):
            allowed = [d for d in subdirs if not linked(Path(directory) / d)]
            stats["skippedLinks"] += len(subdirs) - len(allowed)
            subdirs[:] = allowed
            for name in files:
                source = Path(directory) / name
                ext = source.suffix.casefold()
                if ext == ".ppt":
                    stats["skippedPpt"] += 1
                    continue
                if ext != ".pptx" or name.startswith("~$"):
                    continue
                if linked(source):
                    stats["skippedLinks"] += 1
                    continue
                item = str(source.resolve())
                if item in seen:
                    continue
                seen.add(item)
                stats["scanned"] += 1
                try:
                    before = source.stat()
                    old = connection.execute("SELECT id,mtime_ns,size,status FROM files WHERE path=?", (item,)).fetchone()
                    if old and old[1:] == (before.st_mtime_ns, before.st_size, "ok"):
                        stats["unchanged"] += 1
                        continue
                    pages = extract(source)
                    digest = hashlib.sha256()
                    with source.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                    content_hash = digest.hexdigest()
                    after = source.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError("读取期间文件发生变化，请稍后更新")
                    connection.execute("""INSERT INTO files(path,name,name_norm,ext,size,mtime,content_hash,page_count,status,indexed_at,mtime_ns,error)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET name=excluded.name,name_norm=excluded.name_norm,
                      size=excluded.size,mtime=excluded.mtime,content_hash=excluded.content_hash,page_count=excluded.page_count,
                      status=excluded.status,indexed_at=excluded.indexed_at,mtime_ns=excluded.mtime_ns,error=excluded.error""",
                      (item, name, normalize(name), ext, after.st_size, after.st_mtime, content_hash, len(pages), "ok", time.time(), after.st_mtime_ns, ""))
                    fid = connection.execute("SELECT id FROM files WHERE path=?", (item,)).fetchone()[0]
                    connection.execute("DELETE FROM pages_raw WHERE file_id=?", (fid,))
                    connection.execute("DELETE FROM pages_fts WHERE file_id=?", (fid,))
                    connection.executemany("INSERT INTO pages_raw VALUES(?,?,?)", [(fid, i, t) for i, t in enumerate(pages, 1)])
                    connection.executemany("INSERT INTO pages_fts VALUES(?,?,?)", [(tokenize(t), fid, i) for i, t in enumerate(pages, 1)])
                    connection.commit()
                    stats["indexed"] += 1
                except Exception as exc:
                    connection.rollback()
                    stats["failed"] += 1
                    stats["errors"].append(dict(path=item, error=str(exc)))
                    # Mark old content as stale instead of serving it as a successful update.
                    connection.execute("UPDATE files SET status='error',error=? WHERE path=?", (str(exc), item))
                    connection.commit()
                finally:
                    progress({"state": "indexing", **{k: stats[k] for k in ("scanned", "indexed", "unchanged", "failed", "skippedPpt")}})
    for fid, item in connection.execute("SELECT id,path FROM files").fetchall():
        if item not in seen and not any(under(item, r) for r in failed_roots):
            connection.execute("DELETE FROM files WHERE id=?", (fid,))
            connection.execute("DELETE FROM pages_raw WHERE file_id=?", (fid,))
            connection.execute("DELETE FROM pages_fts WHERE file_id=?", (fid,))
    stats["files"], stats["pages"] = connection.execute("SELECT count(*),coalesce(sum(page_count),0) FROM files WHERE status='ok'").fetchone()
    stats["completedAt"] = int(time.time() * 1000)
    stats["complete"] = not stats["failed"] and not stats["errors"]
    connection.execute("INSERT OR REPLACE INTO meta VALUES('hub_index_stats',?)", (json.dumps(stats, ensure_ascii=False),))
    connection.execute("INSERT OR REPLACE INTO meta VALUES('last_completed_scan_at',?)", (str(time.time()),))
    connection.commit()
    connection.close()
    return {"ok": True, **stats}


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": {"code": "INDEX_BUILD_FAILED", "message": str(error)}}, ensure_ascii=False))
        sys.exit(2)
