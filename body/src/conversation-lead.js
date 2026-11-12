import { ownerDisplayName } from './owner-name.js';
import { replyInFlight } from './busy.js';
import { current } from './emotion.js';
import { activity } from './events.js';

const pending = new Map();
const minutes = Number(process.env.CHAMP_FOLLOWUP_MINUTES);
const delay = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 5 * 60_000;
const checkIn = 15_000;

export const tired = (conversation) => (current(conversation).tired ?? 0) >= 0.45;

export function clearLead(conversation) {
  clearTimeout(pending.get(conversation)?.timer);
  pending.delete(conversation);
}

export function waitForAnswer(conversation, reply, { ready, followUp }) {
  clearLead(conversation);
  if (!reply?.includes('?') || tired(conversation)) return;
  const wait = { timer: null };
  const valid = () => pending.get(conversation) === wait && !tired(conversation);
  const tick = async () => {
    if (!valid()) return clearLead(conversation);
    const state = ready();
    if (state === 'closed') return clearLead(conversation);
    if (state === 'busy' || replyInFlight()) {
      wait.timer = setTimeout(tick, checkIn).unref();
      return;
    }
    try {
      await followUp(valid);
    } catch (error) {
      activity('error', { where: 'conversation follow-up', message: error.message });
    } finally {
      if (pending.get(conversation) === wait) clearLead(conversation);
    }
  };
  pending.set(conversation, wait);
  wait.timer = setTimeout(tick, delay).unref();
}

// Text chats only (voice follow-ups are pressure-driven: the nudge want in pressure.js, from
// open-question.js). Named question, so she never picks up a different thread than the one she left.
export const followUpCue = (question) => `${ownerDisplayName()} has not answered your question${question ? ` "${question}"` : ''}. One short, light line: ask it once more or let it go with a word. Don't answer it yourself, don't say what you think about it as if he'd asked you, and don't act as if he answered. If your question was an offer to do something for him, drop it instead of asking again.`;
