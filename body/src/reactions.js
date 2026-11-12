import { taste, AFTER } from './taste.js';
import * as emotion from './emotion.js';
import { emotionKey } from './characters.js';
import { avatarPlay } from './avatar-cues.js';
import { bus, activity } from './events.js';
import { profiles } from './memory.js';
import { sleep } from './sleep.js';

// Every line someone says where she can hear it, to her or not, is judged by her own taste
// (taste.js), and what gets to her shows: a snicker or a belly laugh, sympathy, tears, a huff.
// Who said it (how she feels about them), her mood and whether she's heard the bit before all
// count. It runs behind everything (never in front of a reply) and is never a timer: a line said is
// what sets it off.
export function heardLine({ id = null, name = 'Someone', text, recent = [], addressed = false, character = 'main' }) {
  if (sleep.sleeping()) return Promise.resolve(null); // asleep, nothing gets to her
  const key = emotionKey(character);
  let score = 0;
  try { score = id ? profiles.affinity(id).score : 0; } catch {}
  return taste.hear({
    speaker: name, text, addressed,
    recent: Array.isArray(recent) ? recent.join('\n') : String(recent ?? ''),
    bond: Math.max(0, Math.min(1, score / 100)),
    wary: score <= -10,
    feelings: emotion.current(key) ?? {},
    play: (style, family, strength) => {
      avatarPlay([style], character);
      const next = emotion.nudge(key, AFTER[family](strength));
      bus.emit('avatar-expression', { character, feelings: next, at: Date.now() });
    },
  }).then((r) => {
    if (r?.style) activity('reaction', { speaker: name, style: r.style, family: r.family, score: +r.score.toFixed(1), why: r.why });
    return r;
  }).catch((e) => { activity('error', { where: 'taste (how a line struck her)', message: e.message }); return null; });
}
