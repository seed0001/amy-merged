import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, config } from './config.js';

// Wiping all her memory from the dashboard. Her database is held open the whole time she runs, so
// the button only leaves a note and restarts her; the wipe itself happens here, first thing on the
// next start, before anything opens her memory. Nothing is deleted: it moves to
// data/backups/wiped-<time>/, so moving it back undoes it.
//
// Everything in data/ goes, except what's named in KEEP below (owner, 2026-11-11: a full reset left her
// voiceprints behind, because the wipe used to move only a fixed list of memory files and every newer file
// that wasn't added to it survived). So a file a new feature starts writing is cleared by default; keeping
// one is the deliberate choice. Her life file is never touched.

// How she's installed, what the owner set up, what she made, and the records that belong to the owner.
export const KEEP = [
  // Install: settings (a full reset clears her identity keys inside it, below), keys, providers, models, browser.
  'settings.json', 'pressure-config.json', 'provider-failover.json', 'cloud-viewer.json', 'cloud-viewer-secrets.json',
  'browser-profile', 'browser.json', 'phone-accounts.json', 'phone-sense.json', 'wordnet', 'inner-models', 'models',
  // Her voices and the record of voice changes.
  'voices', 'voice-history.jsonl',
  // The avatar models and looks themselves, the studio's cast, and how the page shows her bubbles.
  // (Her look resets to the defaults: see LOOK below.)
  'avatar.glb', 'avatars', 'backgrounds', 'looks', 'outfits', 'seamstress', 'characters', 'characters.json',
  'avatar-performance.json', 'bubble-style.json',
  // What she made: files, pictures, music, songs, art, projects and the work she delivered.
  'files', 'file-history', 'images', 'music', 'art', 'songbook.json', 'playlists.json', 'workshop', 'projects',
  'project-runs', 'tasks', 'task-deliveries', 'reverse', 'needle',
  // Her taste (what she finds funny, how she wants her home): she keeps it through a wipe.
  'taste.json', 'home-taste.json',
  // The owner's records: what she cost, repairs and work done on her, and work she still has to tell him about.
  'spend.jsonl', 'doctor-reports.json', 'architect-reports.json', 'work-done.jsonl', 'work-done-pending.jsonl',
  // Owner rules and prompt edits stay through a memory wipe; a full reset takes them (FULL below).
  'owner-rules.db', 'owner-rules.db-wal', 'owner-rules.db-shm', 'prompt-edits.json',
  // Running state: her letter to her next self (rebirth.js), where she was in voice (so she comes back to the
  // same call), the locks, the logs, and the backups themselves. Her life file is never touched.
  'rebirth', 'restart.json', 'in-voice.json', 'instance.lock', 'doctor.lock', 'bot.out.log', 'bot.err.log',
  'backups', 'life.json',
];
// Folders kept whole by name prefix: the avatar studio's character models (characters.js).
export const KEEP_PREFIXES = ['rocketbox_'];

// Her look goes back to the defaults even though the folders above are kept: no saved avatar choice, backdrop or
// outfit colours. A fresh companion starts neutral and professional.
export const LOOK = [path.join('avatars', 'library.json'), path.join('backgrounds', 'background.json'), path.join('outfits', 'colors.json')];

const MARKER = 'wipe-memory.json';

// A full reset (a fresh her): her memory, plus who she was made to be: the owner rules, the prompt edits,
// her persona, her name and her wake words (back to none, so she answers everyone in voice until they're set up
// again). How she's installed stays: her voice, brain, models, speech, channels and keys. Nothing is deleted;
// it all moves (or, for settings, is copied) to the same backup folder.
export const FULL = [
  'owner-rules.db', 'owner-rules.db-wal', 'owner-rules.db-shm', 'prompt-edits.json',
];
// Settings a full reset clears: who she is, not how she's installed. Owner, 2026-11-09: a full reset used to move
// all of settings.json aside, so her voice (Fish voice IDs), her brain and models, speech-to-text and the rest
// fell back to .env and "her voice changed". Those stay now; her name and wake words go back to zero.
export const IDENTITY_SETTINGS = ['botName', 'voiceWakeWords', 'voiceOwnerWakeWords', 'voiceWakeWord', 'localInnerGuidance'];

// Whether a top-level name in data/ survives this wipe.
export function kept(name, { full = false } = {}) {
  if (name === MARKER) return true; // already removed before the wipe runs; never moved
  if (full && FULL.includes(name)) return false;
  return KEEP.includes(name) || KEEP_PREFIXES.some((p) => name.startsWith(p));
}

export function scheduleWipe({ dataDir = DATA_DIR, by = 'dashboard', at = Date.now(), full = false } = {}) {
  writeFileSync(path.join(dataDir, MARKER), JSON.stringify({ by, at, full }));
}

export function wipePending({ dataDir = DATA_DIR } = {}) {
  return existsSync(path.join(dataDir, MARKER));
}

// Moves her memory into a backup folder. Returns what moved and where, or null if no wipe was asked for.
export function runPendingWipe({ dataDir = DATA_DIR, at = new Date(), rootDir = dataDir === DATA_DIR ? ROOT : null, onPersonaCleared = dataDir === DATA_DIR ? () => { config.persona = ''; } : null } = {}) {
  if (!wipePending({ dataDir })) return null;
  let full = false;
  try { full = Boolean(JSON.parse(readFileSync(path.join(dataDir, MARKER), 'utf8')).full); } catch {}
  rmSync(path.join(dataDir, MARKER), { force: true }); // one try: a failure never wipes on every start
  const backup = path.join(dataDir, 'backups', `wiped-${at.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(backup, { recursive: true });
  const moved = [], failed = [];
  const move = (name) => {
    if (!existsSync(path.join(dataDir, name))) return;
    try { mkdirSync(path.dirname(path.join(backup, name)), { recursive: true }); renameSync(path.join(dataDir, name), path.join(backup, name)); moved.push(name); }
    catch (err) { failed.push(`${name} (${err.code})`); }
  };
  for (const name of readdirSync(dataDir)) if (!kept(name, { full })) move(name);
  for (const name of LOOK) move(name);
  // A full reset clears her persona too (owner, 2026-11-09): the new user sets up how she acts and talks
  // (onboarding.js, the persona step). persona.md lives in the project folder, not data/, so it's moved here
  // explicitly, into the same backup. config.js has already read it by now, so the running copy is cleared too.
  if (full && rootDir) {
    const persona = path.join(rootDir, 'persona.md');
    if (existsSync(persona)) {
      try { renameSync(persona, path.join(backup, 'persona.md')); moved.push('persona.md'); if (onPersonaCleared) onPersonaCleared(); }
      catch (err) { failed.push(`persona.md (${err.code})`); }
    }
  }
  // Wake words back to none (owner, 2026-11-09): she answers everyone in voice until the new user sets them
  // up with her (onboarding.js, the wake_words setup step). Saved as empty settings, which override .env, so a
  // wake word in .env doesn't quietly come back on the next start. config.js already started this run with none.
  // Her install settings (voice, brain, models, channels) are kept; the old file is copied into the backup first.
  if (full) {
    const file = path.join(dataDir, 'settings.json');
    let keptSettings = {};
    try {
      if (existsSync(file)) { copyFileSync(file, path.join(backup, 'settings.json')); keptSettings = JSON.parse(readFileSync(file, 'utf8')); }
    } catch (err) { failed.push(`reading the old settings (${err.code ?? err.message}): her voice and brain may need setting again on the dashboard`); }
    for (const key of IDENTITY_SETTINGS) delete keptSettings[key];
    try { writeFileSync(file, JSON.stringify({ ...keptSettings, voiceWakeWords: [], voiceOwnerWakeWords: [] }, null, 2)); moved.push('settings.json (name and wake words cleared; voice, brain and the rest kept)'); }
    catch (err) { failed.push(`clearing the wake words (${err.code}): set them to nothing on the dashboard`); }
  }
  return { moved, failed, backup };
}

// Runs on import: index.js imports this before anything that opens her memory.
export const lastWipe = runPendingWipe();
if (lastWipe) console.log(`Memory wiped: moved ${lastWipe.moved.length} item(s) to ${lastWipe.backup}${lastWipe.failed.length ? `; couldn't move ${lastWipe.failed.join(', ')}` : ''}`);
