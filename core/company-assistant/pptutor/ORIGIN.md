# PPTutor 文字索引读取核心

来自用户自有项目 `pptutor` v0.4.0，源提交：
`8166b2ead0551bb87d348c95212b70f18e8cd4d2`。

仅收录文字检索、读页、引用检查与汇总模块；未收录 organize、moves 或移动入口。
`readonly.py` 是 AI Hub 的固定只读适配器，不扫描或迁移 Doctor 索引。
原仓库未声明开源许可证，此记录不授予第三方分发许可。

2026-10-21：新增 `index.py`，使用 Python 标准库 `zipfile`、XML 和 SQLite 从用户明确选择的 1–3 个目录增量提取 `.pptx` 文字；仅写 Hub 自己的索引，原稿和 Doctor 索引始终只读。沿用原 v7 文字/FTS 协议，避免带入 Doctor GUI 和文件整理模块。`ppt-instructions.js` 移植原 skill 的用途拆解、扩搜、读页、逐条件证据检查流程；多来源引用增加稳定 source_id。
