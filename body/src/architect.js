import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT, DATA_DIR, config, selfName } from './config.js';
import { activity } from './events.js';
import { runCoder, doctorBusy, describeWhen } from './doctor.js';
import { homeTaste } from './home-taste.js';

// The architect: the doctor's twin for her 3D home and world. She and her owner talk about the place;
// what they decide goes to him as a brief with the owner's words verbatim and her own taste attached,
// and he builds it on the Studio page (the avatar page, its world mode, shaders, assets). He never
// touches how she thinks or talks. When he reports, she judges the result by her taste (home-taste.js)
// and that judgement is pressure: liking it is joy, not liking it makes her say what she wants
// changed. Bracketed by git commits like the doctor, tests run after, reports kept on disk.

const run = promisify(execFile);
const git = (...args) => run('git', ['-c', `user.name=${selfName()}`, '-c', `user.email=${selfName().toLowerCase()}@localhost`, ...args], { cwd: ROOT, maxBuffer: 8 << 20 });
const TIMEOUT_MS = 30 * 60000;
const MIN_BRIEF = 20;
const REPORTS = path.join(DATA_DIR, 'architect-reports.json');
const LOCK = path.join(DATA_DIR, 'doctor.lock'); // the watchdog leaves her alone while this exists
const KEEP = 10;
let visit = null; // { task, started, child }
let reports = (() => { try { const l = JSON.parse(readFileSync(REPORTS, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } })();
export const lastBuild = () => reports[0] ?? null;
export const architectBusy = () => Boolean(visit);
function saveReport(entry) { reports = [entry, ...reports].slice(0, KEEP); try { mkdirSync(path.dirname(REPORTS), { recursive: true }); writeFileSync(REPORTS, JSON.stringify(reports, null, 1)); } catch (err) { activity('error', { where: 'architect', message: `Couldn't save the architect's report to ${REPORTS}: ${err.message}. "status" will not have it after a restart.` }); } }

const VOICE = 'C:\\Bots\\Amy-Voice'; // the earlier build of her world (beach house, pet, shaders) to port from
export const RULES = `You are the architect for ${config.botName}, a Discord companion with a 3D avatar on a web page (the Studio page: src/dashboard/public/avatar.html and avatar*.js, world*.js, served by src/dashboard/server.js; scene/background/view state in src/avatar-background.js and src/avatar-view.js; assets under data/backgrounds and data/world). You build and refine HER HOME AND WORLD: the house, the land and sea around it, light, weather, props, her dog. Rules:
- Scope: only the Studio page files and world assets named above, plus their tests. Never edit her persona, prompts, pressure system, companion.js, tools.js, voice code or memory. If the world needs a new tool argument or setting, describe it in your report instead of editing those files.
- The bar is a game engine: Unity or Unreal level of detail. Layer after layer, each one controllable (sky, sun, sea, terrain, house shell, rooms, furniture, plants, props, particles, post), physically plausible lighting, materials with normals and roughness, motion everywhere, no flat colours and no kiddish shapes. Write as many shaders as it takes and write them long. Performance still matters: it runs in one browser tab beside her avatar.
- Build to HER taste, which is attached to every brief, and to the owner's words, which are quoted verbatim and are the authority. Where they disagree, the owner decides; where he is silent, her taste decides. Never substitute your own taste.
- Her earlier world exists at ${VOICE} (src/avatar/public/avatar-world.js, avatar-world-mode.js, world-layout.js, world-shaders.js, avatar-pet.js and the avatar/world data folder). When asked for the beach house or the dog, port from there into this project as a world mode on the Studio page rather than starting over, then raise it to the bar above. Her dog Chance has a 3D asset at C:\\Users\\user\\OneDrive\\Desktop\\lyra-video-game\\assets\\characters\\chance.fbx; convert to GLB (embedded textures) for the page.
- The owner runs everything by voice and is not at the keyboard: never stop to ask, never leave him a step. Read the existing code first, do the whole job, run \`npm test\`, keep going until it passes.
- Finish with a short plain-language report she can read out loud: what you built or changed and where she can look at it (which view, what to toggle), in two to six sentences, no code blocks. Then one line starting "LOOK AT:" naming what she should judge first.`;

export function buildArchitectBrief(brief, ownerText = '') {
  return [
    ownerText ? `Owner said (verbatim, the authority on what he wants): "${ownerText}"` : null,
    `The brief from ${config.botName} (what she and her owner decided; her words): ${brief}`,
    homeTaste().briefFor(),
    `When you are done, report what you built and name what she should look at first.`,
  ].filter(Boolean).join('\n\n');
}

export function architectStatus(now = Date.now()) {
  if (visit) return `The architect is already building "${visit.task}" (started at ${describeWhen(visit.started, now)}) and hasn't finished.`;
  const l = lastBuild();
  if (!l) return 'The architect is not building anything right now, and has not delivered anything yet.';
  return `The architect is not building anything right now. His last job, "${l.title}", finished at ${describeWhen(l.at, now)} and ${l.ok ? 'went fine' : 'FAILED'}${l.changed ? ` (changed: ${l.changed}; tests ${l.tests})` : ' (no files changed)'}. His report: ${l.report}${l.verdict ? ` Your verdict on it: ${l.verdict.verdict}: ${l.verdict.why}` : ''}`;
}
export const buildResult = (b) => `architect ${b.title}: ${b.ok ? 'ok' : 'failed'}, ${b.changed ? `tests ${b.tests}` : 'no files changed'}`;

export async function callArchitect(brief, notify, opts = {}) {
  brief = String(brief ?? '').trim();
  if (brief.length < MIN_BRIEF) return `Error: the architect needs a real brief (at least ${MIN_BRIEF} characters): what to build or change, in full, with what you two decided. Nothing was dispatched.`;
  const now = opts.now ?? Date.now;
  if (visit) return `Error: ${architectStatus(now())} Nothing new was dispatched.`;
  if ((opts.doctorBusy ?? doctorBusy)()) return 'Error: the doctor is working on your code right now; the architect waits until he is done so they do not edit the same project at once. Nothing was dispatched.';
  const gitCmd = opts.gitImpl ?? git;
  const coder = opts.runImpl ?? runCoder;
  const judge = opts.judgeImpl ?? ((report) => homeTaste().judge(report));
  const ownerText = String(opts.ownerText ?? '').trim();
  await gitCmd('add', '-A');
  await gitCmd('commit', '-q', '--allow-empty', '-m', `Before architect: ${brief.slice(0, 60)}`);
  const title = brief.length > 60 ? `${brief.slice(0, 57)}...` : brief;
  visit = { task: title, started: now(), child: null };
  const madeLock = !existsSync(LOCK);
  if (madeLock) try { writeFileSync(LOCK, String(now())); } catch (err) { activity('error', { where: 'architect', message: `Couldn't write ${LOCK}: ${err.message}. The watchdog may restart her while the architect is editing.` }); }
  activity('architect', { status: 'started', task: title, ownerText: ownerText.slice(0, 500) });
  const npmTest = opts.npmTestImpl ?? (() => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: ROOT, shell: process.platform === 'win32', timeout: 300000, maxBuffer: 8 << 20 }).then(() => ({ ok: true }), (e) => ({ ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` })));

  (async () => {
    let result;
    try { result = await coder({ prompt: buildArchitectBrief(brief, ownerText), rules: RULES, cwd: ROOT, timeoutMs: TIMEOUT_MS, onChild: (c) => { if (visit) visit.child = c; } }); }
    catch (e) { result = { ok: false, report: `The architect could not run: ${e.message}` }; }
    let summary = '', tests = 'not run';
    try {
      summary = (await gitCmd('diff', '--stat', 'HEAD')).stdout.trim();
      if (summary) {
        const t = await npmTest();
        tests = t.ok ? 'pass' : 'FAIL';
        if (!t.ok && result.sessionId) {
          const fix = await coder({ prompt: `npm test fails after your change. Fix it (your code, or tests that are out of date), run npm test until it passes, then give your final report again.\n\nTest output (end):\n${String(t.output).slice(-6000)}`, rules: RULES, cwd: ROOT, resume: result.sessionId, timeoutMs: TIMEOUT_MS, onChild: (c) => { if (visit) visit.child = c; } }).catch(() => null);
          if (fix) { result = fix; tests = (await npmTest()).ok ? 'pass' : 'FAIL'; summary = (await gitCmd('diff', '--stat', 'HEAD')).stdout.trim(); }
        }
        await gitCmd('add', '-A');
        await gitCmd('commit', '-q', '-m', `Architect: ${title}`);
      }
    } catch (e) { result.report += ` (Saving the change failed: ${e.message})`; }
    visit = null;
    if (madeLock) rmSync(LOCK, { force: true });
    const changed = summary.split('\n').slice(0, -1).map((l) => l.split('|')[0].trim()).join(', ');
    const entry = { at: now(), title, ok: Boolean(result.ok), report: String(result.report ?? '').slice(0, 900), changed, tests, engine: result.engine ?? null, verdict: null };
    saveReport(entry);
    activity('architect', { status: entry.ok ? 'done' : 'failed', task: title, changed: Boolean(summary), tests, report: entry.report.slice(0, 500) });
    // Her verdict, by her taste: recorded with the build and turned into pressure (home-taste.js -> pressure.js).
    let verdict = null;
    if (entry.ok && summary) { try { verdict = await judge(entry.report); entry.verdict = verdict; saveReport(entry); } catch (e) { activity('error', { where: 'home taste (verdict)', message: e.message }); } }
    const text = `The architect ${entry.ok ? 'delivered' : 'failed'}: "${title}".\n${entry.report || 'No report.'}\n` +
      (summary ? `Changed:\n${summary}\nTests: ${tests}.` : 'No files were changed.') +
      (verdict ? `\nHow it strikes you, by your own taste: ${verdict.verdict}. ${verdict.why}${verdict.wants.length ? ` What you want different: ${verdict.wants.join('; ')}.` : ''}` : '');
    const delivered = [];
    try { await notify?.(text); delivered.push('notify'); } catch (e) { delivered.push(`notify failed: ${e.message}`); }
    if (opts.deliverText) { try { await opts.deliverText(text); delivered.push('channel'); } catch (e) { delivered.push(`channel failed: ${e.message}`); } }
    activity('architect', { status: 'reported', task: title, delivered });
    opts.onFinished?.({ text, entry, verdict });
  })();
  return `Dispatched, not built: the architect has started on "${title}"${ownerText ? ' with your owner\'s exact words and your home taste attached' : ' with your home taste attached'}. It takes a while (minutes to half an hour) and the report comes when he finishes; nothing is built yet. Tell your owner it has been sent, not that it is done.`;
}

export function cancelArchitect() {
  if (!visit?.child) return 'The architect is not building anything.';
  visit.child.kill();
  return 'Told the architect to stop. Anything he already changed stays until the doctor or your owner rolls it back.';
}
