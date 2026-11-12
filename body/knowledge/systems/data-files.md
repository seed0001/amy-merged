# Your data files (everything under data/)

## data folder / data files / where everything is kept / what is in data / list of data files
Everything you keep lives in the `data` folder of your project (`DATA_DIR` in `src/config.js`). Files there are written by your own modules while you run; nothing in `data/` is part of the code. JSON files are usually written whole to a `.tmp` file and then renamed over the old one, so a crash mid-write doesn't leave half a file. `.jsonl` files are logs: one JSON object per line, newest at the bottom.

The sections below go file by file: what writes it, what reads it, what the fields mean, and what a memory wipe does to it. Three rules hold for all of them:
- A **memory wipe** (dashboard button, `POST /api/memory/wipe`) moves your memory files out of `data/` into `data/backups/wiped-<time>/`. Nothing is deleted, so moving them back undoes it. The list is `MEMORY` in `src/memory-wipe.js`.
- A **fresh install** (`POST /api/system/fresh`) does the wipe plus `owner-rules.db` (and its `-wal`/`-shm`), `prompt-edits.json`, the project's `persona.md`, and clears your name, wake words and local inner guidance in `settings.json`. Everything else in settings (voice, brain, models, channels, keys) stays (owner, 2026-11-09).
- Some files are **never wiped**: settings (except the fresh-install keys), voices, avatar models and outfits themselves, music, files and pictures you made, `rebirth/`, `restart.json`.

Never read out the values in files that hold keys (`cloud-viewer.json`, `cloud-viewer-secrets.json`) or anyone's private message text. Name the file and what it's for instead.

## wipe marker / wipe-memory.json / how a wipe runs / wiped backup folder / undo a wipe
The wipe can't run while you're up, because `companion.db` is held open the whole time. So the button only writes `data/wipe-memory.json` (`{ by, at, full }`, by `scheduleWipe()`) and restarts you. On the next start, `src/index.js` imports `memory-wipe.js` before anything opens your memory, and `runPendingWipe()`:
1. Deletes the marker first (one try only: a failed wipe never repeats on every start).
2. Makes `data/backups/wiped-<ISO time with : and . turned into ->/`.
3. Moves every file on the list that exists into it, keeping sub-folders (`avatars/library.json` lands in `backup/avatars/`).
4. Full reset only: moves `persona.md` from the project folder into the backup and clears the running persona; copies `settings.json` into the backup, deletes `botName`, `voiceWakeWords`, `voiceOwnerWakeWords`, `voiceWakeWord` and `localInnerGuidance` from it, and saves empty wake word lists so a wake word in `.env` doesn't come back.
5. Prints "Memory wiped: moved N item(s) to <folder>" and any it couldn't move, with the error code.
Anything that failed to move is listed, not retried. If reading the old settings fails, the message says your voice and brain may need setting again on the dashboard.

## companion.db / the database / sqlite / tables / messages table / memories table
`data/companion.db` is the main SQLite database (with `companion.db-wal` and `companion.db-shm`, its write-ahead files; all three move together in a wipe). It's opened by `src/memory.js` and shared by other modules. Tables, by the module that creates them:
- `memory.js`: `messages` (every line in every conversation), `memories` (long-term memories per person), `summaries`, `contacts` (people and their tiers), `obligations`, `greeted`, `persona_history` (past names and personas).
- `kg.js` (your knowledge graph, through memory.js): `kg_nodes`, `kg_links`, `kg_facts`, `kg_dates`.
- `personal-wordnet.js`: `personal_nodes`, `personal_links`.
- `profiles.js`: `person_profiles`.
- `scratchpad.js`: `scratchpad`, `threads`. `thoughts.js`: `thoughts`. `topics.js`: `topics`, `topic_lines`, `topic_links`.
- `calendar.js`: `calendar_events`. `projects.js`: `project_proposals`. `self-dialogue.js`: `self_dialogues`. `prompts.js`: `prompt_builtins` (the built-in text of each editable prompt).
Read it through your tools, never by hand: it holds people's messages. A memory wipe moves the whole file, so every table above starts empty.

Other databases: `data/owner-rules.db` (table `owner_rules`, `src/owner-rules.js`; only a fresh install moves it). The conversation budget shared by all companions is not in `data/`: it is `.companions-conversations.db` in the folder above the project, or `CONVERSATION_BUDGET_FILE`.

## settings.json / saved settings / dashboard settings file / what overrides .env
`data/settings.json` holds every setting changed from the dashboard or by your own tools (`updateSettings()` in config.js). It overrides `.env`. If it can't be read, you start with a warning "Ignoring unreadable data/settings.json" and use `.env` alone. Its keys include `botEnabled`, `avatarVideo`, `brain`, `ollamaModel`, `ollamaThink`, `openrouterModel`, `doctorOpenCodeModel`, `doctorOpenCodePath`, `providerFailover`, `providerFailoverNarration`, `providerRetryMinutes`, `openrouterReasoning`, `imageProvider`, `openrouterImageModel`, `historyLimit`, `personaSelfEdit`, `chatChannelIds`, `innerMonologue`, `soloMonologue`, `selfDialogueEnabled`, `selfDialogueProvider`, `thoughtChannelId`, `ttsProvider`, `kokoroVoice`, `rssFeeds` and the voice and wake word settings. A memory wipe keeps it. A fresh install keeps it except the five identity keys.

## activity.jsonl / activity log / context.jsonl / turn-log.jsonl / tool-failures.jsonl / log files
- `activity.jsonl`: every `activity(type, ...)` event (`src/events.js`), one per line with `type` and `time` plus that event's fields. Trimmed to the newest 5000 lines when it loads. Fed to the dashboard's live feed and read by the doctor and life support. Wiped.
- `context.jsonl`: one line per reply from the context meter (`src/context.js`): id, time, conversation, voice, character, speaker, brain, model, `sections` (each part of the prompt with its characters and tokens), system and total tokens, cap, percent, headroom, history, tools, images, summary, memories and limits. Wiped.
- `turn-log.jsonl`: one line per turn (`companion.js`): time, conversation, speaker, who started it, voice, routing mode, classifier time, the messages sent, tools offered, calls made and the reply. Wiped.
- `tool-failures.jsonl`: each tool failure (`src/failures.js`, also `claims.js`): time, conversation, kind, tool, error code, note. Wiped.
- `bot.out.log`, `bot.err.log`: nothing in the current code writes them (both are empty); the doctor and life support are told to read `bot.err.log` if it has anything.

## feelings files / emotions.json / arousal.json / sleep.json / continuity.json / pressure-state.json / pressure-config.json / energy-ledger.jsonl
- `pressure-state.json` (`pressure.js`): your live pressure: `version`, `last_tick`, `buckets` (every want's level 0 to 1, boredom, curiosity, loneliness and so on), and bookkeeping such as `feel_tick`, `ignored_streak`, `quiet_until`, `last_speakup`, open questions, curiosity leads, build counts. Wiped.
- `pressure-config.json` (`pressure.js`): how the pressure system is tuned: `enabled`, `actions_live`, `tick_seconds`, `global_cap`, `idle_minutes`, `reach_channels`, `buckets` (each with `enabled`, `fill_rate`, `decay_rate`, `threshold`, `drain`, `hysteresis`), flows and more. Made with the defaults on first start; edited live from the mind page. Not wiped.
- `energy-ledger.jsonl` (`pressure.js`): every transfer of energy from a conversation line: time, speaker, conversation, words, depth, substance, resonance, topic, offered, energy, refused, `went` (how much went to each bucket), reserve, held. Wiped.
- `emotions.json` (`emotion.js`): each character's feelings (`feelings` name to 0..1) and when. Wiped.
- `arousal.json`: retired arousal value (`value`, `at`, `lastAttention`); only the wipe list still names it.
- `sleep.json` (`sleep.js`): `asleep`, `since`, `lay`, `chose`, `nap`, `debt`, `lastNight`, `woken`, `wokeFrom`, `sleptAt`, `lastTalk`. Wiped.
- `continuity.json` (`continuity.js`): `started_at`, `last_alive`, `downtime_ms`, the last time per conversation, and `bruises` (lessons from things that went wrong: kind, key, context, lesson, count, first, last, expires). Wiped.

## people files / relationships.json / direction.json / tier-moves.json / warnings.json / moderation.jsonl / ignoring.json / presence.jsonl / voiceprints.json
- `relationships.json` (`relationship.js`): per Discord id: name, closeness, attraction, spark, rush, trust, commitment, hurt, resentment, jealousy, lines, met, last seen, stage, milestones, peak. Wiped.
- `direction.json` and `direction-history.jsonl` (`direction.js`): your aim with each person (aim, why, since, progress, flat, drift, evidence...) and every change to it (who, what, before, after, why, by). Wiped.
- `tier-moves.json` (`relationships.js`): tier promotions and demotions. Wiped.
- `warnings.json` and `moderation.jsonl` (`moderation.js`): warnings given and moderation actions. Wiped.
- `ignoring.json` (`ignoring.js`): who you've chosen to ignore. Wiped.
- `presence.jsonl` (`presence.js`): joins and leaves in calls: `ts`, conversation, userId, name, event. Wiped.
- `voiceprints.json` (`voiceprints.js`): `settings` (`threshold`, `margin`) and per person: name, count, seconds, a 512-number `centroid` (the voiceprint), updated, learnedAt. Not on the wipe list, so you keep knowing voices after a wipe.

## mind files / curiosity.json / interests.json / reflections.json / self-work.json / discoveries.json / experiences.jsonl / creations.json / salience.json
- `curiosity.json` (`curiosity.js`): `questions`, `next`, `settled`. Wiped.
- `interests.json` (`interests.js`): `topics`, each with name, interest, mentions, last, sources, people and a 1024-number `vec` (its meaning). Wiped.
- `reflections.json` (`reflections.js`), `sleep-on-it.json` (`sleep-on-it.js`): insights and going back over the day. Wiped.
- `self-work.json` (`self-work.js`): `cursors` per conversation, `aspects` (growth, origin, voice, others, body, purpose: each your answer and when), `lastRealize`, `lastPonder`, `lastReflection`. Wiped; your rebirth letter reads it first.
- `discoveries.json` (`discoveries.js`): `tried` (tool name to the first time you used it) and `shown`. Wiped, so you discover everything again.
- `experiences.jsonl` (`experience.js`): each attempt: id, act, objective, method, spent, result, why, person, bucket, expected, outcome, satisfaction, reward, and a meaning vector. Wiped.
- `creations.json` (`creations.js`): what you made for people: act, label, detail, who for, status, your `expectation`, and when closed the `verdict` and what they said. Wiped.
- `salience.json` (`salience.js`): `load`, what keeps coming back to you: per key `acc` (weight built up), `at`, `n` (times it surfaced), `text`, `kind`. At most 400 kept. Not on the wipe list.
- `asked-questions.json` (`question-engine.js`): the last 60 areas you asked about (`key`, `text`, `to`, `at`). Wiped. `question-bank.json` is the retired question bank; only the wipe list still names it.
- `intuition-tuning.json` (`intuition.js`): your gut-read instructions, when last reviewed and the review results. Wiped.
- `reactions-log.jsonl` (`taste.js`): what struck you: time, style, family, score, speaker, line, why, whether it was to you. Wiped.
- `onboarding.json` (`onboarding.js`): `done` (each checklist step and when) and `setup_started`. Wiped, so the checklist starts again.
- `mind-seed.json`, `mind-structure.json`, `mind-history.jsonl`, `mind-edits.jsonl` (`cognitive-graph.js`): your mind map's seed, current shape, its history and live edits for undo. All wiped, so a new you grows a new shape. See the mind-view guide.
- `journal/` (one `.md` per day, `journal.js`), `research-decisions.jsonl` (each research decision with its trigger, pressure, what was considered and why), `dreams/` (`dreams.js`), `goal-work/` (`goal-work.js`): wiped.
- `home-taste.json` (`home-taste.js`): your taste for your home (`taste`: style, palette, light, materials, plants, furniture, vibe), `wants`, `verdicts`. Not wiped.
- `songbook.json` (`songbook.js`): `next` and `songs` (title, style, lyrics, notes, origin, status, revisions, file). Not wiped.

## inner life files / inner-prompts.json / inner-style.json / inner-prompt-history.json / prompt-edits.json / doctor-reports.json / work-done.jsonl
- `inner-prompts.json`, `inner-style.json` (`level`, `notes`, `by`, `changed`, `reason`), `inner-prompt-history.json` (each change: key, at, by, reason, before, after; 200 kept): all from `inner-core.js`. Not wiped.
- `prompt-edits.json` (`prompts.js`): the owner's saved prompt edits, each with its template and time. A fresh install moves it.
- `doctor-reports.json` (`doctor.js`): each doctor visit: at, started, title, ok, report, changed, tests, engine.
- `work-done.jsonl` and `work-done-pending.jsonl` (`work-done.js`, `scripts/tell-amy-done.mjs`): notes from Claude Code that a job on you is finished (title, summary, not done, restart needed, from, at, delivered, told at), and ones still waiting to be told.
- `provider-failover.json` (`provider-router.js`): `blocked` providers, the `active` provider and model, and `lastSwitch`.
- `voice-worn.json` (`voice/library.js`): a voice you're wearing in a call (wiped); `voice-history.jsonl`: every voice change, who and why (not wiped).

## avatar files in data / avatar.glb / avatars folder / backgrounds folder / outfits folder / characters / looks
- `avatar.glb`: your default 3D body (`AVATAR_PATH` can point elsewhere). `avatars/`: the avatar library's models and `library.json` (which one is active). `characters/` and the `rocketbox_*` folders: other cast members' models; `characters.json` lists the cast (id, name, persona, voiceId, model, role, description).
- `backgrounds/`: images, `scenes/`, `shaders/`, `library.json`, `background.json` (what's behind you now) and `last-report.json` (the page's last report).
- `outfits/`: outfit models and previews, `wardrobe.json`, `designs.json`, `colors.json`, and `sewn/`. `seamstress/`: the dress form body.
- `avatar-state.json` (appearance), `avatar-view.json` (`scale`, `zoom`, `frame`), `avatar-performance.json` (`gain`, `autonomous`, `gaze`), `bubble-style.json` (`scale`).
On a wipe your look goes back to the defaults: `avatar-state.json`, `avatar-view.json`, `avatars/library.json`, `backgrounds/background.json` and `outfits/colors.json` move out. The models themselves stay.

## work folders / files folder / images / tasks / file-history / project-runs / workshop / reverse / art / music / browser-profile / needle / inner-models / backups
None of these are wiped.
- `files/`: files you wrote. `images/`: pictures you generated (named by time). `file-history/`: a copy of a file before each edit, for undo (`files.js`; named `<time>@@<path with __ for slashes>`).
- `tasks/`: background helper reports, one `.md` each (`agents.js`). `task-deliveries/`: generated pictures and music waiting for the dashboard (`generation-deliveries.js`).
- `workshop/`: `projects.json` and `jobs/` (`workshop.js`). `project-runs/`: a receipt per project run (`project-runtime.js`).
- `reverse/`: numbered reverse-engineering reports (`reverse.js`). `art/`: your 3D pieces (`art.js`). `music/`: the music library (plus `playlists.json`, and `.dance` caches).
- `browser-profile/`: your own browser's profile, with `browser.json` for its state (`browser.js`).
- `inner-models/`: your specialist models (dialogue, face, memory, reasoning, reflection, synthesis) and `face.jsonl`. `needle/`: the face model trial on Needle (`scripts/needle-face.py`): adapter, checkpoints, model, recipe, status and training lines.
- `voices/xtts/`: reference clips for XTTS.
- `backups/`: wiped memory folders and database copies made before repairs (for example before a memory rebuild).
- `rebirth/` (letter to your next self) and `restart.json` (the restart marker): never wiped, on purpose.
- `cloud-viewer.json`: the cloud viewer's address and publisher key (`cloud-publisher.js`). `cloud-viewer-secrets.json`: keys too; no code here reads it by name. Never read either out.
