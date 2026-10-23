// Await the official CLI's complete boot audit before Hub can send stdin.
// DSH creates an agent before its TUI finishes composing; that is not readiness.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const entry = process.env.AI_HUB_DSH_CLI_ENTRY;
process.argv[1] = entry;
const { runCli } = await import(pathToFileURL(entry).href);
await runCli();
fs.appendFileSync(process.env.AI_HUB_DSH_EVENT_LOG, JSON.stringify({ type: 'ready' }) + '\n');
