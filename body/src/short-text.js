// A DM she starts is a short, personal text, never a wall of text (owner, 2026-11-09). Whatever the model wrote,
// it ends at the last full sentence that fits in a short text. Returns { text, trimmed }.
export const DM_MAX = 320;

export function shortText(line, max = DM_MAX) {
  const text = String(line ?? '').trim();
  if (text.length <= max) return { text, trimmed: false };
  const sentences = text.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g) ?? [text];
  let kept = '';
  for (const s of sentences) {
    if ((kept + s).trim().length > max) break;
    kept += s;
  }
  kept = kept.trim();
  // One sentence longer than a whole text: cut it at a word and say so with an ellipsis.
  if (!kept) kept = `${text.slice(0, max - 20).replace(/\s+\S*$/, '')}…`;
  return { text: kept, trimmed: true };
}
