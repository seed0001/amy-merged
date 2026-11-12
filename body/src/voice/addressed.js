import { config } from '../config.js';
import { wakeHeard, wakeWords, ownerWakeWords } from '../wake-words.js';

// Whether a line heard in the voice call is hers to answer (voice/session.js).
//
// Two things decide it, and only two:
//   named     the line called her: a person said her name or a wake word that counts for them
//             (wake-words.js), or another companion said her name. Having no wake words set never
//             makes every line hers: then her name is simply the only thing that calls her.
//   free talk the owner's switch (free_talk tool, dashboard). ON: a line nobody was named in is hers
//             when the floor is hers (voice/floor.js). OFF: a line nobody named her in is only heard.
// Before this, "no wake words set" answered every line on its own, so turning free talk off did
// nothing while the lists were empty: she kept answering, and said she wouldn't.

// Was this line said to her?
export function saidToMe(text, { peer = false, peerNamedMe = false, owner = false } = {}) {
  if (peer) return Boolean(peerNamedMe);
  return wakeHeard(text, { owner });
}

// A name-only follow-up can attach to an in-flight overheard request. A new instruction gets its own turn.
export function wakeFollowUp(text) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const line = ` ${normalize(text)} `;
  return [config.botName, ...wakeWords(), ...ownerWakeWords()].some((name) => {
    const phrase = ` ${normalize(name)} `;
    return line.includes(phrase) && /^(?:(?:hey|i said|okay|ok|thanks|thank you)(?: |$))*$/.test(line.replace(phrase, ' ').trim());
  });
}

// Does she answer it? peerTurn: a bot exchange turn already claimed for her (conversation-budget.js).
// floorMine: asked only when free talk is on, and only for a line that didn't name her.
// setupOpen: she's freshly reset and her wake words aren't set up yet (onboarding.js wakeSetupOpen): every
// person's line is hers, so the new user can talk to her at all while they set them up.
export async function answersLine({ peerTurn = null, named = false, freeTalk = false, setupOpen = false, floorMine = async () => false } = {}) {
  if (peerTurn || named || setupOpen) return true;
  if (!freeTalk) return false;
  return Boolean(await floorMine());
}
