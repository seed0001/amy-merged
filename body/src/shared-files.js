// What people sent her lately, in any of her conversations, for her prompt in the others. A picture
// posted in a text channel is in that channel's history only; in the voice call a minute later she
// had "no idea" what dog Owner meant. This carries what she received (and what she saw in it) across
// all her conversations for a while.

const HOUR = 3600_000;

const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} h ago`; };

// rows: memory.receivedFileRows() rows ({ conversation, name, created_at, attachments: JSON }).
// Returns prompt lines for files shared outside `conversation` within `withinMs`, newest first.
export function sharedLines(rows, { conversation, now = Date.now(), withinMs = HOUR, max = 4 } = {}) {
  const out = [];
  for (const r of rows) {
    if (now - r.created_at > withinMs) continue;
    if (r.conversation === conversation) continue; // already in this conversation's history
    let a; try { a = typeof r.attachments === 'string' ? JSON.parse(r.attachments) : r.attachments; } catch { continue; }
    const images = a?.images ?? [], docs = a?.docs ?? [];
    if (!images.length && !docs.length) continue;
    const names = [...images, ...docs].map((f) => f.name).filter(Boolean);
    const seen = images.map((i) => i.seen).filter(Boolean).join(' / ');
    out.push(`${r.name ?? 'Someone'} sent ${names.length ? names.map((n) => `"${n}"`).join(', ') : 'a file'} in ${a.where ?? 'a chat'} ${ago(now - r.created_at)}.${seen ? ` What you saw in it: ${seen.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
    if (out.length >= max) break;
  }
  return out;
}

export function sharedSection(rows, opts) {
  const lines = sharedLines(rows, opts);
  if (!lines.length) return '';
  return `Shared with you lately, in other conversations (you have it; you can describe it and talk about it here):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
