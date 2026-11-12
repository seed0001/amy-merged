// Nov 11: Owner said "I would look into that, James, ... make them really" and James answered the half
// sentence on the spot; friend_16: "I stop talking to think, give me time, I'm going to continue in a couple
// of seconds." A line that trails off (a filler, a dangling "and", "the", "really", "or...") isn't a
// finished turn: she gives the speaker a thinking pause before answering, and if they go on, the two
// pieces are answered as one line (session.js holdForMore).

const DANGLING = new Set([
  'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'like', 'and', 'but', 'or', 'so', 'because', 'cause', 'cuz',
  'the', 'a', 'an', 'to', 'of', 'with', 'for', 'about', 'in', 'on', 'at', 'from', 'into', 'than', 'as',
  'my', 'your', 'his', 'her', 'their', 'our', 'its', 'this', 'that', 'these', 'those', 'which', 'who', 'whose',
  'if', 'when', 'where', 'while', 'then', 'just', 'really', 'very', 'pretty', 'more', 'some', 'any', 'kind', 'sort',
  'is', 'was', 'are', 'were', 'be', 'been', 'am', "i'm", "it's", "that's", "there's", 'i', 'we', 'you', 'they',
  'gonna', 'wanna', 'want', 'need', 'could', 'would', 'should', 'can', 'will', 'might', 'maybe', 'also', 'even',
]);

export function trailsOff(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/[?!]$/.test(t)) return false; // a question or an exclamation is a finished turn
  if (/(\.\.\.|…|,|-|—|–)$/.test(t)) return true; // trailed off, or cut mid-clause
  const last = t.toLowerCase().replace(/[.\s]+$/, '').split(/\s+/).pop()?.replace(/^[^a-z']+|[^a-z']+$/g, '');
  return DANGLING.has(last);
}
