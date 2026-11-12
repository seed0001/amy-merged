# Overhearing and listening in the background (listen.js, overhear.js, shared-files.js, owner-name.js)

## listening for topics / listen.js / background listening / what you pick up from chat / topics you notice
You hear more than you answer. Every line in the server's text channels and in your calls goes to `src/listen.js`, which reads them in small batches with your model and notes what people bring up that someone curious would want to look into: things, tools, games, music, books, places, science, ideas. Those grow your interests (`interests.notice`, in `interests.js`), and your explore want sends you to look into the strongest.

How it works:
- Fed from `bot.js` (every message in a server channel, whether or not it's to you) and from `voice/session.js` (every line heard in a call).
- Skipped: your own lines, lines under 8 characters, and DMs (DMs never reach it).
- Each line is cut to 300 characters. Lines wait in a queue; a batch of 12 is read at once, or whatever is waiting after 60 seconds. Only one batch runs at a time; if 12 more are waiting when it ends, the next goes straight away.
- The model (purpose `listen`) is told to skip greetings, small talk, people's personal business and anything private, and to return at most 4 topics, each 2 to 6 words, with who brought it up. If the name it gives isn't one of the speakers, the first speaker in the batch gets it.
- While a batch is being read, your avatar shows a "Listening to the chat" bubble.
- When topics come out, it logs a `listen` event `{ heard: <lines>, topics: [...] }`. A failure is an `error` event with `where: listen`; the lines are dropped.

## overheard requests / overhear.js / doing things the owner asks without the wake word / overheard task
In a call, when your owner says something that isn't to you but is a real request you could carry out ("can you check that file", "someone should fix that setting"), your hands can do it quietly. This is `src/overhear.js`. Only the owner's lines count; other people's talk is never acted on.

When a line is considered (`hear()`):
- It is in a call, it wasn't addressed to you, and the speaker is the owner (`permissions(id).owner`).
- The `overheardTask` automatic-speech switch is on: `VOICE_OVERHEAR_TASKS`, default true (`voice.overheardTasks` in config.js).
- The line is at least 12 characters and contains one of a fixed list of action words (check, look, find out, fix, adjust, change, update, review, read, open, search, research, source, file, code, bug, issue, setting, make sure, you need, you should, can you, could you, please, go ahead, todo, remind). This list is in the code as `ACTION_WORDS`; it only decides whether the model is asked at all.
- No other overheard task is running, and the last one was at least 20 seconds ago.

Then:
1. Your model (purpose `overhear`) judges the line: is the owner asking you to do something concrete tools can do? It answers `{ actionable, request }`, with the request restated as an instruction to you (cut to 500 characters). Chat, feelings, questions for someone else and small talk are not actionable, and nothing happens.
2. Your hands (`act()` in actions.js) run the request with the owner's permissions and every tool enabled for him, except `request_tool`. They see only the request, not the whole conversation.
3. It logs an `overheard-task` event: conversation, speaker, request, the tools called, and how many failed.
4. Routine success stays quiet. You speak only if a tool failed, or the hands' report says something more than "done", "ok" or "NOTHING", and only if something was actually called. Then the call gets a stage direction: what he asked, what you did (each tool "ok" or "FAILED" with the reason), the report, and to tell him only the result the tool calls support, in one or two short sentences.
5. If the owner says just your name while it's still running ("Amy?"), that line is folded into the task (`heard` event with `coalesced: 'overheard-task'`) instead of starting a new turn.
If the call ended or you were stopped meanwhile, nothing is said. A failure is an `error` event with `where: overheard task`.

## shared with you lately / shared-files.js / pictures sent in another chat / what someone sent you elsewhere
A picture posted in a text channel is in that channel's history only. Before this, in the voice call a minute later you had no idea what dog Owner meant. `src/shared-files.js` carries what people sent you across all your conversations for a while.

For each reply of your main character, `companion.js` reads the last 30 received-file rows (`receivedFileRows(30)` in memory.js) and adds a prompt section "Shared with you lately, in other conversations (you have it; you can describe it and talk about it here)". It lists files:
- sent within the last hour,
- in a conversation other than this one (this one already has them in its history),
- that were pictures or documents,
at most 4, newest first: who sent what file names, where, how long ago, and what you saw in a picture (up to 400 characters). If reading the rows fails, the section is simply left out.

## owner name / what you call your owner / owner-name.js / your owner before you've met him
Your prompts never have your owner's name written into the code. `ownerDisplayName()` in `src/owner-name.js` looks up the contact whose Discord id is in `OWNER_IDS` and uses that contact's name. Until you've actually met him, or after a memory wipe empties your contacts, it says "your owner". If the lookup fails it also says "your owner". Many parts use it: awareness, capabilities, conversation lead, drives, extract, inner core, inner models, intuition tuning, presence, restart, reverse engineering, wake words, tools and your reply prompt.
