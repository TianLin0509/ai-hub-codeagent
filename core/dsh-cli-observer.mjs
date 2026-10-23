// Native DSH observation only. The TUI owns stdin, tools and human decisions.
// No ACP server, transport or execution proxy is loaded by this extension.
import fs from 'node:fs';
import path from 'node:path';
export const name = 'hub-dsh-cli-observer';
export const inject = ['agents', 'sessions'];
export function apply(ctx) {
  const file = process.env.AI_HUB_DSH_EVENT_LOG;
  if (!file) throw new Error('Missing Hub native DSH event log');
  const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  let root;
  const isRoot = agent => ctx.agents.roots().includes(agent);
  // /fork creates a detached root; only the TUI's foreground discovery record
  // can change Hub's binding. /new and /resume publish that record themselves.
  const bindForeground = () => {
    let entries; try { entries = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.dsh-tui/inject/servers.json'), 'utf8')); } catch { return; }
    const id = Array.isArray(entries) && entries.find(e => e.pid === process.pid)?.sessionId;
    const agent = id && ctx.agents.get(id);
    if (!agent || agent === root || !isRoot(agent)) return;
    root = agent;
    append({ type: 'bound', sessionId: String(agent.id), cwd: agent.session.header.cwd,
      model: agent.options.model, effort: agent.options.reasoningEffort, status: agent.status, events: agent.session.snapshotEvents() });
  };
  const timer = setInterval(bindForeground, 50);
  ctx.effect(() => () => clearInterval(timer));
  ctx.on('session/event', (session, event) => {
    if (root?.session === session) append({ type: 'event', sessionId: String(session.id), event });
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (root === agent) append({ type: 'status', sessionId: String(agent.id), status });
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (root === agent) append({ type: 'stream', sessionId: String(agent.id), frame });
  });
  ctx.on('agent/error', ({ agent, error }) => {
    if (root === agent) append({ type: 'error', sessionId: String(agent.id), message: error.message });
  });
  ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== root) return next();
    const sessionId = String(root.id);
    append({ type: 'waiting', sessionId });
    try { return await next(); }
    finally { append({ type: 'status', sessionId, status: 'running' }); }
  });
  ctx.provide('hubCliObserver', true);
}
