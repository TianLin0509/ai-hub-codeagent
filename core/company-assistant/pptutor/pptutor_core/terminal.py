"""Small, log-friendly terminal presentation; JSON remains the automation contract."""
from collections import Counter
import shutil
import sys
import time
import unicodedata
from pathlib import Path
from . import VERSION

def clean(value):
    return ''.join(' ' if unicodedata.category(c) in ('Cc', 'Cf') else c for c in str(value))

def width(value):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W','F') else 1 for c in value)

def shorten(value, budget):
    value = clean(value)
    if width(value) <= budget: return value
    if value.startswith(('/', '\\')) or (len(value)>2 and value[1]==':' and value[2] in '/\\'):
        # Keep the destination/topic end of paths, rather than only the common drive prefix.
        prefix = ''; tail = ''; lead = min(10, budget//3)
        for c in value:
            if width(prefix+c)>lead: break
            prefix += c
        for c in reversed(value):
            if width(c+tail)>budget-width(prefix)-1: break
            tail = c+tail
        return prefix+'…'+tail
    out = ''
    for c in value:
        if width(out+c) > budget-1: break
        out += c
    return out+'…'

def table(headers, rows):
    rows = list(rows); cols = shutil.get_terminal_size((100, 24)).columns
    if cols < 60:
        return '\n\n'.join('\n'.join(f'{clean(h)}：{clean(v)}' for h,v in zip(headers,row)) for row in rows)
    cap = max(8, (cols-3*(len(headers)-1))//len(headers))
    widths = [min(cap, max([width(clean(h))]+[width(clean(r[i])) for r in rows])) for i,h in enumerate(headers)]
    desired = [min(64, max([width(clean(h))]+[width(clean(r[i])) for r in rows])) for i,h in enumerate(headers)]
    spare = cols-3*(len(headers)-1)-sum(widths)
    while spare>0 and any(w<d for w,d in zip(widths,desired)):
        i = max(range(len(widths)), key=lambda i: desired[i]-widths[i])
        widths[i] += 1; spare -= 1
    def line(row):
        return ' │ '.join((s := shorten(v,w))+' '*(w-width(s)) for v,w in zip(row,widths))
    return '\n'.join([line(headers), '─┼─'.join('─'*w for w in widths), *[line(r) for r in rows]])

class Progress:
    def __init__(self, enabled): self.enabled, self.last = enabled, 0
    def __call__(self, label, completed=None, total=None):
        now = time.monotonic()
        if not self.enabled or (completed and completed != total and now-self.last < .4): return
        suffix = f'  {completed}/{total}' if total is not None else '  进行中'
        marker = '✓' if total is not None and completed == total else '·'
        print(f'  {marker} {clean(label)}{suffix}', file=sys.stderr, flush=True); self.last = now

def checklist(command, result=None):
    if command == 'organize':
        kind = result.get('kind')
        if kind == 'undo_result': return '撤销流程  ① 读取日志 → ② 检查文件 → ③ 恢复位置'
        labels = ['① 盘点索引','② 判断归档','③ 选择范围','④ 预览方案','⑤ 确认执行']
        markers = ['✓','○','○','○','○']
        if kind == 'classification':
            markers[1] = '✓' if result['reviewed']==result['total_files'] else '·'
            markers[2] = '◇' if markers[1]=='✓' else '○'
        elif kind == 'organization_plan':
            markers=['✓','✓','✓','✓','◇']; labels[1]='② 已有归档判断'; labels[4]='⑤ 等待用户确认'
        elif kind == 'move_result':
            markers=['✓','✓','✓','✓','✓' if result['ok'] else '!']; labels[1]='② 已有归档判断'
        return '整理流程\n'+'\n'.join(f'  {m} {label}' for m,label in zip(markers,labels))
    return '检索流程  ① 理解用途 → ② 扩展查询 → ③ 阅读原页 → ④ 推荐素材'

def human(result, command, saved=None):
    lines = [f'PPTutor {VERSION}  ·  {command}', '═'*min(70, shutil.get_terminal_size((100,24)).columns), checklist('organize' if result.get('kind') else command, result)]
    kind = result.get('kind')
    if not result.get('ok', True): lines.append('状态：部分失败或未完成，请查看失败项。')
    if kind in ('inventory', 'inventory_view'):
        lines += [f"① 盘点：{result['total_files']} 份 PPT" + (f" · {len(result['folders'])} 个目录" if 'folders' in result else ''),
                  table(['文稿','所在目录','索引状态'], [(r['name'],r['folder'],r['status']) for r in result['files'][:15]]),
                  '下一步：Agent 分批查看目录与文字，补读原页后判断归档。']
    elif kind == 'classification':
        lines += [f"② 归档判断：已审阅 {result['reviewed']}/{result['total_files']}",
                  table(['归档判断','数量'], [(s,result['counts'].get(s,0)) for s in ('已归档','疑似散落','待判断')]),
                  f"用途范围：用户文稿 {result['eligibility_counts'].get('user',0)} · 程序资源 {result['eligibility_counts'].get('managed',0)} · 待确认 {result['eligibility_counts'].get('unknown',0)}",
                  '③ 选择范围：只整理散落文件 / 全量重新整理。待判断文件先保留；程序资产与模板不纳入用户文稿。']
    elif kind == 'organization_plan':
        folders = Counter(str(Path(a['destination']).parent) for a in result['actions'])
        lines += [f"④ 方案预览：{'只整理散落' if result['mode']=='scattered' else '全量重新整理'}",
                  f"计划移动 {len(result['actions'])} 份 · 范围内保留 {len(result['kept'])} 份 · 范围外 {len(result['untouched'])} 份",
                  '目标目录与本次迁入数量：', table(['目录','迁入'], sorted(folders.items())),
                  table(['文稿','推荐位置','理由'], [(Path(a['source']).name, a['destination'], a['reason']) for a in result['actions'][:15]]),
                  '状态：方案已生成，尚未移动。用户审阅、修改或确认后才能执行。']
    elif kind in ('move_result', 'undo_result'):
        key = 'moved' if kind == 'move_result' else 'restored'
        lines += [f"⑤ {'移动' if key=='moved' else '撤销'}：完成 {len(result[key])} 份 · 失败 {len(result['failures'])} 份", f"日志：{result['journal']}"]
        if result['failures']: lines.append(table(['文件编号','失败原因'], [(f['file_id'],f['message']) for f in result['failures']]))
    elif 'file_status_counts' in result:
        lines += [table(['格式','状态','数量'], [(x['ext'],x['status'],x['files']) for x in result['file_status_counts']]), f"已提取文字页：{result['nonempty_text_pages']}"]
    elif 'candidates' in result:
        lines += [f"② 检索候选：{len(result['candidates'])} 页 · 尚未做最终语义排序",
                  table(['页引用','文稿','正文线索'], [(r['id'],r['ref']['name'],r.get('snippet','')) for r in result['candidates'][:15]]),
                  '下一步：阅读候选原页，按用途核对并推荐。']
    elif 'pages' in result:
        lines += [f"③ 已读取 {len(result['pages'])} 页", table(['页引用','文稿','来源状态'], [(r['id'],r['ref']['name'],r['source_state']) for r in result['pages']])]
        if not saved:
            for p in result['pages']: lines += [f"\n{p['id']} · {clean(p['ref']['name'])}", '\n'.join(clean(line) for line in p['text'].splitlines())]
        if result.get('missing'): lines.append('未读到的引用：'+clean(result['missing']))
    elif 'items' in result:
        lines += [table(['文稿','页/编号','线索'], [(r['name'],r.get('page',r['file_id']),r.get('heading',r.get('path',''))) for r in result['items']])]
    for warning in result.get('warnings', []): lines.append('注意：'+clean(warning))
    if result.get('index_update'): lines.append(result['index_update'])
    if result.get('note'): lines.append(result['note'])
    if result.get('truncated') or result.get('has_more'): lines.append('仍有未展示或未覆盖的条目，请分批继续。')
    if saved: lines.append('完整结果：'+str(Path(saved).absolute()))
    if kind in ('inventory','inventory_view','organization_plan') or 'candidates' in result: lines.append('终端只展示前 15 项；完整结果以保存文件为准。')
    return '\n\n'.join(lines)

def plan_markdown(plan):
    def escape(v): return str(v).replace('|','\\|').replace('\n',' ')
    lines = [f'# PPTutor {VERSION} · 整理方案', '', f"模式：{'只整理散落' if plan['mode']=='scattered' else '全量重新整理'}。计划移动 {len(plan['actions'])} 份；尚未执行。", '', '```text']
    groups = {}
    for a in plan['actions']: groups.setdefault(str(Path(a['destination']).parent), []).append(Path(a['source']).name)
    for folder, names in sorted(groups.items()):
        lines += [f'{folder}/  ({len(names)} 份)', *[f'  ├─ {name}' for name in names[:3]]]
        if len(names)>3: lines.append(f'  └─ … 另 {len(names)-3} 份')
    lines += ['```', '', '| 文稿 | 原位置 | 推荐位置 | 理由 |', '|---|---|---|---|']
    for a in plan['actions']: lines.append('| '+' | '.join(map(escape,[Path(a['source']).name,a['source'],a['destination'],a['reason']]))+' |')
    lines += ['', f"范围内保留 {len(plan['kept'])} 份；范围外 {len(plan['untouched'])} 份。", '', plan['index_update'], '', '确认后可以执行，也可以先修改方案。']
    for w in plan.get('warnings',[]): lines.append('\n注意：'+escape(w))
    return '\n'.join(lines)+'\n'
