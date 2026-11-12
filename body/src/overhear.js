import { config } from './config.js';
import { activity, bus } from './events.js';
import { json } from './llm.js';
import { permissions } from './contacts.js';
import { act } from './actions.js';
import { enabledTools, runTool } from './tools.js';

// Overheard talk: the owner is talking in a call, and not to her. If something in it is an actual
// request she could carry out (check a file, look something up, fix or change something), her hands
// do it, quietly, with the same tools she'd have if he'd asked her directly. She only speaks up when
// there's something he needs to know. Only the owner's lines count: other people's talk is never acted on.
const ACTION_WORDS = /\b(check|look|find out|fix|adjust|change|update|review|read|open|search|research|source|file|code|bug|issue|setting|make sure|you need|you should|can you|could you|please|go ahead|todo|remind)\b/i;
const MIN_GAP_MS = 20_000;
const PROMPT = 'You hear a conversation the owner is having that is not addressed to you. Decide whether he is asking you, the assistant, to do something concrete that tools can do: check or look something up, read, check or fix a file or code, change a setting, research something, or open something. If he is, reply {"actionable": true, "request": "the request, restated plainly as an instruction to you"}. If it is chat, a feeling, a question for someone else, or small talk, reply {"actionable": false}. Reply with JSON only.';

export function createOverhear({
  ask = (messages) => json(messages, { purpose: 'overhear' }),
  hands = handsFor,
  announce = (event) => bus.emit('overheard-task', event),
  log = activity,
  permit = (id) => permissions(id),
  now = Date.now,
} = {}) {
  let pending = null;
  let last = -Infinity;
  async function work({ speaker, line, conversation, isCurrent }) {
    try {
      const verdict = await ask([{ role: 'system', content: PROMPT }, { role: 'user', content: line }]);
      if (!isCurrent() || !verdict?.actionable || typeof verdict.request !== 'string' || !verdict.request.trim()) return null;
      last = now();
      const request = verdict.request.trim().slice(0, 500);
      const acted = await hands({ speaker, text: request, conversation });
      const report = String(acted.report ?? '').trim();
      const failures = acted.calls.filter((c) => /^\[[\w-]+: error/.test(c.result));
      log('overheard-task', { conversation, speaker: speaker.name, request, tools: acted.calls.map((c) => c.name), failed: failures.length });
      // Routine success stays quiet. Any spoken result needs a tool receipt.
      const failed = failures.length > 0;
      const reported = Boolean(isCurrent() && acted.calls.length && (failed || (report && report !== 'NOTHING' && !/^(done|ok)\.?$/i.test(report))));
      if (reported) {
        announce({ conversation, speaker: speaker.name, request, calls: acted.calls, report, failed, isCurrent });
      }
      return { ...acted, reported };
    } catch (err) {
      log('error', { where: 'overheard task', message: err.message });
      return null;
    }
  }
  return {
    hear({ speaker, text, conversation, isCurrent = () => true }) {
      const line = String(text ?? '').trim();
      if (!speaker?.id || line.length < 12 || !ACTION_WORDS.test(line)) return null;
      if (!permit(speaker.id).owner || pending || now() - last < MIN_GAP_MS) return null;
      const result = work({ speaker, line, conversation, isCurrent }).finally(() => { pending = null; });
      pending = { speakerId: speaker.id, conversation, result };
      return result;
    },
    pendingReport(conversation, speakerId) {
      if (!pending || pending.conversation !== conversation || pending.speakerId !== speakerId) return null;
      return pending.result.then((result) => Boolean(result?.reported));
    },
  };
}

// Her hands on an overheard request: the same tools she has for the owner, the owner's permissions,
// and the request itself (not the whole conversation).
export async function handsFor({ speaker, text, conversation }) {
  const perms = permissions(speaker.id);
  const character = { id: 'main', main: true, name: config.botName };
  const ctx = { perms, speaker, conversation, turn: `${conversation}:${Date.now()}`, userText: text, character };
  const available = enabledTools(ctx).filter((t) => t.function.name !== 'request_tool');
  const run = (name, args) => runTool(name, args, ctx);
  return act({ name: config.botName, speaker: speaker.name, owner: Boolean(perms.owner), text, recent: [], state: '', tools: available, run });
}

export const overhear = createOverhear();
