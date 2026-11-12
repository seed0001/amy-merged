import { config } from './config.js';
import { openRouterHeaders } from './llm.js';
import { noteSpend } from './spend.js';
import { scopedPath } from './files.js';

// The coding agent for her workshop jobs, on OpenRouter (not the Claude Code or OpenCode CLIs). It can
// read, list, find, edit and write files with the files tool, and nothing else: no shell, nothing run,
// nothing pushed. The same contract as runCoder: { ok, report, engine }.
const URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ROUNDS = 100; // hard cap against a runaway loop
const ROUND_MS = 180_000;

export async function openRouterCoder({
  prompt,
  rules,
  cwd,
  timeoutMs = 30 * 60_000,
  onChild = () => {},
  model = config.workshop.coderModel,
  fetchImpl = fetch,
} = {}) {
  if (!config.openrouter.apiKey) return { ok: false, report: 'There is no OpenRouter key, so the coding model can\'t run. Add OPENROUTER_API_KEY to .env.', engine: null };
  const { enabledTools, runTool } = await import('./tools.js');
  const ctx = { perms: { owner: true, files: true }, speaker: { id: 'workshop' }, conversation: 'workshop', turn: `workshop:${Date.now()}`, userText: prompt, character: { id: 'main', main: true, name: config.botName } };
  const defs = enabledTools(ctx).filter((t) => t.function.name === 'files');
  if (!defs.length) return { ok: false, report: 'The files tool is not available to the coder.', engine: null };

  // cancel() calls kill() on this, the same as it would on a child process.
  let stopped = false;
  const abort = new AbortController();
  onChild({ kill: () => { stopped = true; abort.abort(); } });
  const messages = [
    { role: 'system', content: `You are the coding agent for one project. Work only inside ${cwd}, with the files tool (read, list, find, edit, write). You cannot run programs or push anything.\n\n${rules}` },
    { role: 'user', content: prompt },
  ];
  const deadline = Date.now() + timeoutMs;
  const engine = `openrouter:${model}`;
  for (let round = 0; round < MAX_ROUNDS && !stopped && Date.now() < deadline; round++) {
    const res = await fetchImpl(URL, {
      method: 'POST',
      headers: openRouterHeaders(),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(ROUND_MS, Math.max(1, deadline - Date.now())))]),
      body: JSON.stringify({ model, messages, tools: defs, tool_choice: 'auto', max_tokens: 6000, usage: { include: true } }),
    });
    if (!res.ok) return { ok: false, report: `${model} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, engine };
    const data = await res.json();
    noteSpend('coding a project', model, data.usage);
    const message = data.choices?.[0]?.message ?? {};
    const calls = message.tool_calls ?? [];
    if (!calls.length) return { ok: true, report: String(message.content ?? '').trim() || 'Finished.', engine };
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      let result;
      try {
        if (stopped) break;
        if (call.function?.name !== 'files' || !['read', 'list', 'find', 'write', 'edit', 'mkdir'].includes(args.action)) throw new Error('This coder can only read, list, find, write, edit or make folders inside its project.');
        args.path = scopedPath(cwd, args.path || cwd);
        result = String(await runTool('files', args, ctx));
      } catch (error) { result = `[files: error failed] ${error.message}`; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 12000) });
    }
  }
  return { ok: false, report: stopped ? 'Stopped before it finished.' : 'Ran out of steps or time before it finished.', engine };
}
