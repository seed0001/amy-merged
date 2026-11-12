import { codingToolCalls } from './coding-tools.js';
import { promptMessages as editedMessages, promptText } from './prompts.js';
import { Ollama } from 'ollama';
import { config } from './config.js';
import { activity } from './events.js';
import { noteSpend } from './spend.js';
import { streamChatGPT, chatGPTJson } from './chatgpt-provider.js';
import { chatgptAuth } from './chatgpt-auth.js';
import { providerRequestError } from './provider-failover.js';
import { generateFluxImage } from './flux.js';
import { generateKontextImage } from './kontext.js';

let ollama, ollamaHost;
function localClient() {
  if (!ollama || ollamaHost !== config.ollama.host) {
    ollamaHost = config.ollama.host;
    ollama = new Ollama({ host: ollamaHost, fetch: (...args) => globalThis.fetch(...args) });
  }
  return ollama;
}
const KEEP_ALIVE = '30m';
const EMBED_LIMIT_MS = 5000;
function localRequest(request, purpose = 'conversation') {
  if (purpose !== 'conversation') request = { ...request, messages: editedMessages(purpose, request.messages) };
  // No inner-life guidance is added here any more (owner, 2026-11-09): it used to go on every local call,
  // memory extraction included, and anyone could set it. Now it's hers (inner-core.js 'inner_life'), and it
  // goes only into her private thinking, through innerCore.innerVoice() in those prompts.
  // Her thinking on OpenRouter (config.cognition): every request that isn't a streamed local reply goes there,
  // answered in the shape Ollama gives, so nothing that asks has to change.
  if (config.cognition.provider === 'openrouter' && !request.stream) return cloudThink(request, purpose);
  // Models without a thinking mode reject `think: true`; retry the same request without it.
  const client = localClient();
  const local = () => client.chat(request).catch((err) => {
    if (!request.think || !/does not support thinking/i.test(err?.message ?? '')) throw err;
    return client.chat({ ...request, think: false });
  });
  if (request.stream) return local();
  return localFirst(local, (model) => cloudThink(request, purpose, { model }), purpose);
}

// The local model first, a cheap cloud model when it's down (owner, 2026-11-11: Ollama quit at 10:51 PM and every
// background job, memory, recall, taste, topics, failed for 40 minutes with "fetch failed"). Only an unreachable
// local model falls back; a slow or wrong answer is the local model's own and is not sent to the cloud. While it's
// down, calls go straight to the fallback and the local model is tried again each minute. Down and back are each
// logged once, saying why and the fix. cloud(model) makes the same call on OpenRouter with that model.
export const LOCAL_FALLBACK = { retryMs: 60_000 };
let localDown = null; // { since, until, error }
const unreachable = (err) => /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|socket hang up|other side closed/i
  .test(`${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`);
export const localModelDown = () => (localDown ? { ...localDown } : null);
export async function localFirst(local, cloud, purpose = 'background') {
  const fallback = config.cognition.fallbackModel;
  const canFall = Boolean(fallback && fallback !== 'off' && config.openrouter.apiKey);
  if (localDown && Date.now() < localDown.until && canFall) return cloud(fallback);
  try {
    const out = await local();
    if (localDown) {
      activity('local-model', { recovered: true, minutes: Math.round((Date.now() - localDown.since) / 60_000), message: `The local model at ${config.ollama.host} is answering again; background thinking is back on it.` });
      localDown = null;
    }
    return out;
  } catch (err) {
    if (!unreachable(err)) throw err;
    if (!canFall) {
      throw new Error(`the local model at ${config.ollama.host} isn't answering (${err.message}), and there's no cloud fallback (${config.openrouter.apiKey ? 'cognitionFallback is off' : 'OPENROUTER_API_KEY is empty'}). Fix: start Ollama (start.bat does), or set a cognitionFallback model`);
    }
    const first = !localDown;
    localDown = { since: localDown?.since ?? Date.now(), until: Date.now() + LOCAL_FALLBACK.retryMs, error: err.message };
    if (first) activity('local-model', { down: true, fallback, message: `The local model at ${config.ollama.host} isn't answering (${err.message}), so background thinking (${purpose} first) runs on ${fallback} through OpenRouter until it's back, trying the local model again every minute. That costs money. Fix: start Ollama (start.bat does).` });
    return cloud(fallback);
  }
}

// One request in Ollama's shape ({ messages, tools, format, options: { num_predict, temperature } }) answered by
// OpenRouter with config.cognition.model, returned in Ollama's shape ({ message: { content, tool_calls },
// done_reason, eval_count }). Throws saying what failed, why, and the fix.
const COGNITION_TIMEOUT_MS = 120_000;
async function cloudThink(request, purpose = 'background', { timeoutMs = COGNITION_TIMEOUT_MS, model = config.cognition.model } = {}) {
  if (!config.openrouter.apiKey) throw new Error(`her thinking runs on OpenRouter (${model}), but OPENROUTER_API_KEY is empty in .env. Fix: add the key, or set cognition to ollama to think on the local model`);
  const o = request.options ?? {};
  const effort = config.cognition.reasoning;
  const format = request.format === 'json' ? { response_format: { type: 'json_object' } }
    : request.format && typeof request.format === 'object' ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: false, schema: request.format } } } : {};
  const body = {
    model,
    messages: request.messages.map(({ _responsesOutput, ...m }) => toOpenAI(m)),
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...format,
    // A short job with a small budget would spend it all thinking and answer nothing: room is added for it.
    ...(o.num_predict ? { max_tokens: o.num_predict + (effort === 'none' ? 0 : 2000) } : {}),
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    reasoning: effort === 'none' ? { enabled: false } : { effort },
    usage: { include: true }, // the answer carries its real price (spend.js)
  };
  let res;
  try {
    res = await fetch(`${OPENROUTER}/chat/completions`, { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError'
      ? `OpenRouter (${model}) took longer than ${timeoutMs / 1000}s on ${purpose}. Fix: try again; if it keeps happening, OpenRouter or the model is overloaded, or pick a faster cognition model`
      : `couldn't reach OpenRouter for ${purpose} (${err?.message ?? err}). Fix: check the internet connection`);
  }
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'openrouter', res.status);
  const data = await res.json();
  if (data.error) throw providerRequestError(data, 'openrouter');
  noteSpend(purpose, model, data.usage);
  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const tool_calls = (msg.tool_calls ?? []).map((c) => {
    let args = c.function?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { /* left as text: the caller says what's wrong with it */ } }
    return { id: c.id, function: { name: c.function?.name, arguments: args } };
  });
  return {
    model, message: { role: 'assistant', content: msg.content ?? '', ...(tool_calls.length ? { tool_calls } : {}) },
    done_reason: choice.finish_reason === 'length' ? 'length' : 'stop', eval_count: data.usage?.completion_tokens ?? 0,
  };
}

// The text of one answer from her thinking model, for the few places that used to call a local model directly
// (intuition's line reads, dreams). Only for cognition on OpenRouter; with ollama they keep their own local model.
export async function thinkText(messages, { json = false, maxTokens, temperature, purpose = 'background', timeoutMs, model } = {}) {
  const res = await cloudThink({ messages, ...(json ? { format: 'json' } : {}), options: { ...(maxTokens ? { num_predict: maxTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) } }, purpose, { timeoutMs, ...(model ? { model } : {}) });
  return res.message.content ?? '';
}

// Tool rounds per reply (TOOL_ROUNDS in .env): enough to look something up and then act on it. The
// classifier is advisory; file and code work can earn a bounded multistep allowance.
// No round limit: a reply runs its tool rounds until the model answers, the pressure decides what she does next.
const MAX_TOOL_ROUNDS = Infinity;
// A reply may make up to TOOL_CALL_CAP tool calls. It stops every CHECKIN_EVERY calls to check with the owner, and at the cap it stops for good.
const TOOL_CALL_CAP = 100;
const CHECKIN_EVERY = 25;
// A tool result that failed or came back incomplete (see runTool's result header in tools.js).
const SETBACK = /^\[[\w-]+: error|^Error|TRUNCATED|NOT READ/;
const LOOKUP_FILLERS = ['Hang on, let me look that up.', 'One sec, checking.', 'Let me look into that real quick.'];

// Streams a chat reply, calling onSentence for each complete sentence as it arrives
// (so voice can start speaking before the whole reply is generated). Returns the full text.
// If tools are given, the model may call them; results are fed back and it keeps going.
// maxRounds: how many times the model may call tools before it must answer. repeatable: tools it
// may call more than once (working on files takes read, edit, read again); every other tool runs
// at most once per reply.
// free: bookkeeping tools (her notes); a round that only uses those doesn't count against
// maxRounds, up to two such rounds, so taking a note never costs her the reply.
export async function chat(messages, { onSentence, tools = [], runTool, maxRounds = MAX_TOOL_ROUNDS, repeatable = [], expandOnTools = [], free = [], voice = false, onUsage, onTokens, streamFactory = startChat } = {}) {
  messages = [...messages];
  maxRounds = Number(maxRounds) || MAX_TOOL_ROUNDS;
  let full = '';
  let spoke = false;
  const used = new Set();
  let paid = 0, freeRounds = 0, nudged = false, retried = false;
  let toolCalls = 0, nextCheckIn = CHECKIN_EVERY;
  const outcomes = []; // "files read: ok", for the notice when rounds run out
  const say = async (sentence) => {
    spoke = true;
    await onSentence(sentence);
  };

  for (let round = 0; ; round++) {
    const offerTools = tools.length > 0 && paid < maxRounds;
    const stream = await streamFactory(messages, offerTools ? tools : null, voice);

    let content = '';
    let pending = '';
    let calls = [];
    let usage = null;
    let responseOutput;
    let roundProvider, roundModel;
    const odds = []; // each word's alternatives, when the brain reports them (conflicts.js)
    for await (const part of stream) {
      if (part.provider) { roundProvider = part.provider; roundModel = part.model; }
      if (onTokens && Array.isArray(part.logprobs)) odds.push(...part.logprobs);
      if (part.responseOutput) responseOutput = part.responseOutput;
      if (part.usage) {
        usage = {
          prompt: part.usage.prompt_tokens,
          completion: part.usage.completion_tokens,
          total: part.usage.total_tokens,
          cost: part.usage.cost,
          cached: part.usage.cached_tokens ?? part.usage.prompt_tokens_details?.cached_tokens,
        };
      } else if (part.prompt_eval_count != null) {
        usage = {
          prompt: part.prompt_eval_count,
          completion: part.eval_count ?? 0,
          total: (part.prompt_eval_count ?? 0) + (part.eval_count ?? 0),
        };
      }
      if (part.message?.tool_calls?.length) calls.push(...part.message.tool_calls);
      const chunk = part.message?.content ?? '';
      // The model running on past its own reply into an invented chat log ("[Owner]: ...", the way
      // history is written for it): from the first speaker tag on it's dropped and the stream stops,
      // so it's never said or sent.
      const runOn = (content + chunk).search(RUN_ON);
      if (runOn > 0) {
        const drop = content.length + chunk.length - runOn;
        content = (content + chunk).slice(0, runOn);
        if (onSentence) pending = (pending + chunk).slice(0, Math.max(0, pending.length + chunk.length - drop));
        break;
      }
      content += chunk;
      if (!onSentence) continue;
      pending += chunk;
      let cut;
      // The first piece she says can end at a comma or dash, so speech starts on a short phrase.
      while ((cut = findSentenceEnd(pending, !spoke)) !== -1) {
        const sentence = pending.slice(0, cut).trim();
        pending = pending.slice(cut);
        if (sentence) await say(sentence);
      }
    }
    if (onSentence && pending.trim()) await say(pending.trim());
    if (usage) onUsage?.({ ...usage, round, ...(roundProvider ? { provider: roundProvider, model: roundModel } : {}) });
    if (odds.length && content.trim()) { try { onTokens({ tokens: odds, round, provider: roundProvider, model: roundModel }); } catch {} }
    if (content.trim()) full += (full ? ' ' : '') + content.trim();
    // Even a provider that invents calls after tools are withdrawn cannot run indefinitely.
    if (!offerTools && calls.length) return full || 'I reached the action limit for this reply. The remaining work needs another turn.';
    // Each tool at most once per reply (unless repeatable), even if the model asks for it again.
    calls = calls.map((call, index) => ({ ...call, id: call.id || `amy_call_${round}_${index}` }));
    const blockedCalls = new Set();
    for (const call of calls) {
      if (!repeatable.includes(call.function.name) && used.has(call.function.name)) blockedCalls.add(call);
      else used.add(call.function.name);
    }
    if (!calls.length) {
      // Tools ran but nothing was said: ask once more, without tools, for the actual reply.
      if (!full.trim() && round > 0 && !nudged) {
        nudged = true;
        paid = maxRounds;
        messages.push({ role: 'user', content: '(Now reply to them. Say your answer out loud; no tools.)' });
        continue;
      }
      return full;
    }
    if (calls.every((c) => free.includes(c.function.name)) && freeRounds < 2) freeRounds++;
    else paid++;

    // Avoid dead air in voice while a tool runs.
    if (onSentence && !spoke && calls.some((c) => c.function.name === 'web_search')) await say(LOOKUP_FILLERS[Math.floor(Math.random() * LOOKUP_FILLERS.length)]);
    messages.push({ role: 'assistant', content, tool_calls: calls, ...(responseOutput ? { _responsesOutput: responseOutput } : {}) });
    let setback = false;
    for (const call of calls) {
      toolCalls++;
      const result = blockedCalls.has(call)
        ? `[${call.function.name}: error conflict] This tool already ran in this reply. Use its existing result instead of repeating it.`
        : toolCalls > TOOL_CALL_CAP ? `[${call.function.name}: stopped] This reply has reached ${TOOL_CALL_CAP} tool calls. Stop here and tell the owner what is done and what is left.` : await runTool(call.function.name, call.function.arguments);
      // A successful guide read quotes words like TRUNCATED in its own text; that isn't a setback.
      const bad = SETBACK.test(result) && !(call.function.name === 'guide' && result.startsWith('[guide: ok]'));
      if (bad) {
        setback = true;
        if (!blockedCalls.has(call)) used.delete(call.function.name); // a failed call may be retried
      }
      if (!free.includes(call.function.name)) {
        let action = '';
        try { action = JSON.parse(call.function.arguments || '{}').action ?? ''; } catch {}
        outcomes.push(`${call.function.name}${action ? ` ${action}` : ''}: ${bad ? (/TRUNCATED|NOT READ/.test(result) ? 'incomplete' : 'failed') : 'ok'}`);
      }
      messages.push({ role: 'tool', content: result, tool_name: call.function.name, tool_call_id: call.id });
    }
    // Checkpoints: every CHECKIN_EVERY calls she stops and checks with the owner; at the cap she stops for this reply.
    if (toolCalls >= nextCheckIn || toolCalls >= TOOL_CALL_CAP) {
      nextCheckIn += CHECKIN_EVERY;
      paid = maxRounds;
      messages.push({ role: 'user', content: toolCalls >= TOOL_CALL_CAP ? `(${TOOL_CALL_CAP} tool calls this reply, the limit. Stop calling tools. Tell the owner what is done and what is left, and wait for them.)` : `(${toolCalls} tool calls this reply. Stop calling tools now. Tell the owner what is done and what is left, and ask whether to carry on.)` });
    }
    // An error or a cut-short read gets one more round to fix the call or read on, even when the
    // turn's rounds are used up, instead of answering on half the facts. Once per reply.
    if (setback && paid >= maxRounds && !retried) {
      retried = true;
      paid = maxRounds - 1;
    }
    // Out of rounds: say so, with what was done, so the answer is honest about what isn't.
    if (paid >= maxRounds && tools.length) {
      messages.push({
        role: 'user',
        content: `(No more tool rounds this reply. Calls made: ${outcomes.join('; ') || 'none'}. Answer now; be clear about anything that failed or isn't finished, and that it can be continued next message.)`,
      });
    }
  }
}

// A line starting with a speaker tag, as history is given to the model: "\n[Owner]: ..." or
// "\n[Amy Smith]: ...". Text from there on is the model inventing the rest of the conversation.
const RUN_ON = /\n\s*\[[^\]\n]{1,40}\]:/;

async function startChat(messages, tools, voice = false) {
  const { providerRouter } = await import('./provider-router.js');
  return providerRouter.stream(messages, (provider, history) => startChatDirect(history, tools, voice, provider));
}

export const localReplyStream = (messages, tools, voice) => startChatDirect(messages, tools, voice, 'ollama');

async function startChatDirect(messages, tools, voice = false, provider = config.brain) {
  messages = editedMessages('conversation', messages);
  if (provider === 'chatgpt') return voice ? chatGPTFast(messages, tools) : streamChatGPT(messages, { model: config.chatgpt.model, tools });
  if (provider === 'openrouter') return openRouterChat(messages, tools, voice);
  if (provider === 'mistral') return mistralChat(messages, tools);
  const localMessages = messages.map(({ _responsesOutput, ...message }) => ({ ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments } })) } : {}) }));
  const request = {
    model: config.ollama.model,
    messages: localMessages,
    stream: true,
    think: config.ollama.think,
    keep_alive: KEEP_ALIVE,
    // Capped so a model stuck in a loop can't hold her reply (and her voice) open indefinitely.
    options: { num_ctx: config.ollama.numCtx, num_predict: 2048 },
    ...(config.conflicts?.enabled && { logprobs: true, top_logprobs: config.conflicts.top }), // where he was torn (conflicts.js)
  };
  if (!tools) return localRequest(request);
  try {
    return await localRequest({ ...request, tools });
  } catch (err) {
    // Models without tool support: just answer without tools.
    if (/does not support tools/i.test(err.message)) return localRequest(request);
    throw err;
  }
}

// Voice on ChatGPT: the fast model, low effort. If that model isn't on this account (or is
// retired), the main model answers instead, so a missing fast model never breaks voice.
const isModelError = (err) => /model/i.test(err?.message || '') && [400, 403, 404].includes(Number(err?.status) || 400);
async function* chatGPTFast(messages, tools) {
  const fast = config.chatgpt.fastModel || config.chatgpt.model;
  let started = false;
  try {
    for await (const part of streamChatGPT(messages, { model: fast, tools, effort: 'low' })) { started = true; yield part; }
  } catch (err) {
    if (started || fast === config.chatgpt.model || !isModelError(err)) throw err;
    yield* streamChatGPT(messages, { model: config.chatgpt.model, tools, effort: 'low' });
  }
}

// The other branch of a close call (conflicts.js): the conversation he was answering, his reply up to the fork with
// the runner-up word in place, and the same brain carrying on from there (assistant prefill). Tool turns are left out
// of the context: this only writes words, it never runs anything.
export async function continueFrom(messages, prefix, { provider = config.brain, model, maxTokens = 220 } = {}) {
  const context = messages.filter((m) => ['system', 'user', 'assistant'].includes(m.role) && !m.tool_calls && typeof m.content === 'string')
    .map(({ role, content }) => ({ role, content }));
  const strip = (out) => { const s = String(out ?? ''); return s.startsWith(prefix) ? s.slice(prefix.length) : s; };
  if (provider === 'openrouter') {
    if (!config.openrouter.apiKey) throw new Error('Branching needs OpenRouter, but OPENROUTER_API_KEY is empty in .env.');
    const use = model || config.openrouter.model;
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST', headers: openRouterHeaders(), signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({ model: use, messages: [...context, { role: 'assistant', content: prefix }], max_tokens: maxTokens, reasoning: { enabled: false }, usage: { include: true } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw providerRequestError(data, 'openrouter', res.status);
    if (data.usage) noteSpend('conflict branch', use, data.usage);
    return strip(data.choices?.[0]?.message?.content);
  }
  if (provider === 'ollama' || !provider) {
    const out = await localClient().chat({ model: model || config.ollama.model, messages: [...context, { role: 'assistant', content: prefix }], stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: config.ollama.numCtx, num_predict: maxTokens } });
    return strip(out.message?.content);
  }
  throw new Error(`Branching a reply needs the brain that wrote it to continue from a given start; ${provider} can't do that here. The close calls are still on record.`);
}

// ---- OpenRouter: OpenAI-style chat completions, streamed as server-sent events ----

const OPENROUTER = 'https://openrouter.ai/api/v1';
export const openRouterHeaders = () => ({
  Authorization: `Bearer ${config.openrouter.apiKey}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'http://127.0.0.1', // shows up as the app in OpenRouter's activity log
  'X-Title': config.botName,
});

// Yields the same shape as Ollama's stream ({ message: { content, tool_calls } }) so chat()
// handles both. Reasoning tokens are dropped: only the answer is spoken.
async function* openRouterChat(messages, tools, voice = false) {
  // Spoken replies use their own (default: no) reasoning: on Grok 4.20 medium reasoning alone added
  // about 10 seconds before the first word. Text and tool work keep the main setting.
  const effort = voice ? config.openrouter.voiceReasoning : config.openrouter.reasoning;
  if (!config.openrouter.apiKey) throw new Error('OpenRouter is the brain, but OPENROUTER_API_KEY is empty in .env');
  const body = {
    model: config.openrouter.model,
    stream: true,
    messages: messages.map(toOpenAI),
    ...(effort === 'none' ? { reasoning: { enabled: false } } : { reasoning: { effort, exclude: true } }),
    usage: { include: true }, // the last chunk carries its real price (spend.js)
    // The top alternatives for every word (conflicts.js): where he was torn. OpenRouter only routes to a provider that
    // reports them when told to require them (2026-11-11: without it his model's default provider sent none); if no
    // provider can serve the request that way, it's sent again without them (below), so a reply never depends on it.
    ...(config.conflicts?.enabled && { logprobs: true, top_logprobs: config.conflicts.top, provider: { require_parameters: true } }),
  };
  if (tools) body.tools = tools;
  // Nov 10: the model behind OpenRouter went silent mid-call and James sat mute for three minutes,
  // until OpenRouter gave up ("Upstream idle timeout exceeded"); OpenRouter's keep-alives kept the
  // connection looking alive the whole time. Now only real reply data counts: none for too long and
  // the request is dropped. If nothing had come yet it's sent once more, since a stall is usually
  // that one upstream request.
  const limits = { firstMs: voice ? (effort === 'none' ? STALL.firstVoiceMs : STALL.firstVoiceMs * 2) : STALL.firstMs, gapMs: STALL.gapMs };
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const part of watchedOpenAIStream(`${OPENROUTER}/chat/completions`, openRouterHeaders(), body, 'openrouter', limits)) {
        if (part.usage) noteSpend(voice ? 'voice reply' : 'reply', config.openrouter.model, part.usage);
        yielded = true; yield part;
      }
      return;
    } catch (err) {
      // Asking for word odds narrowed the providers to none that could take this request: the reply goes again
      // without them. Nothing is lost but this reply's close calls.
      if (body.logprobs && !yielded && !err.stalled) {
        activity('error', { where: 'conflicts', message: `No provider for ${config.openrouter.model} could send this reply with its word odds (${err.message}), so it was sent without them. The reply itself is unaffected; only this reply's close calls aren't recorded.` });
        delete body.logprobs; delete body.top_logprobs; delete body.provider;
        continue;
      }
      if (!err.stalled || yielded || attempt >= 2) throw err;
      activity('slow', { where: 'reply', model: config.openrouter.model, stalled: true, retry: true, message: err.message });
    }
  }
}

// How long a reply may go without real data before it's dropped: before the first piece (voice, with
// no reasoning, should start within seconds; text and tool turns may reason first) and between pieces.
export const STALL = { firstVoiceMs: 20_000, firstMs: 120_000, gapMs: 30_000 };

// A streamed request with its own clock. Keep-alive comments don't reset it; reply data does.
async function* watchedOpenAIStream(url, headers, body, provider, { firstMs, gapMs }) {
  const ctrl = new AbortController();
  let timer;
  let stalled = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = ms; ctrl.abort(); }, ms);
    timer.unref?.();
  };
  const stallError = () => Object.assign(new Error(`${provider === 'openrouter' ? 'OpenRouter' : provider} (${body.model}) went silent: no reply came for ${Math.round(stalled / 1000)} seconds, so the request was dropped. That's the model's server stalling, not anything in the conversation. If it keeps happening, switch to another reply model (the openrouterModel setting).`), { stalled: true });
  arm(firstMs);
  try {
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal }); }
    catch (err) { if (stalled) throw stallError(); throw err; }
    if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), provider, res.status);
    try {
      for await (const part of readOpenAIStream(res, provider, () => arm(gapMs))) yield part;
    } catch (err) { if (stalled) throw stallError(); throw err; }
  } finally { clearTimeout(timer); }
}

// ---- Mistral: the same OpenAI-style API, on Mistral's own cloud ----

const MISTRAL = 'https://api.mistral.ai/v1';
const mistralHeaders = () => ({ Authorization: `Bearer ${config.mistral.apiKey}`, 'Content-Type': 'application/json' });
// Mistral only accepts tool call ids of exactly 9 letters/digits, so ids from other providers (or
// none) are mapped to a stable 9-character one. A call and its result map the same way, so they still pair.
const mistralId = (id) => {
  const raw = String(id ?? '');
  if (/^[a-zA-Z0-9]{9}$/.test(raw)) return raw;
  let h = 5381;
  for (const ch of raw) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return (h.toString(36) + 'mistral00').slice(0, 9);
};
const toMistral = (m) => {
  const o = toOpenAI(m);
  if (o.role === 'tool') return { ...o, tool_call_id: mistralId(o.tool_call_id) };
  if (o.tool_calls) return { ...o, content: o.content ?? '', tool_calls: o.tool_calls.map((c) => ({ ...c, id: mistralId(c.id) })) };
  return o;
};

async function* mistralChat(messages, tools) {
  if (!config.mistral.apiKey) throw new Error('Mistral is the brain, but MISTRAL_API_KEY is empty in .env');
  const body = { model: config.mistral.model, stream: true, messages: messages.map(toMistral), ...(tools && { tools }) };
  const res = await fetch(`${MISTRAL}/chat/completions`, { method: 'POST', headers: mistralHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'mistral', res.status);
  yield* readOpenAIStream(res, 'mistral');
}

// Server-sent chat completion chunks, yielded in Ollama's shape ({ message: { content, tool_calls } }).
async function* readOpenAIStream(res, provider, onData = () => {}) {
  const calls = []; // tool calls arrive in pieces, keyed by index
  const dec = new TextDecoder();
  let buf = '';
  for await (const bytes of res.body) {
    buf += dec.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // blank lines and ": OPENROUTER PROCESSING" keep-alives
      onData(); // real reply data: the stall clock starts over
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw providerRequestError(chunk, provider);
      const delta = chunk.choices?.[0]?.delta ?? {};
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
      // The word odds for this piece, when asked for (conflicts.js): what else the model nearly said.
      const odds = chunk.choices?.[0]?.logprobs?.content;
      if (delta.content) yield { message: { content: delta.content }, ...(odds?.length && { logprobs: odds }) };
      // OpenRouter includes usage on the final chunk (choices is empty there).
      if (chunk.usage) yield { message: { content: '' }, usage: chunk.usage };
    }
  }
  if (calls.length) yield { message: { content: '', tool_calls: calls.filter(Boolean) } };
}

// Ollama-style history to OpenAI style: tool calls need ids and string arguments.
function toOpenAI(m) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id ?? m.tool_name, content: m.content };
  // Pictures someone sent: Ollama takes raw base64 in `images`; OpenAI style wants content parts.
  if (m.images?.length) {
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content }, ...m.images.map((b64, i) => ({ type: 'image_url', image_url: { url: `data:${m.imageTypes?.[i] ?? 'image/png'};base64,${b64}` } }))],
    };
  }
  if (!m.tool_calls) return { role: m.role, content: m.content };
  return {
    role: 'assistant',
    content: m.content || null,
    tool_calls: m.tool_calls.map((c) => ({
      id: c.id ?? c.function.name,
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) },
    })),
  };
}

async function mistralJson(messages, maxTokens) {
  if (!config.mistral.apiKey) throw new Error('Mistral is the brain, but MISTRAL_API_KEY is empty in .env');
  const res = await fetch(`${MISTRAL}/chat/completions`, {
    method: 'POST',
    headers: mistralHeaders(),
    body: JSON.stringify({ model: config.mistral.model, messages: messages.map(toMistral), response_format: { type: 'json_object' }, temperature: 0, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'mistral', res.status);
  const text = (await res.json()).choices?.[0]?.message?.content ?? '';
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; }
}

// Whether her current brain can look at pictures itself (else describeImages() looks for her).
let visionCache = { key: '', can: false };
export async function canSee() {
  const { activeReplyProvider } = await import('./provider-router.js');
  const provider = activeReplyProvider();
  if (provider === 'chatgpt') {
    const model = (await chatgptAuth.models()).find((m) => m.id === config.chatgpt.model);
    // Explicitly false means route to the existing vision fallback; absent capability is unknown.
    return model?.vision !== false;
  }
  // Mistral: the vision fallback describes pictures for her (not every Mistral model takes images).
  if (provider === 'mistral') return false;
  const key = provider === 'openrouter' ? `or:${config.openrouter.model}` : `ol:${config.ollama.host}:${config.ollama.model}`;
  if (visionCache.key === key) return visionCache.can;
  let can = false;
  try {
    if (provider === 'openrouter') {
      const res = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
      const { data } = await res.json();
      can = data.find((m) => m.id === config.openrouter.model)?.architecture?.input_modalities?.includes('image') ?? false;
    } else {
      can = (await localClient().show({ model: config.ollama.model })).capabilities?.includes('vision') ?? false;
    }
  } catch {
    return false; // couldn't check: describe them, and ask again next time
  }
  visionCache = { key, can };
  return can;
}

// For a brain that can't see: a vision model on OpenRouter describes the pictures in detail, and
// she gets the description as text.
export async function describeImages(images, question) {
  if (!config.openrouter.apiKey) throw new Error("this brain can't see images and there's no OpenRouter key for a vision model");
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: config.openrouter.visionModel,
      messages: [toOpenAI({
        role: 'user',
        content: promptText('vision', `Describe ${images.length > 1 ? 'each of these images' : 'this image'} thoroughly for someone who can't see it: what's in it, any people and what they're doing, the setting, colors and mood, and every bit of text exactly as written (signs, screenshots, documents, code, captions). If it's a screenshot of an app, chat, error or code, transcribe it. The person who sent it said: "${question || '(nothing)'}"`),
        images: images.map((i) => i.base64),
        imageTypes: images.map((i) => i.mime),
      })],
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`vision model (${config.openrouter.visionModel}) failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  noteSpend('seeing images', config.openrouter.visionModel, data.usage);
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// OpenRouter's catalogue, for the dashboard's model pickers.
export async function openRouterModels() {
  const res = await fetch(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter model list failed (${res.status})`);
  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.supported_parameters?.includes('reasoning') ?? false,
    tools: m.supported_parameters?.includes('tools') ?? false,
    image: m.architecture?.output_modalities?.includes('image') ?? false,
    price: Number(m.pricing?.prompt) * 1e6, // dollars per million input tokens
    outPrice: Number(m.pricing?.completion) * 1e6,
    context: m.context_length ?? 0,
    created: m.created ?? 0,
  }));
}

// The strongest families for each kind of work, best first. OpenRouter doesn't rate models, so this
// is the judgment; within a family the newest model wins. Only models that can use tools qualify.
const FAMILIES = {
  coding: [/anthropic\/claude-opus/, /anthropic\/claude-sonnet/, /openai\/gpt-[\d.]+-?(sol|codex)?(-pro)?$/, /google\/gemini-[\d.]+-(argon|pro)/, /moonshotai\/kimi/, /deepseek\/deepseek/, /qwen\/qwen[\d.]*-coder/, /z-ai\/glm/, /mistralai\/(devstral|codestral)/, /minimax\/minimax/],
  reasoning: [/openai\/gpt-[\d.]+-?(sol)?-pro/, /anthropic\/claude-opus/, /google\/gemini-[\d.]+-(pro|argon)/, /openai\/gpt-[\d.]+/, /deepseek\/deepseek/, /moonshotai\/kimi/, /qwen\/qwen/, /x-ai\/grok/],
  general: [/anthropic\/claude-(sonnet|opus)/, /openai\/gpt-[\d.]+/, /google\/gemini-[\d.]+-(pro|flash)/, /deepseek\/deepseek/, /moonshotai\/kimi/, /meta\/muse/, /mistralai\/mistral-large/],
  cheap: [/deepseek\/deepseek.*flash/, /google\/gemini-[\d.]+-flash/, /anthropic\/claude-haiku/, /minimax\/minimax.*flash/, /qwen\/qwen/, /mistralai\/mistral/, /inception\/mercury/],
};

// Up to `count` models for a purpose, best first, one per family (its newest).
export async function rankModels(purpose = 'coding', count = 5) {
  const families = FAMILIES[purpose] ?? FAMILIES.general;
  // Skip aliases ("~…-latest"), previews, dated snapshots, and free/batch variants.
  const usable = (await openRouterModels()).filter(
    (m) => m.tools && !m.image && !/^~|preview|customtools|:(free|batch|beta)$|-\d{4}$/.test(m.id) && m.price >= 0 && (purpose !== 'cheap' || m.price <= 0.5),
  );
  const picks = [];
  for (const family of families) {
    const best = usable.filter((m) => family.test(m.id) && !picks.includes(m)).sort((a, b) => b.created - a.created)[0];
    if (best) picks.push(best);
    if (picks.length >= count) break;
  }
  return picks;
}

// Music with Google's Lyria 3: a 30-second clip or a full-length song, as MP3 bytes. OpenRouter
// only returns audio when streamed; it arrives as base64 pieces in delta.audio.data.
export async function generateMusic(prompt, length = 'clip') {
  prompt = promptText('music', prompt);
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is empty in .env');
  const model = length === 'full' ? config.openrouter.songModel : config.openrouter.clipModel;
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model, stream: true, modalities: ['text', 'audio'], audio: { format: 'mp3' }, messages: [{ role: 'user', content: prompt }], usage: { include: true } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Music generation (${model}) failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder();
  let buf = '', audio = '', text = '';
  for await (const bytes of res.body) {
    buf += dec.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
      const chunk = JSON.parse(line.slice(5));
      if (chunk.error) throw new Error(`Music generation: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.usage) noteSpend('making music', model, chunk.usage);
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.audio?.data) audio += delta.audio.data;
      if (delta.content) text += delta.content;
    }
  }
  if (!audio) throw new Error(`${model} returned no audio${text ? `: ${text.slice(0, 200)}` : ''}`);
  // Lyria times its lyrics ("[12.5:] line"); the timestamps aren't for reading.
  return { bytes: Buffer.from(audio, 'base64'), lyrics: text.replace(/\[\d+(\.\d+)?:?\]\s*/g, '').trim() };
}

// One-shot image generation. Returns PNG/JPEG bytes and any text the model added.
// references = [{ mime, bytes }] (or a data URL in `url`): identity images the model must keep,
// used for her reference sheet so new outfits keep the same face and body. The Image API takes
// them as input_references; older/custom image models fall back to chat completions.
export async function generateImage(prompt, references = []) {
  prompt = promptText('image', prompt);
  if (config.imageProvider === 'flux') return generateFluxImage(prompt, references);
  if (config.imageProvider === 'kontext') return generateKontextImage(prompt, references);
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is empty in .env');
  const refs = (Array.isArray(references) ? references : [references])
    .filter(Boolean)
    .map((r) => ({
      type: 'image_url',
      image_url: {
        url: r.url ?? `data:${r.mime || 'image/png'};base64,${r.base64 ?? Buffer.from(r.bytes).toString('base64')}`,
      },
    }));
  const res = await fetch(`${OPENROUTER}/images`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouter.imageModel,
      prompt,
      n: 1,
      ...(refs.length ? { input_references: refs } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.ok) {
    const data = await res.json();
    noteSpend('making a picture', config.openrouter.imageModel, data.usage);
    const item = data.data?.[0] ?? {};
    const fromUrl = item.url?.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
    const base64 = item.b64_json ?? fromUrl?.[2];
    if (!base64) {
      throw new Error(
        `${config.openrouter.imageModel} returned no image${data.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : ''}`,
      );
    }
    return { mime: item.media_type || fromUrl?.[1] || 'image/png', bytes: Buffer.from(base64, 'base64'), text: item.revised_prompt || '' };
  }
  const firstError = await res.text().catch(() => '');
  // A custom image model may only implement the chat-completions route.
  if (![400, 404, 405, 422].includes(res.status)) {
    throw new Error(`Image generation (${config.openrouter.imageModel}) failed (${res.status}): ${firstError.slice(0, 300)}`);
  }
  return generateImageChat(prompt, refs, firstError);
}

async function generateImageChat(prompt, refs, firstError) {
  const content = refs.length ? [{ type: 'text', text: prompt }, ...refs] : prompt;
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: config.openrouter.imageModel,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }],
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')) || firstError;
    throw new Error(`Image generation (${config.openrouter.imageModel}) failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  noteSpend('making a picture', config.openrouter.imageModel, data.usage);
  const message = data.choices?.[0]?.message ?? {};
  const url = message.images?.[0]?.image_url?.url;
  const m = url?.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) throw new Error(`${config.openrouter.imageModel} returned no image${message.content ? `: ${String(message.content).slice(0, 200)}` : ''}`);
  return { mime: m[1], bytes: Buffer.from(m[2], 'base64'), text: message.content || '' };
}

// Background workers always use the selected local model, with no cloud fallback.
// One helper step on a cloud model through OpenRouter, in the same shape as agentStep: for work the owner asked for
// when the local model chokes on it (owner, 2026-11-11: "That local model isn't able to complete project work. We
// have to use a different local model or switch to a cloud model when the local fails").
export async function cloudAgentStep(messages, tools, { model = config.workshop.coderModel, purpose = 'helper' } = {}) {
  const result = await cloudThink({ messages, tools, options: {} }, purpose, { model, timeoutMs: 180_000 });
  return { content: result.message?.content ?? '', tool_calls: (result.message?.tool_calls ?? []).map((call, i) => ({
    ...call, id: call.id || `cloud-${Date.now()}-${i}`,
    function: { ...call.function, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
  })) };
}

export async function agentStep(messages, tools, { model = config.ollama.model, coding = false } = {}) {
  const localMessages = messages.map((message) => ({ ...message,
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call,
      function: { ...call.function, arguments: typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments || '{}') : call.function.arguments } })) } : {}) }));
  const result = await localRequest({ model, messages: localMessages,
    tools, think: false, keep_alive: KEEP_ALIVE, options: { num_ctx: coding ? config.ollama.codingNumCtx : config.ollama.numCtx } }, 'helper');
  return { content: result.message?.content ?? '', tool_calls: (coding ? codingToolCalls(result.message,tools) : (result.message?.tool_calls ?? [])).map((call, i) => ({
    ...call, id: call.id || `local-${Date.now()}-${i}`,
    function: { ...call.function, arguments: typeof call.function.arguments === 'string'
      ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
  })) };
}

// A fast JSON answer from whichever brain is on (no reasoning), for planning each reply.
export async function quickJson(messages) {
  const { providerRouter } = await import('./provider-router.js');
  return providerRouter.execute((provider) => quickJsonDirect(messages, provider));
}

async function quickJsonDirect(messages, provider, purpose = 'reply_planning', maxTokens) {
  if (provider !== 'ollama') messages = editedMessages(purpose, messages);
  if (provider === 'chatgpt') {
    const fast = config.chatgpt.fastModel;
    if (!fast || fast === config.chatgpt.model) return chatGPTJson(messages, config.chatgpt.model);
    return chatGPTJson(messages, fast).catch((err) => (isModelError(err) ? chatGPTJson(messages, config.chatgpt.model) : Promise.reject(err)));
  }
  if (provider === 'mistral') return mistralJson(messages, maxTokens);
  if (provider !== 'openrouter') return json(messages, { purpose: 'reply_planning' });
  if (!config.openrouter.apiKey) throw new Error('OpenRouter is the brain, but OPENROUTER_API_KEY is empty in .env');
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model: config.openrouter.model, messages, response_format: { type: 'json_object' }, reasoning: { enabled: false }, temperature: 0, usage: { include: true }, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw providerRequestError(await res.json().catch(() => ({})), 'openrouter', res.status);
  const data = await res.json();
  if (data.error) throw providerRequestError(data, 'openrouter');
  noteSpend(purpose.replace(/_/g, ' '), config.openrouter.model, data.usage);
  const text = data.choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

// The only intentionally cloud-based background reflection: explicit private self-dialogue.
export function reflectionCloud() {
  const configured = (provider) => provider === 'openrouter' ? Boolean(config.openrouter.apiKey && config.openrouter.model)
    : provider === 'mistral' ? Boolean(config.mistral.apiKey && config.mistral.model)
    : provider === 'chatgpt' ? Boolean(chatgptAuth.status().account?.planEnabled && config.chatgpt.model) : false;
  const preferred = config.selfDialogueProvider === 'auto' ? config.brain : config.selfDialogueProvider;
  if (configured(preferred)) return preferred;
  if (config.selfDialogueProvider !== 'auto') throw new Error('The chosen self-dialogue cloud provider is not configured.');
  const available = ['openrouter', 'chatgpt', 'mistral'].find(configured);
  if (!available) throw new Error('Self-dialogue needs a configured cloud provider. Ordinary background work remains local.');
  return available;
}
export async function cloudReflection(messages, provider = reflectionCloud(), maxTokens = 640) {
  if (provider === 'chatgpt') return chatGPTJson(editedMessages('self_dialogue_cloud', messages), config.chatgpt.model, undefined, { maxOutputTokens: maxTokens });
  if (!['openrouter', 'mistral'].includes(provider)) throw new Error('Self-dialogue requires a cloud provider.');
  return quickJsonDirect(messages, provider, 'self_dialogue_cloud', maxTokens);
}

// One-shot JSON completion on local Ollama, used for background memory extraction.
export async function json(messages, { purpose = 'background_json', maxTokens, repeatPenalty } = {}) {
  const ask = (penalty, temperature) => localRequest({
    model: config.ollama.model,
    messages,
    format: 'json',
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: config.ollama.numCtx, ...(maxTokens ? { num_predict: maxTokens } : {}),
      ...(penalty ? { repeat_penalty: penalty } : {}), ...(temperature ? { temperature } : {}) }, // retain the selected context window
  }, purpose);
  let res;
  try { res = await ask(repeatPenalty); }
  catch (err) {
    // Ollama cuts an answer off when the model gets stuck repeating itself (a JSON list or whitespace looping).
    // That's a stuck sample, not a wrong question: one more go, pushed harder off repeats and a little looser.
    if (!/repeat limit/i.test(err?.message ?? '')) throw err;
    res = await ask(Math.max(1.25, (repeatPenalty ?? 1.1) + 0.15), 0.9);
  }
  try {
    return JSON.parse(res.message.content);
  } catch {
    return null;
  }
}

// Plain local completion, never OpenRouter and never with tools. Solo thoughts use this so they
// stay free and private even when config.brain is 'openrouter'. Pass { format: 'json' } for a
// constrained JSON answer.
export async function localChat(messages, { format, purpose = 'background_text' } = {}) {
  const res = await localRequest({
    model: config.ollama.model,
    messages,
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: config.ollama.numCtx },
    ...(format ? { format } : {}),
  }, purpose);
  return res.message?.content ?? '';
}

export async function embed(texts) {
  // A stuck embedding must never silence her: recall waits on this before every reply. At the limit the
  // request itself is cancelled, not just given up on: an abandoned request stays queued in Ollama, and
  // enough of them fill its queue ("maximum pending requests exceeded") so nothing gets through.
  const signal = AbortSignal.timeout(EMBED_LIMIT_MS);
  const client = new Ollama({ host: config.ollama.host, fetch: (url, init) => globalThis.fetch(url, { ...init, signal }) });
  try {
    const res = await client.embed({ model: config.ollama.embedModel, input: texts, keep_alive: KEEP_ALIVE, options: { num_gpu: 0 } });
    return res.embeddings;
  } catch (err) {
    if (!signal.aborted) throw err;
    throw new Error(`embedding timed out: ${config.ollama.embedModel} gave no answer within ${EMBED_LIMIT_MS / 1000}s, so the request was cancelled. Ollama is clogged or the model was pushed out of memory. Fix: check that \`ollama ps\` lists ${config.ollama.embedModel}; if embeddings keep timing out, restart Ollama.`);
  }
}

export async function listModels() {
  const { models } = await localClient().list();
  return models.map((m) => ({ name: m.name, size: m.size, family: m.details?.family, capabilities: m.capabilities ?? [] }));
}

export async function checkOllama() {
  const { models } = await localClient().list();
  const names = new Set(models.map((m) => m.name));
  const has = (n) => names.has(n) || names.has(`${n}:latest`);
  for (const m of [config.ollama.model, config.ollama.embedModel]) {
    if (!has(m)) throw new Error(`Ollama model "${m}" not found. Run: ollama pull ${m}`);
  }
}

// Index just past the first sentence terminator followed by whitespace, or -1.
// Requires a few characters so "Mr." or "1." at the very start don't split.
function findSentenceEnd(text, early = false) {
  const re = /[.!?…]+["')\]]*\s|\n+/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index >= 12 || m[0].startsWith('\n')) return m.index + m[0].length;
  }
  if (early) {
    const pause = /[,;:—–]\s/g;
    while ((m = pause.exec(text))) if (m.index >= 20) return m.index + m[0].length;
  }
  return -1;
}
