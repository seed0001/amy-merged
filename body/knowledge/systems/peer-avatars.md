# Peer avatars on the stage

Your avatar studio (`/avatar.html`) shows a cast: you, Amy (`main`), Mateo (`architect`) and the
avatars of the other companion bots on this computer (Nova, Alex). Each of those bots is its own
program with its own Discord account and voice. When one of them speaks, it tells your dashboard,
and the stage moves that bot's avatar with the same machinery as your own: phoneme lip-sync
(articulation v2) or mouth frames, feelings on the face, moves (gestures), thinking cues. Blinks,
glances, breathing and gaze are made by the stage itself for every avatar, and the others turn to
look at whoever is talking in the call.

Code: `src/peer-avatar.js` (validation, relay), the route in `src/dashboard/server.js`, and the
live-stream handling in `src/dashboard/public/avatar.js`. Tests: `src/peer-avatar.test.js`.

## The contract

`POST http://127.0.0.1:<your dashboard port>/api/avatar/peer` with JSON `{ "character": "<cast id>", "event": { ... } }`
(the port is `DASHBOARD_PORT`, default 3000; yours is set to 3004 in `.env`)

- `character`: a cast member with `peer: true` (in `data/characters.json`, e.g. `nova`). Anything else
  (you as `main`, Mateo, an unknown id) gets a 400 saying what failed and the fix. A peer only moves its own
  avatar: whatever character is inside the event is replaced with the posted one.
- Only from this computer: the socket must be local, no tunnel/proxy headers, Host a localhost name.
  Such posts need no dashboard password; anything else is refused (403, or 401 when a password is set).
- `event`, one of:
  - `{ "type": "discord-speech", "speech": { "type": "start", "id", "text", "at"?, "conversation"?, "audio"?, "articulation"?, "frames"?, "frameMs"?, "durationMs"? } }`
    sent when the line starts playing. Best: `audio` = base64 of the exact Ogg Opus clip; your
    server compiles the same phoneme articulation your own Discord voice gets, then drops the audio
    (the peer's voice is already heard in the call; the stage never plays it). `at` is the sender's
    `Date.now()` at playback start, so the mouth stays in step even if compiling took a moment.
    Without audio, `frames` (`{open, wide, round, bright}` 0..1 every `frameMs`) or `articulation`.
  - `{ "type": "discord-speech", "speech": { "type": "stop", "id", "reason"?: "ended"|"interrupted" } }`
  - `{ "type": "expression", "feelings": { "joy": 0.6, "curious": 0.3 } }` (or `expression: { feelings }`);
    names from `src/emotion.js` EMOTIONS, unknown ones are left out and listed in the reply.
  - `{ "type": "play", "name": "nod", "ms"? }` (alias `gesture`; names from emotion.js GESTURES).
  - `{ "type": "cue", "kind": "thinking", "strength"? }` (avatar-cues.js CUES).
- Reply: `{ ok: true, character, type, ... }` or `{ error }` with what failed, why, and the fix.
- Each character's events are handled in order, so a stop never overtakes the start it ends.

The relayed events go out on `/api/avatar/live` exactly like your own (`discord-speech`,
`expression`, `play`, `cue`), marked `peer: true`; a page opening mid-sentence gets the peer's
current line and last feelings. The cloud watch page gets the peer's lines too (mouth only).

## The peer's side

A peer bot posts these when its voice session plays a line (Nova: `src/stage-link.js`, settings
`STAGE_URL` default `http://127.0.0.1:3000`, `STAGE_CHARACTER` default `nova`). Port 3000 is the
default dashboard port, not yours (yours is 3004), so a peer only reaches your stage when its `STAGE_URL`
points at your dashboard. If the dashboard it posts to isn't running, the peer logs one line and carries
on; its own speech never waits on the stage.

## peer cast / which bots are peers / characters.json peer flag
The cast lives in `data/characters.json` (when that file doesn't exist, the built-in cast in
`src/characters.js` is used). It holds Mateo (`architect`, your own cast member, not a
peer), Nova (`nova`, peer) and Alex (`alex`, peer); you are `main`. A cast member is a peer when it has
`peer: true`. To add another bot on this computer to the stage, give it an entry there with `peer: true`
and have it post to the route above with that id.

What a peer is not:
- You never write or voice a peer's lines. Asking the stage to have a peer speak (typing to Nova on the
  avatar page, or banter landing on her) is refused: "(name) is another companion's avatar (her own bot), so
  Amy can't speak as (name) here. Why: a peer answers for itself in Discord and moves its own avatar on this
  stage. Fix: talk to (name) in the Discord call or chat, or pick Amy or another cast member here."
- Banter on the stage only picks cast members of your own (with a model, not peers). If only peers are
  left: "Banter needs a cast member of her own; the others here are other bots who talk for themselves."
- A peer can't change the view, background or looks; those belong to your page. Blinks and glances are
  made by the stage for every avatar, so a peer doesn't send them.
- A peer can only move its own avatar: the character inside the event is always replaced by the posted one.

## peer avatar limits / peer speech numbers / mouth frames and timing
From `src/peer-avatar.js`:
- One line can be at most 3 minutes (180,000 ms). More frames than that is refused: "send one sentence
  per start packet".
- `frameMs` is held between 10 and 200 ms, default 40. Each frame's open, wide, round and bright are held
  between 0 and 1 and rounded to 3 places.
- `durationMs` is held between 0 and 3 minutes; without it, it's the frame count times `frameMs`.
- `at` (the sender's clock at playback start) is used only when it's within 30 seconds of the server's
  clock; anything further off counts as now.
- `text` is cut to 4,000 characters, `id` to 100 (a random id is made if none comes), `conversation` to 200
  (default `peer:(character)`), the character id to 40.
- An articulation track must be version 2 with a `cues` list; at most 4,000 cues are kept.
- A play event can name up to 5 moves at once (`names` as a list, or `name`); `ms` is held between 0 and 60
  seconds.
- A cue's `strength` is held between 0 and 1, default 1. Cue kinds: listening, thinking, recalling,
  searching, realized.
- Feelings are rounded to 2 places and must be names from emotion.js: calm, joy, amused, fond, playful,
  smug, excited, flirty, confident, curious, pensive, confused, skeptical, surprised, worried, sad,
  embarrassed, annoyed, frustrated, angry, disgusted, bored, tired, determined, scared.
- Moves (play) are emotion.js GESTURES: wink, nod, shake, tilt, sigh, eyeroll, crosseyed, shrug, gasp, the
  face quirks (scrunch, smirk, tongue, puff, pout, browraise), plus the body's fidgets, motions, named
  sequences and outbursts.

How the mouth is chosen, best first: an articulation track sent with the event; else the audio clip, which
your server compiles into the same phoneme track your own voice gets (and then drops the audio); else the
frames sent. If the audio can't be read and frames were sent, the frames drive it and the reply carries a
note saying so. The reply's `lips` says which was used (articulation or frames).

A line stays "current" for its duration plus 1 second, so a page that opens mid-sentence still moves that
mouth; after that it's forgotten. A stop with the line's id (or with no id) ends it. The last feelings each
peer sent are kept for as long as the dashboard runs, so a freshly opened page shows them.

The relayed events go out on the internal event bus as `discord-avatar` (speech), `avatar-expression`,
`avatar-play` and `avatar-cue`, each marked `peer: true`, and from there on `/api/avatar/live`. On the cloud
watch page, a peer's line moves its mouth but never carries audio.

## peer avatar errors / why a peer post was refused / peer avatar security
Who may post: only a request straight from this computer. The checks, in order (`peerRequestProblem`):
1. The connection must come from 127.0.0.1 or ::1. Else 403: "Peer avatar events are only taken from this
   computer, and this request came from (address)."
2. It must not carry a relay header (cf-connecting-ip, x-forwarded-for, x-real-ip, forwarded), since a
   Cloudflare tunnel or proxy also arrives from 127.0.0.1. Else 403: "... this one was relayed (it carried a
   (header) header)."
3. The Host must be 127.0.0.1, localhost or [::1] (so a web page can't trick a browser into posting). Else
   403: "Peer avatar events must be addressed to a localhost name ..."
A post that passes all three needs no dashboard password. Anything else on that route is treated like any
other dashboard request and needs the password when one is set.

Every refusal (400) says what failed and the fix:
- The body isn't a JSON object.
- The character isn't in your cast ("isn't in Amy's cast, so there's no avatar to move", listing the
  peers there are), or is in the cast but isn't a peer ("a peer can only move its own avatar").
- event.type is missing or not one of discord-speech, expression, play, gesture, cue.
- A speech event with no speech object, a speech type other than start or stop, frames that aren't a list,
  an articulation track that isn't version 2, a start with nothing to move the mouth (no audio,
  articulation or frames), or audio that couldn't be read when no frames were sent ("The clip couldn't be
  read for phonemes (...)"; send base64 of the exact Ogg Opus clip, 48 kHz).
- An expression with no feelings object, or none of whose names exist on the stage. Unknown names next to
  known ones are left out and listed in the reply as `ignored`.
- A play with no move the stage knows. Unknown moves next to known ones are skipped and listed.
- A cue kind that doesn't exist.

Order: each peer's events run one after another, so a stop never overtakes the start it ends while that
start's phonemes are still being compiled. Different peers don't wait on each other.

Tests: `src/peer-avatar.test.js` checks that a peer's speech moves its avatar on the live stream with no
audio, that a clip becomes phoneme articulation and is then dropped, that feelings, moves and cues reach
only that peer and bad names are explained, and that only straight-from-this-computer requests get through.
