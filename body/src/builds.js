import { activity } from './events.js';
import { workshop, BUILD_GUIDE } from './workshop.js';
import { selfName, selfHis } from './config.js';

// What she builds on her own. The pressure system decides when (the build bucket fires) and the code
// here decides what, where and why: the idea comes from her interests, the folder and name from the
// idea, and the reason from the bucket values and interest sources. The coding model only writes the
// files it's given the brief for; nothing about the folder, the name or the reason is left to recall.

// Named after whoever this companion is (config.js selfName): "Desktop\James Projects", "James <topic>".
export const buildRoot = () => `Desktop\\${selfName()} Projects`;
const prefix = () => `${selfName()} `;

export const slugOf = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';

// The strongest interest she doesn't have a project for yet, or null. Interests come from interests.js.
export function pickIdea(top = [], built = new Set()) {
  const best = top.find((t) => t.interest >= 0.5 && !built.has(slugOf(t.name)));
  return best ? { topic: best.name, interest: best.interest, why: best.why || `it has been on ${selfHis()} mind` } : null;
}

// Names of projects she has already made, so an idea isn't built twice.
export function builtIdeas(w = workshop()) {
  const p = prefix();
  return new Set(w.snapshot().filter((x) => x.name.startsWith(p)).map((x) => slugOf(x.name.slice(p.length))));
}

export function briefFor({ idea, name, folder, pressure, feelings }) {
  return `Build a browser app for the owner, in ${folder}. Name it "${name}".
What it is about: ${idea.topic}.
Why it's being built: ${idea.why}. ${selfName()}'s own interest in it is ${idea.interest.toFixed(2)} out of 1, and it came from things said and read, not from a request.
What drove it (pressure at the moment it was started): ${pressure}. Feelings then: ${feelings}.
What to make: one working page at index.html, with styles.css and app.js if it needs them. It should show something real about ${idea.topic} that ${selfName()} can learn from and keep up with: clear, readable, with no build step, no npm and no install. Libraries come from a CDN if needed. Keep it small and finish it.
Read ${BUILD_GUIDE} first. Check your files for errors before you report. Do not push or publish anything.`;
}

// Starts one build end to end: the folder and project (workshop add, which makes the folder), the notes
// that say why, the coding job, and, when it's done, the page opened in her tab.
export async function startBuild({ idea, pressure, feelings, w = workshop(), openTab, now = Date.now }) {
  const name = `${prefix()}${idea.topic}`.slice(0, 60);
  const folder = `${buildRoot()}\\${slugOf(idea.topic)}`;
  const why = `Built by ${selfName()} from ${selfHis()} own interest in ${idea.topic} (${idea.interest.toFixed(2)}; ${idea.why}). Driven by: ${pressure}.`;
  w.add({ name, folder, notes: why });
  const task = briefFor({ idea, name, folder, pressure, feelings });
  const started = await w.start(name, task, async (text) => {
    activity('build', { project: name, report: text.slice(0, 400) });
    if (/ done:\n/.test(text)) await w.open(name).catch((err) => activity('error', { where: 'build open', message: err.message }));
  });
  activity('build', { project: name, folder, why, started: started.slice(0, 160), at: now() });
  return { name, folder, why, started };
}
