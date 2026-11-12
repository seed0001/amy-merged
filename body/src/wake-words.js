import { ownerDisplayName } from './owner-name.js';
import { config, wordList } from './config.js';
import { calledByName } from './peers.js';

// Her wake words, in two lists:
//   everyone  words anyone can say to get her attention in voice
//   owner     words that only work when her owner says them; anyone else saying one is just talk (it
//             can come up in ordinary sentences, so it never upsets her)
// Her own name always works, for anyone. A line calls her when it has her name or a wake word that
// counts for whoever said it; with both lists empty her name is the only thing that calls her. Lines
// that don't call her are the free talk switch's business (voice/addressed.js), never the lists'.
// Each word matches as a whole word or phrase ("amy" never fires on "amity"; "hey boss" works).

export const MAX_WORDS = 10;

// A list from the dashboard or her tool: comma or new-line separated text, or an array (config.js).
export const parseWords = wordList;

export const wakeWords = () => config.voice.wakeWords ?? [];
export const ownerWakeWords = () => config.voice.ownerWakeWords ?? [];
// Whether any wake words are set (otherwise only her name calls her in voice).
export const gated = () => wakeWords().length > 0 || ownerWakeWords().length > 0;

// Did this line call her, for this speaker? Her name, an everyone word, or (only from her owner) an owner word.
export function wakeHeard(text, { owner = false } = {}) {
  return calledByName(String(text ?? ''), { names: [config.botName, ...wakeWords(), ...(owner ? ownerWakeWords() : [])] });
}

// Freshly reset and wake words not set up yet: onboarding.js registers its check here (it can't be imported
// from this file without a load cycle through tools.js).
let setupOpen = () => false;
export const onWakeSetupCheck = (fn) => { setupOpen = fn; };

// What she knows about it (her switches): both lists, and that the owner's are only his.
export function wakeLine() {
  if (!gated() && setupOpen()) return `no wake words are set yet, because you were just reset: until they're set up with you (the wake_words setup step), you answer every line anyone says in voice`;
  if (!gated()) return `no wake words are set, so in voice only your name calls you (free talk decides whether you answer the rest)`;
  const all = wakeWords().length ? `"${wakeWords().join('", "')}"` : 'none';
  const mine = ownerWakeWords().length ? `"${ownerWakeWords().join('", "')}"` : 'none';
  return `wake words for everyone: ${all}; ${ownerDisplayName()}'s own wake words (they only work when he says them): ${mine}; your name always works`;
}

// For a newcomer: what they can say (never the owner's private words).
export const wakeHint = () => (wakeWords().length ? ` They can talk to you by saying "${wakeWords()[0]}" or your name.` : '');
