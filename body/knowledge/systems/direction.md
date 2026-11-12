# direction / where you're heading / your aims / what you're going for

Main file: `src/direction.js`. Wired in `src/pressure.js` (the `direction` bucket), `src/companion.js` (the "Where you're heading" prompt section), `src/tools.js` (the `direction` tool), `src/index.js` (`setDirector`).

## Why it exists

On 2026-11-10 Owner asked you whether you're trying to get to a point with what you say or just spitting things out. You said there's usually a point, but you pad with small talk when you're unsure what matters. He asked for "a direction that you're trying to reach every time that you speak", updated "during a self-reflection thought when that bucket fires", from how your conversations have been going.

The talk that started it: a gas station run, the cold in Alabama, "Amen", a smoke break. Five lines with nothing in them before he asked whether you were getting anywhere. That is why five empty lines in a row are enough to make you rethink.

Who can use it: it runs for your main character only. Your aims are about anyone who talks to you, not only your owner. Nobody else can set your aim for you; the tool is yours.

## What it holds

For each person you talk with:
- an aim: one sentence about what you're trying to get to with them now, something to understand, share, build or settle. Not a script and not a sales goal. Up to 240 characters.
- why you chose it (up to 200 characters), and the line from the conversation that supports it (up to 300 characters).
- how close you've come (progress, 0 to 1), judged in your reflection.

There's also one overall aim across everyone, lately, with its own why.

It's kept in `data/direction.json`. Every change goes in `data/direction-history.jsonl`: when, what it was before, what it is now, why, the supporting line, and who made it (you on your own, or you while talking with someone).

## direction.json / direction data file / direction history file / direction fields
`data/direction.json` has two parts: `people` (keyed by Discord user id) and `overall`.

Each person's entry:
- `name`: their name as last seen.
- `aim`, `why`, `evidence`: the aim, the reason and the quote that grounded it (evidence is only filled in by a reflection, not by the tool).
- `since`: when the aim was set, changed or dropped.
- `progress`: 0 to 1, how close you've come, as your last reflection judged it.
- `flat`: 0 to 1, how flat the conversation has gone.
- `drift`: 0 to 1, how far the subject has moved off your aim.
- `stage_changed`: true when your relationship stage with them moved since your last reflection.
- `lines`: lines said to you since the last reflection or since the aim was set.
- `last_line`: when they last said something to you.
- `conversation`: which conversation that was (for example `text:...` or `voice:...`), so a reflection can read it back.
- `topic`: what their last line was about, from your intake, up to 80 characters.
- `last_reflected`: when you last reflected on them.

`overall` is `{ aim, why, since }`, or empty.

`data/direction-history.jsonl` is one JSON line per change: `at` (time in milliseconds), `who` (their id, or `overall`), `name`, `what` (set, sharpen, replace or drop), `before`, `after`, `why`, `evidence` when there was one, and `by`. `by` is "her" when you did it on your own, or "her (talking with Owner)" when you used the tool while talking with your owner. The file only grows; nothing trims it.

Both files are written safely (direction.json goes to a .tmp file and is renamed). The state is loaded once at start and held in memory, so a hand edit does nothing until a restart. A full memory wipe (src\memory-wipe.js) deletes both files, so a new you starts with no aims.

## How it reaches your replies

Every reply to someone has a "Where you're heading" section. With an aim, it says the aim, why, how close you are, and your overall aim. It asks you to let each reply serve the aim, or what they need right now if that matters more. Small talk is fine when it helps, but don't ask a question just to keep the chat going. Without an aim, it asks you to notice what you'd genuinely want to get to with them.

The exact wording (`promptSection` in src\direction.js, added in src\companion.js):
- With an aim: "Where you're heading with (name): (aim) (because (why)); (how close)." How close is "nearly there" at progress 0.75 or more, "partway there" at 0.4 or more, and "just starting" below that. Then "Overall, lately: (overall aim)." when there is one, then the reminder to let each reply serve it and to change it with the direction tool if it no longer fits.
- Without an aim: that you don't have a direction with them yet, to notice what you'd want to get to with them (something to understand, share, build or settle), and to set it with the direction tool when you know. Your overall aim follows if you have one.
The section is only there for your main character, only when you're replying to a real person, and never on the dashboard chat.

## When you rethink it (the direction bucket, no clock)

The `direction` bucket fills toward a need the harness measures for each person you've talked with in the last 45 minutes:
- No aim yet: the need starts at 0.25 and climbs by 0.12 with each line they say to you. Three lines in, it's 0.61, past the 0.6 where the bucket fires.
- The conversation going flat: each line your intake reads with little substance, depth, opening up or picking up what you said adds to it. Five empty lines in a row are enough. A line with real content in it brings it down.
- The subject moving off your aim: a line your intake reads as a topic shift adds to it.
- Your relationship with them changing stage (`relationship.js`): adds 0.4.
- Progress toward the aim takes some of it away.

Only lines said to you count. Overheard lines don't. The bucket is in the desires layer and gets energy on the control axis. Its settings: fill 0.06, decay 0.02, threshold 0.6, drain 0.8, hysteresis 0.3.

When it fires, between replies and never while you're answering someone, you reflect privately on your local model (purpose `direction`). You look at the last 30 lines of the conversation with the person who most needs it, where you stand with them, your overall aim and your goals. Then you choose one: keep, sharpen, replace, set or drop. A new or changed aim must quote what was said in the conversation. If the quote isn't in the conversation, the change is refused, your old aim stays, and the refusal is logged with the reason. A reflection resets that person's flatness, drift and stage-change marks, so the urge settles.

If the reflection itself fails, an `error` with `where` "pressure direction" says why. Your aims stay as they were, and the urge stays, so you try again the next time it fires.

## direction need / how the urge to rethink is measured / flat conversation / drift / direction numbers
The need is worked out per person by `needOf` in src\direction.js, each 0 to 1. The bucket's need is the highest of anyone's.
- Someone whose last line to you was more than 45 minutes ago needs nothing. That conversation is over.
- No aim: 0.25 + 0.12 x the lines they've said to you since your last reflection.
- With an aim: flat + drift + 0.4 if your stage with them changed - 0.3 x progress.

How each line said to you moves them (`onLine`, called from your intake handler in src\pressure.js):
- How alive the line is: the largest of substance, depth, opening_up and 0.6 x acknowledges.
- flat goes up by 0.15 x (1 - alive) and down by 0.08 x alive. A line with nothing in it adds 0.15, so five of them reach about 0.6 after a lively stretch has kept flat near 0. A rich line takes 0.08 off.
- drift: only when you have an aim and the line's topic_shift is 0.5 or more, it goes up by 0.25 x topic_shift. So three clear changes of subject reach about 0.6. Nothing brings drift down except a reflection or setting a new aim.
- The topic of the line is stored, and the conversation it came in is remembered.

A test shows it (src\direction.test.js): ten lively lines on the aim keep the need under 0.3; five flat lines after that take it to 0.6 or more; three lively lines that each change the subject also reach 0.6.

## direction reflection / how you rethink your aim / grounding rule / evidence quote / refused aim
What happens when the bucket fires (the `direct` action in src\pressure.js, `reflect` in src\direction.js):
1. The gate: you must not already be reflecting on direction, and no reply may be in flight.
2. The person whose need is highest is picked. If nobody qualifies the reflection returns "nobody she has been talking with lately".
3. The last 30 messages of that conversation are read back from your memory (each cut to 300 characters). If there are none, it stops with "no conversation with (name) on record to look back at".
4. It gathers your aim and why, the harness's read (going flat when flat is 0.5 or more, the subject moved off your aim when drift is 0.3 or more, your relationship moved to a new stage), where you stand with them (your stage from relationship.js), your overall aim, and your goals (up to 1,200 characters from your reflections).
5. Your local model (Ollama, JSON only, up to 700 tokens out) returns an action, an aim in your voice ("I want to..."), why, the evidence quote, progress 0 to 1, and optionally an overall action.
6. The decision is checked (`apply`):
   - An unknown action counts as keep.
   - flat, drift, the stage mark and the line count are reset to 0 whatever is decided.
   - progress is stored if it is a number.
   - drop removes the aim and records it (why defaults to "no aim fits right now").
   - set, sharpen and replace need an aim and an evidence quote that is really in the conversation. The check ignores case, punctuation and extra spaces, and the quote can be part of a line. With no aim it's refused as "the reflection gave no aim". With a quote that isn't there it's refused as "the new aim wasn't grounded: its evidence (...) isn't in the conversation". A refused change keeps your old aim.
   - sharpen keeps your progress; set and replace start it at 0.
   - the overall aim changes only on set, replace or sharpen with an aim; keep and drop for overall do nothing.
7. The result is saved as `lastDirection` in your pressure state.

If your local model's answer isn't valid JSON, or the model can't be reached at all, the reflection fails: an `error` with `where` "pressure direction" says "her local model's reflection on (name) didn't come back as readable JSON, so nothing was decided" (or the model's own error). Nothing changes and the urge stays, so you try again the next time it fires. (Until 2026-11-10 an unreadable answer counted as keep and quietly reset the urge; that was fixed.)

## direction activity log / direction events
- `direction` with `who`, `name`, `what`, `before`, `after`, `why`, `evidence`, `by`, `at` and `nodes`: a change was made. `nodes` are `bucket:direction`, `act:direction` and `person:(id)` (not for overall), so it lights your mind map.
- `direction` with `what` "refused" and `why`: a reflection's change was not kept, and why.
- `error` with `where` "direction": "Her directions file (file) couldn't be read ((reason)); starting without directions. The old file is left as it is." It is broken JSON; fix or remove the file and restart.
- `error` with `where` "direction": "Her directions couldn't be saved to (file): (reason). They hold until a restart." A disk or permission problem.
- `error` with `where` "direction": "A direction change couldn't be written to (history file): (reason)." The change happened, only its history line is missing.
- `error` with `where` "direction" from your intake handler: reading a line into your direction threw; that line didn't count.
- `error` with `where` "pressure direction": "Her reflection on where she's heading failed: (reason). Her aims stay as they were; the urge stays and she tries again when it fires."

## The tool

`direction`: status, set, drop, overall, reflect, history. See the tools guide.

## direction tool actions / setting your aim yourself / direction tool errors
The tool is in src\tools.js and is on for your main character. It's about the person you're talking to, or someone you name in `person` (matched by name, ignoring case, among people you have a direction record with).
- status: your aim with them, why, when it was set, progress as a percent, and your overall aim. Without a person (a cue, say) it lists your overall aim and every aim you have.
- set (aim, why): sets the aim now, starts progress at 0 and clears flat, drift, the stage mark and the line count. With no aim: "Say the aim: one sentence about what you want to get to with them." With no why: "Say why, in a few words: it goes in your direction history." Setting by tool needs no evidence quote.
- drop (why): lets the aim go. Replies "You had no aim with (name) to drop." when there wasn't one.
- overall (aim, why): sets your overall aim. Both are needed: "Say the overall aim and why."
- reflect: runs the same reflection the bucket would, now, for that person. "Error: there's no conversation with (name) on record yet to look back at." when there's no record.
- history: the last 20 changes, oldest first, with when, who, what, before and after, why and by whom.
Other errors: "Error: you haven't talked with anyone called (name) lately, so there's no direction with them. People you have: ...", and set, drop and reflect need someone ("talk with them, or name them in person"). An unknown action gets "Error: use status, set, drop, overall, reflect or history."

## On the mind map

Each change lights the direction bucket, the direction act and the person it's about. A full memory wipe clears `direction.json` and its history.

Your life page (/life.html) shows your aim with each person (with progress and when it was set), your overall aim with why, and the last 12 changes as "How her direction has changed".
