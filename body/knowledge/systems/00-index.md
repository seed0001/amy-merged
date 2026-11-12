# Full index: every part of you and where it is explained

Every topic below is a guide topic. Ask for one by name with the guide tool, or ask for "overview" first.

## Avatar speech, lip-sync and deliveries (avatar-speech-and-delivery.md)
- avatar model library / avatar library / avatar models / glb / avatar selection
- avatar outfits / outfits / wardrobe / clothes / suit / dress / swimsuit
- discord avatar / avatar in discord / discord lip sync / discord speech packets
- lip sync / lipsync / phonemes / mouth / visemes
- speech articulation / articulation / cues / timing / speech solver
- generation deliveries / deliveries / generated pictures / generated music / files to discord / send_file
- generation delivery ui / delivery bubbles / dashboard delivery / watchGeneration
- slash commands / commands / deploy commands / deploy / loadCommands
- what she should tell owner when this breaks

## Avatar, studio and books (avatar-studio-and-books.md)
- avatar / 3d avatar / model / glb / body
- appearance / makeup / eye colour / hair / avatar_appearance
- outfit / outfits / clothing / wardrobe / avatar_outfit
- view / framing / zoom / scale / camera / avatar_view
- expression / expressions / face / pose / gesture / gaze / avatar_expression
- moments / outbursts / laugh / cry
- feelings / emotion / expression state
- cues / thinking / listening / recalling / searching / realized
- fidgets / body / idle movement
- avatar studio / studio / avatar page / avatar.html / viewer link
- avatar library / avatar models / selection / player report / avatar_models
- background / backgrounds / the avatar behind her / avatar_background
- shader / glsl / animated background
- background report / last-report.json / browser.ok
- video replies / avatar video / recorder / avatar_mode
- cast / characters / other avatars / cast-prompt
- songbook / songs / songwriting / songbook tool
- songbook actions / write / revise / ready / read / list / drop / record
- journal / research journal / journal entries
- book page / book.html / songbook page / journal page / ?book= / ?id=
- browser / her own browser / tabs / avatar_box
- music / music library / playlists / music tool / generate_music output
- what she should tell Owner when this breaks

## Mind and memory (mind-and-memory.md)
- memory / remember / recall / long-term memory
- what gets remembered and how / memory extraction / grounding
- messages / conversation history / what she sees of a chat
- summaries / consolidation / rollup
- embeddings / similarity / thresholds
- knowledge graph / kg / graph / links / facts / dates
- owner rules / owner-rules / standing rules
- contacts / tiers / stranger / guest / friend
- relationships / tier moves / promotion / demotion
- profiles / affinity / frustration / marks / how she feels about someone
- check-in / reaching out on your own / reach consent
- greetings / obligations / promises (small tables)
- drives / likes / dislikes / compass / feeding (src\drives.js)
- interests / what she's into (src\interests.js)
- curiosity / wondering / questions (src\curiosity.js)
- reflections / insights / goals as decided by you (src\reflections.js)
- goals / how research goals are chosen (src\goals.js and pressure.js)
- pressure / wants / buckets / energy / silence / entropy / ticks / thresholds / state file (src\pressure.js)
- scratchpad / threads / working notes (src\scratchpad.js)
- emotion / feelings / mood (src\emotion.js)
- direction / where you're heading / your aims (src\direction.js): what she's trying to get to with each person and overall, rethought when the direction bucket fires (direction.md)
- relationships (src\relationship.js): closeness, attraction, spark, trust, love, hurt, jealousy and making up with each person, run by the harness (relationships.md); this replaced arousal
- body / body-moves / the avatar's fidgets (src\body.js, src\body-moves.js)
- sleep / bedtime / waking / tiredness (src\sleep.js)
- sleep on it / going back over the day (src\sleep-on-it.js)
- dreams / dreaming / dream cycle (src\dreams.js, src\dream-pictures.js)
- home / the server she lives on (src\home.js)
- looks / appearance / reference sheet (src\looks.js)
- persona / name / personality (src\persona.js and config.js)
- memory wipe / reset / starting over (src\memory-wipe.js)
- what she should tell Owner when this breaks

## Models and providers (models-and-providers.md)
- models and providers overview / which provider / provider list
- provider failover / failover / fallback when a provider runs out
- provider switch messages / narration / what she says when a provider fails
- chatgpt / chatgpt login / chatgpt auth
- chatgpt provider / responses api / streaming / chatgpt requests
- chatgpt errors / openai error messages / exact text
- chatgpt credentials / where credentials are stored
- switch_brain / change model / pick a model / switching your brain
- list_models / model list / best models for a job
- models_local / ollama models / local model management / pull import
- ollama startup check / checkOllama / local model check
- coding tools / codingToolCalls / coding helper / local coding model
- what each model does / model jobs / which brain does what
- self dialogue / self-dialogue / private discussion / self_dialogue tool
- self dialogue table / companion.db / self_dialogues
- inner models / inner-models / specialists / synthesis / face
- awareness / awareness block / what she knows about her own systems
- watch snapshot / watching / cloud viewer / avatar relay
- conversation lead / follow-up / waiting for an answer / conversation-lead
- data files / where state is kept
- log events / activity types / what appears in the log
- failure modes / exact messages / what each means
- what she should tell Owner when this breaks

## Projects, learning, schedules and market (projects-learning-and-market.md)
- project proposal and confirmation / propose a project / start a project after confirmation
- project runtime / running a project / dependencies / install packages / npm python node
- workshop / the owner's projects / coding jobs / run and stop a project / undo a job
- background helpers / helper tasks / task reports / progress lines
- calendar / scheduled tasks / reminders / briefs / when things fire
- scheduled activity / autonomous scheduled actions / kind activity / runs your tools on a timer
- profile learning / people profiles / what she learns about people / frustration and affinity
- personal wordnet / experience links / feelings recall / what it recalls
- market / crypto signals / 15-minute calls / paper trading / what it can and cannot do
- system info / what the PC reports / what she cannot see
- what she should tell Owner when this breaks

## Reply pipeline (reply-pipeline.md)
- life of a turn / message flow / respond
- brains / models / voice brain / hands / planner / local vs cloud
- provider failover / what happens when a model call fails
- system prompt / prompt assembly
- what goes on the latest message (per-turn notes)
- history / history trimming / summaries / restart marker
- tools / tool registry / gating / owner only / enabled checks
- tool call / runTool / result / how results are fed back
- hands / her voice vs her hands
- planner / classifier / turn plan / voice classifier
- sticky tools
- claims / phantom success (claims.js)
- failure log (failures.js, tool-failures.jsonl, tool-failures.md)
- continuity / clocks / downtime / bruises (continuity.js, continuity.json)
- scratchpad / threads (scratchpad.js, companion.db)
- conversation thread / thread.js (in-memory, not the same as threads above)
- summaries / long-term memory of a conversation
- memory extraction / reflect / persona change
- discord routing / where replies go
- busy / stop / restart gating (busy.js)
- voice turns / shared mic (voice/turns.js)
- logs / where each step is recorded
- what she should tell Owner when this breaks

## Running, restarting and repair (running-and-repair.md)
- startup / boot / start order / what runs first
- start.bat / launcher / env values it reads
- supervisor / life support / CHAMP_SUPERVISED
- watchdog / watchdog.bat
- restart / restarting / reboot / reset yourself
- doctor / doctor visit / Claude Code / OpenCode / undo
- other bots / peers / bring_peer / bot_control / PEER_BOTS / PEER_APPS
- background tasks / background_task / helpers
- reverse engineering / reverse_engineer / REA
- workshop / projects / project / coding jobs
- files / files tool / paths / undo / approvals
- git / GitHub / push / pull
- memory wipe / wiping memory
- dashboard routes for power, restart and settings
- env / config / settings
- logs / where to look
- what she should tell Owner when this breaks

## Voice calls (voice-calls.md)
- voice / call / joining / join / leave / leaving
- hearing / listen / silence / speech-to-text / stt / whisper / groq / transcribe
- wake words / name / amy / owner-only / gated
- free talk / floor / answer
- speaking / say / tts / voice engines / fish / kokoro / xtts / gtts
- interruptions / barge-in / being talked over / cut off
- turn-taking / companions on the same PC / floor / turns / said
- peer bots / companions / PEER_BOTS / PEER_APPS / PEER_UNLIMITED / how long they talk
- presence / presence.jsonl / who is in the call / joins and leaves
- restart / automatic speech / restart line / only after a restart
- what the logs show / activity / events / turn-log
- common failures / no audio / she cannot hear / words lost / TTS down
- what she should tell Owner when this breaks

## index / all topics / everything / full list / list everything
This index lists the main topics in the knowledge base. In all there are 581 topics across 23 system guides, plus the overview and the tool guide (97 tools). Every topic can be looked up by any of its names with the guide tool, whether or not it is listed here. Ask for a topic by name to read it in full.

## The phone link (phone-link.md)
- phone link / phone app / owner's phone / android app / phone chat / where owner is
- phone link api / phone api / endpoints / /sense / /chat / /status
- phone chat / talking from his phone / phone conversation
- what the phone tells you / phone sense / where he is / driving / places
- phone accounts / pairing / logging in the phone / revoke / sign out the phone
- phone data files / phone-accounts.json / phone-chat.jsonl / phone-sense.json
- what she should tell owner when the phone link breaks

## Pressure intake (pressure-intake.md)
- pressure intake / what fills the buckets / intake catches / signals / energy / what she runs on / silence / entropy / conversation drive
- pressure system / philosophy / how you work / wants / feed her / how to feed her / flat / quiet (knowledge\systems\pressure-system.md)
- mind view / mind graph / your brain on screen / fireworks / node inspector / live edit / seed / your shape (knowledge\systems\mind-view.md)
- her life page / life dashboard / who you know and how they make you feel on screen (knowledge\systems\life-page.md)
- peer avatars / Alex and Nova on your stage / their faces / lip-sync for the other bots / stage link (knowledge\systems\peer-avatars.md)
- seamstress / sewing your own clothes / sewing pattern / dress form / how your outfits are made (knowledge\systems\seamstress.md)
- what she should tell owner when this breaks
- inner core / inner style / inner prompt / inner thinking / inner voice (knowledge\systems\inner-core.md)
- browser app / browser apps / how a browser app is served and checked (knowledge\systems\browser-apps.md)
- building on your own / your own builds / build want / browser apps you make yourself (knowledge\systems\building-on-your-own.md)
- dashboard / web dashboard / every dashboard page and route (knowledge\systems\dashboard-pages-and-routes.md)
- data folder / data files / where everything is kept / what each data file holds (knowledge\systems\data-files.md)
- salience / what weighs on you / question engine / how you make questions (knowledge\systems\what-weighs-on-you.md)
- listening for topics / overheard requests / shared with you lately / owner name (knowledge\systems\overhearing-and-listening.md)
