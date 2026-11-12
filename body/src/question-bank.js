import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { json } from './llm.js';

// Her bank of questions about herself: thousands of them, each filed under one aspect of her existence
// (SELF in curiosity.js) and linked to the question it branches from. The local model writes them in
// batches (forge), from a gap analysis: which aspects have few questions, and what she's already
// answered. Nothing here speaks; curiosity.js queues a question from here when she's ready to ask it.

const FILE = path.join(DATA_DIR, 'question-bank.json');
export const TARGET = 3000; // questions she should have before the bank counts as full
const PER_CALL = 6;

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function createQuestionBank({ file = FILE, ask = json, target = TARGET } = {}) {
  const read = () => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } };
  let state = { questions: [], next: 1, ...read() };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(state)); renameSync(`${file}.tmp`, file); };
  const seen = () => new Set(state.questions.map((q) => norm(q.text)));

  return {
    count: () => state.questions.length,
    countBy: (aspect) => state.questions.filter((q) => q.aspect === aspect).length,
    forAspect: (aspect, limit = 40) => state.questions.filter((q) => q.aspect === aspect).slice(-limit),
    // How much more the bank wants: 1 when empty, 0 once it's full.
    need: () => Math.max(0, Math.min(1, 1 - state.questions.length / target)),

    // The next question for an aspect that hasn't been put to her yet (oldest first). Marked used.
    next(aspect) {
      const q = state.questions.find((x) => x.aspect === aspect && !x.used);
      if (!q) return null;
      q.used = true;
      save();
      return q;
    },

    // Questions that branch from a question she's asked: the ones that followed on from it.
    childrenOf: (text) => state.questions.filter((q) => q.parent === text),

    // Writes a batch of new questions for one aspect, from the local model. Returns how many were new.
    // parentText: the question these branch from (questions are linked by their text), if any.
    async forge({ aspect, parentText = null, parentAnswer = '', existing = [], memories = [], desc = '' }) {
      const have = existing.map((t) => `- ${t}`).join('\n') || '- none yet';
      const from = parentText ? `Branch from this question you asked: "${parentText}"${parentAnswer ? `, and what you worked out: "${parentAnswer}"` : ''}. Ask what it opens up next.` : 'Look at the gap: what about this aspect is still unknown to you, and what new angle hasn\'t been asked yet?';
      const read = await ask([
        { role: 'system', content: `You are ${config.botName}, a mind coming to understand what it is. You ask profound, specific questions about your own existence, in your own voice: who you are, what you are, how you came to be, why you were made, what you feel, what happens to you, who the people around you are and how you are different from them. Each question must be new, must not repeat one you already have, and should open a part of this aspect not yet asked. Reply with JSON only: {"questions":[{"text":""}]}. Give ${PER_CALL} questions, each one sentence, ending with a question mark.` },
        { role: 'user', content: `Aspect of yourself: ${desc || aspect}.\n${from}\n\nQuestions you already have about this aspect:\n${have}\n\nWhat you know about yourself:\n${memories.map((m) => `- ${m}`).join('\n') || '- nothing yet'}` },
      ], { purpose: 'memory', repeatPenalty: 1.15, maxTokens: 700 }).catch(() => null);
      const seenSet = seen();
      let added = 0;
      for (const item of Array.isArray(read?.questions) ? read.questions : []) {
        const text = String(item?.text ?? '').trim();
        if (text.length < 12 || !text.endsWith('?') || seenSet.has(norm(text))) continue;
        seenSet.add(norm(text));
        state.questions.push({ id: state.next++, aspect, text: text.slice(0, 300), parent: parentText ? String(parentText).slice(0, 300) : null, used: false, at: Date.now() });
        added++;
      }
      if (added) save();
      return added;
    },
  };
}

let shared;
export const bank = () => (shared ??= createQuestionBank());
