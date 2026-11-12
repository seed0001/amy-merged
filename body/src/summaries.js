import { config } from './config.js';
import { localChat } from './llm.js';
import { unsummarizedBlock, addSummary, openParagraphs, majorSummary, rollUp } from './memory.js';
import { activity } from './events.js';

// Every `historyLimit` messages become one paragraph. Once a few paragraphs pile up (8 of them, or
// the oldest is 24 hours old) they're folded into the major summary, so the prompt carries one
// concise current picture rather than a long run of paragraphs. Absorbed paragraphs and earlier
// major summaries stay in the database (rolled_up = 1); nothing is deleted.
export const PARAGRAPHS_PER_ROLLUP = 8;
export const ROLLUP_AGE_MS = 24 * 60 * 60 * 1000;

const PARAGRAPH_TASK = (botName) =>
  `Summarize this stretch of a Discord conversation involving ${botName} in ONE paragraph (about 80-150 words). Keep who said or did what, topics discussed, decisions, plans, jokes or running bits worth recalling, and how people were feeling. Use people's names. Write in past tense, third person. Reply with the paragraph only.`;

export const ROLLUP_TASK = (botName) =>
  `You keep ${botName}'s long-term memory of a Discord conversation. Merge the earlier summary (if any) and the newer paragraphs below into ONE concise current picture, about 250-400 words, under these plain headings:
People: who they are, key facts, relationships and how they've been feeling lately.
Important memories: events and moments worth recalling, with rough dates (e.g. "on Oct 22").
Active commitments: things ${botName} or others promised or asked for that are still open.
Unresolved work: problems, fixes or projects still in progress, and their latest known state.
Carry forward everything still relevant from the earlier summary. Drop items that were clearly finished or superseded, repeated play-by-play, and passing trivia. Don't invent anything. Reply with the summary only.`;

// Whether the open paragraphs should be folded into the major summary now.
export function rollupDue(paragraphs, now = Date.now()) {
  return (
    paragraphs.length >= PARAGRAPHS_PER_ROLLUP ||
    (paragraphs.length > 1 && now - paragraphs[0].created_at >= ROLLUP_AGE_MS)
  );
}

// One consolidation at a time, in the background, never delaying a reply. When the model behind it
// is down (Ollama not answering: "fetch failed" on every message), it backs off instead of retrying on
// each line: one error that says what and why, doubling waits up to ten minutes, one line on recovery.
let chain = Promise.resolve();
let pausedUntil = 0, backoff = 30_000, outage = false;
const MAX_BACKOFF = 10 * 60_000;
export function queueConsolidation(conversation) {
  if (Date.now() < pausedUntil) return chain;
  chain = chain
    .then(() => consolidate(conversation))
    .then(() => { if (outage) { outage = false; backoff = 30_000; activity('memory consolidation', { recovered: true }); } })
    .catch((err) => {
      pausedUntil = Date.now() + backoff;
      if (!outage) {
        outage = true;
        activity('error', { where: 'memory consolidation', message: `Consolidation paused: ${err.message}. Retrying in ${Math.round(backoff / 1000)} s, then doubling up to ${MAX_BACKOFF / 60_000} min. Fix: make sure Ollama is running and reachable at the configured host; summaries catch up on their own when it answers.` });
      }
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    });
  return chain;
}

async function consolidate(conversation) {
  let block;
  while ((block = unsummarizedBlock(conversation, config.historyLimit))) {
    const paragraph = await summarize(PARAGRAPH_TASK(config.botName), transcript(block));
    if (!paragraph) return; // try again after the next message rather than skipping the block
    addSummary(conversation, { level: 1, content: paragraph, lastMessageId: block.at(-1).id });
    activity('summarized', { conversation, messages: block.length, text: paragraph });
  }

  const paragraphs = openParagraphs(conversation);
  if (!rollupDue(paragraphs)) return;

  const previous = majorSummary(conversation);
  const input =
    (previous ? `Earlier summary:\n${previous.content}\n\n` : '') +
    `Newer paragraphs (oldest first):\n` +
    paragraphs.map((p) => `[${stamp(p.created_at)}] ${p.content}`).join('\n\n');
  const summary = await summarize(ROLLUP_TASK(config.botName), input);
  if (!summary) return;
  rollUp(conversation, summary, paragraphs.at(-1).id);
  activity('summarized', { conversation, paragraphs: paragraphs.length, major: true, text: summary });
}

async function summarize(task, input) {
  const text = await localChat([
    { role: 'system', content: task },
    { role: 'user', content: input },
  ], { purpose: 'summary' });
  return text.trim();
}

function transcript(messages) {
  return messages
    .map((m) => `[${stamp(m.created_at)}] ${m.role === 'assistant' ? m.name ?? config.botName : m.name ?? 'Someone'}: ${m.content}`)
    .join('\n');
}

function stamp(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The summaries to put in the system prompt: the major summary, then the paragraphs since.
export function summaryInfo(conversation) {
  const major = majorSummary(conversation);
  const paragraphs = openParagraphs(conversation);
  const text = !major && !paragraphs.length
    ? ''
    : [
        `What happened earlier in this conversation (your own memory of it; use naturally, don't recite):`,
        major && `Long-term summary: ${major.content}`,
        ...paragraphs.map((p) => `[${stamp(p.created_at)}] ${p.content}`),
      ]
        .filter(Boolean)
        .join('\n\n');
  return { text, major, paragraphs };
}

export function summaryContext(conversation) {
  return summaryInfo(conversation).text;
}
