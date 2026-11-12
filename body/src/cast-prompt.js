// The "other avatars" section of her prompt. Other avatars are her household, not strangers, so she
// can answer questions about who else is on the stage, what they look like and what they are wearing
// without being told again each time. Kept pure so it can be tested without the live cast store.

// Words that mean the conversation is actually about the people around her (so the full description
// is worth the tokens). Name mentions are checked separately.
const LOOKS_ABOUT =
  /\b(who|everyone|everybody|cast|stage|avatars?|characters?|family|relatives?|sister|brother|grandpa|grandfather|grandma|grandmother|mom|mum|dad|mother|father|cousin|uncle|aunt|people|appearance|wearing|wear|dressed|outfits?|clothes|clothing|hair|eyes|beard)\b|look(s)? like/i;

const escape = (text) => String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function line(c, looks) {
  const parts = [];
  if (c.description) parts.push(c.description);
  else if (c.main) parts.push('the companion whose stage this is');
  let look = {};
  try {
    look = looks(c.id) || {};
  } catch {}
  const colours = ['hair', 'eyes'].filter((k) => look[k]).map((k) => `${k} ${look[k]}`);
  if (colours.length) parts.push(`currently ${colours.join(', ')}`);
  const detail = [c.role, c.solo ? 'on their own page' : ''].filter(Boolean).join(', ');
  const role = detail ? ` (${detail})` : '';
  return `${c.name}${role}${parts.length ? ': ' + parts.join('; ') : ''}`;
}

// cast: every character, including this one. selfId: who is answering.
// alwaysDetailed: this speaker is not the main bot, so their own household matters every turn.
export function castPrompt(cast, selfId, text = '', { cue = false, alwaysDetailed = false, looks = () => ({}) } = {}) {
  const self = (cast || []).find((c) => c.id === selfId);
  const others = (cast || []).filter((c) => c.id !== selfId && c.name);
  if (!others.length) return '';
  const names = others.map((c) => escape(c.name));
  const mentioned = new RegExp(`\\b(${names.join('|')})\\b`, 'i').test(text || '');
  const detailed = alwaysDetailed || (self && !self.main) || (!cue && (mentioned || LOOKS_ABOUT.test(text || '')));
  if (!detailed) {
    return `Also on the avatar stage with you: ${others
      .map((c) => `${c.name}${c.role ? ` (${c.role}${c.solo ? ', own page' : ''})` : ''}`)
      .join(', ')}.`;
  }
  const lines = others.map((c) => `- ${line(c, looks)}`);
  return (
    'The other avatars on the stage are members of your household, not strangers. You already know them, ' +
    `so use this instead of saying you do not know who they are:\n${lines.join('\n')}\n` +
    'They are the people you live with. Only the traits described here are known; do not invent others.'
  );
}
