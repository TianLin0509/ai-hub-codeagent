'use strict';

const RESET = '\x1b[0m';
const C = { text: '\x1b[38;2;220;230;247m', muted: '\x1b[38;2;146;164;190m',
  blue: '\x1b[38;2;159;180;255m', green: '\x1b[38;2;126;213;181m',
  amber: '\x1b[38;2;225;192;127m', red: '\x1b[38;2;246;147;155m',
  code: '\x1b[38;2;164;207;232m' };
// Only this module's fixed SGR escapes are trusted. Provider text cannot move
// the cursor, clear scrollback, set a title or inject OSC clipboard sequences.
function clean(text) {
  return String(text ?? '').replace(/\x1b/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function codeLine(text) {
  return C.code + text.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(const|let|var|function|return|async|await|if|else|for|class|import|from|def|print|true|false|null|None|True|False)\b/g,
    (token, string) => (string ? C.green : C.blue) + token + C.code) + RESET;
}

// Prose streams immediately. Only a possible Markdown prefix and a code line
// wait for more input; code lines are bounded so a missing newline cannot grow
// memory or hide an unbounded amount of output.
class MarkdownStream {
  constructor(write) { this.write = write; this.prefix = ''; this.start = true; this.code = false; this.line = ''; this.fence = false; }
  feed(raw) {
    let out = '';
    for (const char of clean(raw).replace(/\r\n?/g, '\n')) {
      if (this.start) {
        this.prefix += char;
        if (this.fence) {
          if (char === '\n' || this.prefix.length >= 80) {
            const language = this.prefix.slice(3).trim();
            out += C.muted + '  ──' + (!this.code && language ? ' ' + language : '') + RESET + '\n';
            this.code = !this.code; this.prefix = ''; this.fence = false; this.start = true;
          }
          continue;
        }
        if (this.prefix === '```') { this.fence = true; continue; }
        if (/^`{1,2}$/.test(this.prefix) || (!this.code && /^#{1,6}$/.test(this.prefix))) continue;
        if (!this.code && /^#{1,6} $/.test(this.prefix)) {
          out += '\x1b[1m' + C.blue; this.prefix = ''; this.start = false; continue;
        }
        const prefix = this.prefix; this.prefix = ''; this.start = false;
        if (this.code) this.line += prefix.replace(/\n$/, '');
        else out += C.text + prefix;
      } else if (this.code) {
        if (char !== '\n') this.line += char;
      } else out += char;
      if (char === '\n' || this.line.length >= 4096) {
        if (this.code) { out += codeLine(this.line) + (char === '\n' ? '\n' : ''); this.line = ''; }
        out += RESET;
        this.start = char === '\n';
      }
    }
    if (out) this.write(out);
  }
  flush() {
    if (this.prefix) this.write(C.text + this.prefix + RESET);
    if (this.line) this.write(codeLine(this.line));
    this.prefix = ''; this.line = ''; this.fence = false;
  }
}

class CodexTerminalPresentation {
  constructor(write) { this.write = write; this.items = new Map(); this.active = null; }
  section(key, label, color = C.blue) {
    if (this.active === key) return;
    if (this.active) this.items.get(this.active)?.stream?.flush();
    this.write(RESET + '\n\n' + color + '\x1b[1m' + '  ' + label + RESET
      + C.muted + '  ────────────────────────' + RESET + '\n\n');
    this.active = key;
  }
  prompt(text, { reset = true } = {}) {
    for (const item of this.items.values()) item.stream?.flush();
    if (reset) this.items.clear();
    this.active = null;
    this.section('user', '你');
    this.write(C.text + clean(text) + RESET + '\n');
  }
  agent(item) {
    let state = this.items.get(item.id);
    if (!state) { state = { text: '', stream: new MarkdownStream(this.write) }; this.items.set(item.id, state); }
    const text = String(item.text || '');
    if (text === state.text) return;
    const final = item.phase === 'final_answer';
    this.section(item.id, final ? 'Codex · 回答' : item.phase === 'commentary' ? 'Codex · 进展' : 'Codex', final ? C.green : C.amber);
    const delta = text.startsWith(state.text) ? text.slice(state.text.length) : '\n' + text;
    state.stream.feed(delta); state.text = text;
  }
  tool(item, completed = false) {
    let state = this.items.get(item.id);
    if (!state) {
      state = { output: '', done: false }; this.items.set(item.id, state);
      const labels = { commandExecution: '执行命令', fileChange: '文件变更', mcpToolCall: '调用工具',
        webSearch: '搜索', reasoning: '思考' };
      this.section(item.id, labels[item.type] || '工具 · ' + clean(item.type), C.muted);
      const detail = item.command || (item.tool ? `${item.server || ''} / ${item.tool}` : '');
      if (detail) this.write(C.code + clean(detail) + RESET + '\n');
    }
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    if (output && output !== state.output) {
      this.section(item.id, '工具输出', C.muted);
      this.write(C.muted + clean(output.startsWith(state.output) ? output.slice(state.output.length) : '\n' + output) + RESET);
      state.output = output;
    }
    if (completed && !state.done) {
      this.section(item.id, '工具结果', C.muted);
      const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      const code = typeof item.exitCode === 'number' ? ` · exit ${item.exitCode}` : '';
      this.write('\n' + (failed ? C.red : C.muted) + '  ' + (failed ? '失败' : item.status === 'declined' ? '已拒绝' : '结束') + code + RESET + '\n');
      if (item.error) this.write(C.red + clean(typeof item.error === 'string' ? item.error : item.error.message || JSON.stringify(item.error)) + RESET + '\n');
      state.done = true;
    }
  }
  toolDelta(id, text) {
    if (!this.items.has(id)) this.tool({id, type:'commandExecution'});
    const state = this.items.get(id);
    this.section(id, '工具输出', C.muted);
    state.output += text;
    this.write(C.muted + clean(text) + RESET);
  }
  finish(status) {
    this.items.get(this.active)?.stream?.flush();
    this.write(RESET + '\n\n' + (status === 'completed' ? C.green : status === 'failed' ? C.red : C.amber)
      + '  ' + ({completed:'✓ 已完成', interrupted:'■ 已中断', failed:'× 执行失败'}[status] || clean(status)) + RESET + '\n\n');
    this.active = null;
  }
}

module.exports = { CodexTerminalPresentation, MarkdownStream, clean };
