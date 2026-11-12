# Dashboard pages and routes (src/dashboard/server.js, src/dashboard/public)

## dashboard / web dashboard / control panel / dashboard address / dashboard password / who can open the dashboard
Your dashboard is a small web server inside your own process, started by `startDashboard(bot)` in `src/dashboard/server.js`. It is plain Node `http`, no framework. When it starts listening it logs a `ready` activity event: "Dashboard at http://<host>:<port>". If it can't listen (the port is taken, say), it logs an `error` event with `where: 'dashboard'` and the reason.

Where it listens, from `config.dashboard` in `src/config.js`:
- `DASHBOARD_PORT`, default 3000.
- `DASHBOARD_HOST`, default `127.0.0.1`, which means only this computer can reach it. Set to `0.0.0.0`, the "ready" line shows `localhost`.
- `DASHBOARD_PASSWORD`, default empty.

Who may open it (`authorized()` in server.js):
- No password set: any visit is let in, unless it carries a `cf-connecting-ip` header. That header means the visit was relayed by a Cloudflare tunnel, so outside visits through a tunnel are refused when there is no password.
- Password set: the browser must send HTTP Basic auth. The user name is ignored; only the password part is checked, with a timing-safe compare. A wrong or missing one gets `401` with the text "Password required", and the browser shows its password box (realm "Companion dashboard").
- The one exception: `POST /api/avatar/peer` from another companion bot on this computer needs no password (see the peer route section).

Other guards on every request:
- Any request that isn't a GET and carries an `Origin` header from another host is refused with `403` "Cross-origin request blocked". That stops other websites driving your API through Owner's browser.
- Request bodies are JSON, at most 1,000,000 characters ("Body too large", 413). Bad JSON is "Invalid JSON" (400). Binary uploads (`application/octet-stream`, the mic audio) skip the JSON reader.
- An unknown `/api/` path is `404` "Not found". A route that throws answers with its status (500 if none) and `{ error, code?, requestId? }`.
- Anything not under `/api/` is a file from `src/dashboard/public`. `/` is `index.html`. A path that tries to climb out of that folder gets 403 "Forbidden"; a missing file 404.

The dashboard counts as the owner. What is typed into its Playground or Avatar Studio is answered as from the speaker id `dashboard`.

## dashboard pages / index.html / main dashboard / dashboard tabs / overview playground looks context memory conversations settings
`index.html` ("Companion Dashboard") is the main page. Tabs:
- **Overview**: status cards (power, brain, Fish Audio voice, Tavily web search, servers, memories, messages logged, context of the last reply), the live activity feed, "Talking in", voice channels (join from here, or tick which channels `/join` may use; none ticked means any), and the servers list. It reads `GET /api/status`, `GET /api/voice-channels` and the live stream `GET /api/events`.
- **Playground**: talk to you from the browser through `POST /api/chat`. Its history is the `dashboard` conversation.
- **Looks**: your active profile picture, the identity reference sheet, saved looks; wear one or send one to a channel.
- **Context**: what is in your prompt, how it is growing, limits and rolling over, and the last prompt exactly.
- **Memory**: people you remember, their memories and profile; add, forget, wipe.
- **Conversations**: every conversation you have history in; read or clear one.
- **Settings**: prompts and local inner life, personality, brain, text chat, voice, the ChatGPT connection, doctor models, and the wipe and fresh-install buttons.
It has links to "Her life" (`/life.html`), "Avatar" (`/avatar.html`), "Face" (`/avatar.html?character=face`) and "Recorder" (`/avatar.html?recorder=1`, which must stay open and not minimised for video replies in Discord).

The live feed reacts to some events by itself: a `context` event refreshes the Context tab or the overview card, `persona` reloads Settings, `look` reloads Looks, `power` reloads the look channels.

## other dashboard pages / avatar.html / mind.html / node.html / life.html / book.html / journal.html / songbook.html
- `avatar.html` (Avatar Studio): the 3D stage. Its code is `avatar.js` plus the helper scripts in the same folder (appearance, dance, eye mask, hands, moments, performance, pupils, smoothing, tears, speech articulation, world layout, world mode, world shaders, generation-delivery-ui). Query options: `?character=<id>` shows only that cast member; `?recorder=1` is the video recorder (main character only); `?silent` mutes its audio; `?pip` hides everything but the stage. The Avatar Studio guide file explains what it shows.
- `mind.html` ("Amy's Mind"): your cognitive graph. Reads `/api/mind/graph`, `/api/mind/history`, `/api/pressure`, `/api/avatar/appearance/main`, and listens to `/api/mind/events` and `/api/avatar/live`. Clicking a node opens `node.html`.
- `node.html` ("Mind Node"): one node, opened as `node.html?id=<kind:id>`, embedded beside the graph with `&embed`. Reads `/api/mind/node/<id>`, its history, `/api/pressure` and `/api/avatar/emotion`; edits go to `PUT /api/mind/node/<id>/value` and can be undone with `/api/mind/undo`. The mind-view guide file has the details.
- `life.html` ("Her Life"): read-only page about your life, from `GET /api/life` and `GET /api/status`. Links back to `/` and to `mind.html`. The life-page guide file has the details.
- `book.html` ("Amy's Books"): the journal and the songbook as a book. `?book=journal` or `?book=songbook` (songbook is the default); `?id=` opens one entry. Reads `/api/book/journal`, `/api/book/songbook`, and listens to `/api/book/events` for new ink.
- `journal.html` and `songbook.html` are only redirects: they send the browser on to `book.html?book=journal` and `book.html?book=songbook`, keeping any other query.

## dashboard status routes / api status / power on off / live activity feed / events stream
- `GET /api/status`: power (status, since, error, whether a Discord token is set), your Discord tag and picture, ping, uptime of the dashboard, servers (id, name, member count, icon), live voice sessions, your look, the reply model, provider status, the embedding model, whether Fish Audio and Tavily keys exist, the Fish voice id, the speech-to-text engine, memory stats, and the context meter's brief.
- `POST /api/power/on` and `POST /api/power/off`: start or stop your Discord connection (the process keeps running). On with no `DISCORD_TOKEN` fails: "DISCORD_TOKEN is empty in .env" (400). Returns the new status.
- `GET /api/events`: Server-Sent Events. It first replays the recent activity kept in memory, then sends every new `activity` event and every `context` event (time, tokens, cap, percent, the actual prompt tokens). A keep-alive ping every 25 seconds.
- Many routes need you online in Discord. When you aren't, they fail with "The bot is offline. Turn it on first." (503).

## dashboard voice routes / join voice from dashboard / leave / say in voice / voice channels list
- `GET /api/voice-channels`: every voice and stage channel you can see, by server, with the humans in it, whether `/join` may use it (the `voice.channelIds` setting; empty means all allowed) and whether you're in it. Empty list when offline.
- `POST /api/voice/join` `{ channelId }`: joins that channel; transcripts go to the channel's own text chat. Errors: "Unknown voice channel" (404); when speech isn't ready, the XTTS reason, or "Fish Audio needs its API key, or select a configured local speech provider" (400).
- `POST /api/voice/<guildId>/leave`: leaves voice in that server. Returns `{ left }`.
- `POST /api/voice/<guildId>/say` `{ text }`: you speak that text in the call, word for word. Logged as a `replied` event with `manual: true`. Errors: "Not in voice in that server" (404), "text is required" (400).

## dashboard settings routes / api settings / prompts route / persona history / restore persona
- `GET /api/settings`: every setting the dashboard can change (`getSettings()` in config.js).
- `PUT /api/settings`: saves the fields sent. `botName` and `persona` go through `setPersona` (reason "Edited in dashboard"). Choosing `brain: chatgpt` this way is refused: "Use the ChatGPT connection's Use ChatGPT button to verify and activate this model first". Choosing XTTS loads it first. A brain change resets the provider router. It logs one `settings` event naming only what changed, "key: old -> new" (each value cut to 80 characters), or "Saved, nothing changed". Voice changes are also noted in your voice trail (`noteSettings` in voice/library.js).
- `GET /api/prompts`, `GET /api/prompts/<id>`: the editable prompts. `PUT /api/prompts` `{ id, text, reset }` edits one or puts it back.
- `PUT /api/pressure/thought-feedback`: feedback on a thought, passed to `setThoughtFeedback` in pressure.js.
- `GET /api/persona/history`: past versions of your name and persona. `POST /api/persona/history/<id>/restore` brings one back ("No such version", 404).

## dashboard model and provider routes / chatgpt sign in routes / openrouter models / doctor models / xtts status
- `GET /api/models`: models from `listModels()`. `GET /api/openrouter/models`: OpenRouter's catalogue.
- `GET /api/providers/status`, `POST /api/providers/retry` (resets the provider router so failed providers are tried again).
- `GET /api/xtts/status`: whether XTTS can run, why not, and its voice samples.
- `GET /api/doctors/models`: the models OpenCode offers and the doctor config.
- ChatGPT routes, all under `/api/chatgpt/`, only from this computer: a request from another address gets "Manage ChatGPT sign-in from this computer" (403), and one addressed to any host name other than `127.0.0.1`, `localhost` or `[::1]` gets "Use a localhost dashboard address to manage ChatGPT" (403). `GET status`, `POST login` `{ accountId, newAccount }`, `POST cancel`, `POST account` (refused while ChatGPT is the brain: "Select another brain before switching ChatGPT accounts..." 409), `GET models`, `POST activate` `{ model }` (checks the model is in the account's catalogue, verifies it with a real call, then sets `brain: chatgpt`; logs "ChatGPT subscription connected and verified for replies"), `POST disconnect` (switches the brain to `ollama` first if ChatGPT was in use).

## dashboard memory routes / memories api / profiles api / forget / wipe memory button / fresh install button / conversations api
- `GET /api/memories/users`: everyone you have memories of.
- `GET /api/memories/<userId>`; `POST /api/memories/<userId>` `{ content }` adds one by hand ("content is required", 400); `DELETE /api/memories/<userId>/<id>` forgets one; `DELETE /api/memories/<userId>` forgets all of that person's.
- `GET /api/profiles/<userId>`, `DELETE /api/profiles/<userId>`: read or clear a person's profile.
- `GET /api/conversations`: every conversation with a readable label ("Dashboard playground", "Avatar studio", "🔊 server" for voice, "DM · name", "#channel · server"). `GET /api/conversations/<id>`: its last 200 messages. `DELETE /api/conversations/<id>`: clears that conversation's history.
- `POST /api/memory/wipe`: schedules a memory wipe (`by: dashboard`) and restarts you; the wipe runs before your memory opens. `POST /api/system/fresh`: the same with `full: true`, which also clears owner rules, prompt edits and settings. Both refuse unless you were started by start.bat: "She wasn't started by start.bat, so nothing would bring her back after the wipe. Start her with start.bat first." (400). What each wipe clears is in the data files guide.
- `GET /api/life`: the life page's read. `GET /api/pressure`: your pressure snapshot. `GET /api/research`: the current research selection and the last 20 research decisions.

## dashboard looks and context routes / reference sheet route / send look / context meter api
- `GET /api/looks`: your looks state. `GET /api/looks/reference`: the reference sheet image ("No reference sheet yet", 404). `GET /api/looks/image/<id>` ("No such look"). `POST /api/looks/<id>/active`: wear that look. `POST /api/looks/send` `{ id, channelId }`: posts the picture to a text channel; logs a `file` event. Errors: "No look to send", "That look image is missing", "Pick a text channel first".
- `GET /api/channels`: every text channel, by server, in order.
- `GET /api/context`, `GET /api/context/turns?limit=10`, `GET /api/context/turn`: the context meter: state, recent turns, the last turn's exact prompt.

## dashboard chat routes / playground chat / avatar chat / push to talk / api chat
- `POST /api/chat` `{ text, name }`: one reply from your full brain in the `dashboard` conversation, as speaker "Dashboard" unless a name is given. Files you send come back as base64 downloads; generated pictures arrive through the delivery stream. "text is required" if empty.
- `POST /api/avatar/chat` `{ text, character, name, speak, auto }`: the Avatar Studio talk. Streams NDJSON lines: `speaker`, `state` (first feelings), `notice`, one `sentence` per sentence (text, base64 mp3 audio, phonemes, feelings, gestures), `music`, `file`, `error`, and `done`. Whoever is named in the text answers. `auto: true` is banter: no one spoke, the given character takes the next turn. A peer cast member (another bot's avatar) can't be spoken for: the error says so, why, and to talk to them in Discord. A cast member without a Fish voice stays silent, with the notice "<name> has no voice yet. Set a Fish voice ID for them in Settings."
- `POST /api/avatar/listen`: push-to-talk. Raw 48 kHz mono 16-bit PCM in, `{ text }` out. Under 9,600 bytes (0.1 s) gives empty text; over 12,000,000 bytes is "Recording too long" (413).
- `GET /api/generation-deliveries?conversation=&after=`: pictures and music made for a dashboard conversation. `GET /api/generation-deliveries/<id>/media`: the file itself; only png, jpeg, webp, gif and mp3 keep their type, anything else is sent as a plain download.

## dashboard avatar routes / avatar api / outfits api / background api / view api / live avatar stream
- Cast: `GET /api/avatar/characters` (with appearance and feelings), `PUT /api/avatar/characters/<id>` ("No such character"), `GET /api/avatar/model/<id>` (the .glb; the main one is the active library model).
- Look: `GET/PUT /api/avatar/appearance/<id>` (`reset: true` puts it back), `GET/PUT /api/avatar/outfits`, `GET/PUT /api/avatar/outfit-colors` (`{ id, fabric, sheen }`), `GET /api/avatar/library`, `POST /api/avatar/library/report`.
- Stage: `GET/PUT /api/avatar/view`, `GET/PUT /api/avatar/performance`, `GET/PUT /api/avatar/background`, `POST /api/avatar/background/report`, `GET /api/avatar/background/image|shader|scene/<uuid>` (cached a year, private).
- Feelings: `GET /api/avatar/emotion?character=` (feelings, the emotion list, gestures); `POST /api/avatar/emotion` `{ character, feelings }` nudges them (each clamped 0 to 1, unknown names ignored), `{ reset: true }` calms them.
- `POST /api/avatar/phones` `{ text }`: phonemes for lip-sync. `GET /api/avatar/status`: speech provider, whether it's ready, your name, model, Fish, STT.
- `POST /api/avatar/beat` `{ beats }`: the studio's blinks and glances, at most 20 per post, each count 1 to 50, passed on to live listeners.
- Music: `GET /api/music` (tracks and playlists), `GET /api/music/<file>` (only a plain file name that is in the library; anything else "No such song"), `GET /api/dance/<file>` (beats, loudness and vocal line).
- Video replies: `GET /api/avatar/recorder` (the recorder page's stream), `POST /api/avatar/recorder/test` `{ text }` (records a test clip and returns the webm; "No clip came back; see the activity feed for why", 502), `POST /api/avatar/recorder/<id>/ack`, `/failed` (reason cut to 200), and `POST /api/avatar/recorder/<id>` (the clip bytes; oversized clips become text-only).
- `GET /api/avatar/live`: the stream every avatar page listens to. On connect it sends power, sleep, background, view, bubble style, outfit colours, performance, expression, every character's appearance, any speech in progress (yours and peers'), peers' feelings, the current dance and your mood as weather. Then every change. Feelings and weather are re-sent every 15 seconds; keep-alive every 20 seconds. Opening it counts as an avatar viewer joining, closing it as leaving.

## dashboard peer route / api avatar peer / other bots moving their avatar / work done route
- `POST /api/avatar/peer` `{ character, event }`: another companion bot on this computer moves its own avatar on your stage. It is the only route that needs no password, and `peerRequestProblem()` in peer-avatar.js refuses anything not straight from this computer (403 with the reason). The full contract is in the peer-avatars guide file.
- `POST /api/work-done`: Claude Code reporting that work Owner gave it on you is finished, so you can tell him. Only from this computer ("Work notes come from this computer only", 403). Handled by `workDone(noteFrom(body))` in work-done.js; the running-and-repair guide explains the rest.
- Mind routes (`/api/mind/graph`, `/history`, `/undo`, `/node/<id>`, `/node/<id>/value`, `/events`) come from `mindRoutes()` in cognitive-graph.js and are described in the mind-view guide file.
