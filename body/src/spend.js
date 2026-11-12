// What she costs, in real dollars (owner, 2026-11-11: "I need to know how much it's costing me to run them").
// Every paid OpenRouter answer carries its price in usage.cost; each one is written to data/spend.jsonl with
// what it was for and which model answered. The spending tool and the dashboard read the totals back.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { activity } from './events.js';

export const SPEND_FILE = () => path.join(DATA_DIR, 'spend.jsonl');

// One paid answer. usage is OpenRouter's usage object ({ cost, prompt_tokens, completion_tokens });
// an answer with no cost on it (a free model, or a provider that doesn't report one) records nothing.
export function noteSpend(purpose, model, usage) {
  const cost = Number(usage?.cost);
  if (!Number.isFinite(cost) || cost <= 0) return;
  const row = { at: Date.now(), purpose: String(purpose || 'other'), model: String(model || 'unknown'), cost,
    prompt: usage.prompt_tokens ?? null, completion: usage.completion_tokens ?? null };
  try { appendFileSync(SPEND_FILE(), `${JSON.stringify(row)}\n`); }
  catch (err) { activity('error', { where: 'spend log', message: `Couldn't record a $${cost.toFixed(4)} ${purpose} call in ${SPEND_FILE()}: ${err.message}. The spending totals will be short by that much.` }); }
}

function rows() {
  if (!existsSync(SPEND_FILE())) return [];
  return readFileSync(SPEND_FILE(), 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
}

const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sum = (list) => list.reduce((n, r) => n + r.cost, 0);
const group = (list, key) => Object.entries(list.reduce((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + r.cost), m), {}))
  .sort((a, b) => b[1] - a[1]).map(([name, cost]) => ({ name, cost }));

// Totals for today (local time), the last 7 and 30 days and all time, plus where the last 7 days went.
export function spendSummary(now = Date.now()) {
  const all = rows();
  const since = (t) => all.filter((r) => r.at >= t);
  const week = since(now - 7 * 86_400_000);
  const first = all[0]?.at ?? null;
  return {
    today: sum(since(startOfDay(now))), week: sum(week), month: sum(since(now - 30 * 86_400_000)), total: sum(all),
    calls: all.length, since: first,
    perDay: first ? sum(all) / Math.max(1, (now - first) / 86_400_000) : 0,
    byPurpose: group(week, 'purpose'), byModel: group(week, 'model'),
  };
}

const usd = (n) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

// The summary in words, for the spending tool.
export function spendText(now = Date.now()) {
  const s = spendSummary(now);
  if (!s.calls) return "No spending recorded yet: cost logging started with this version, and nothing paid has run since.";
  const top = (list) => list.slice(0, 5).map((x) => `${x.name} ${usd(x.cost)}`).join(', ');
  return `What you've cost on OpenRouter, in real dollars, since ${new Date(s.since).toLocaleString()}: today ${usd(s.today)}, last 7 days ${usd(s.week)}, last 30 days ${usd(s.month)}, all recorded ${usd(s.total)} over ${s.calls} calls (about ${usd(s.perDay)} a day). `
    + `Last 7 days by what it was for: ${top(s.byPurpose) || 'nothing'}. By model: ${top(s.byModel) || 'nothing'}. `
    + 'This is only your own OpenRouter use; Fish (voice), Groq (hearing) and web search bill separately.';
}
