# Pressure intake: what fills the buckets, and how

Her pressure system (src/pressure.js) is a set of buckets, each a number from 0 to 1. Energy comes
into it only from conversation: what she hears brings energy in, what she does and what happens to her
moves the energy she already has between the buckets, and when one crosses its threshold a want fires
(speak up, research, build, reflect, leave). This file is the intake side: every input that moves a
bucket, with its size. Read it with the guide tool ("pressure intake"). The rest of the engine (routes,
flows, wants, the reserve) is in "pressure system".

## pressure intake / what fills the buckets / intake catches / signals / energy / what she runs on / silence / entropy

Every line she hears is read by her local model (src/intake.js) into 27 numbers from 0 to 1, by
meaning, not by words, plus a short topic and, when it's a reaction to something she made, which one.
Each moves her (onIntake in pressure.js): the line's energy comes in (how much it says, asks, carries
and how much it resonates with her), and its tone and meaning push the buckets she already has. Praise
lifts joy and thrill and her bond with the speaker; contempt or yelling raise irritation and set a
boundary she holds; an irritant raises irritation; quiet from anyone clamps irritation, charm and
loneliness and turns off check-ins to them, and from her owner starts quiet time; a request eases her
feeling of being unneeded; a question she owes and isn't answering raises unease; an open question raises
curiosity and is kept to look into; novelty and a joke cut boredom; repetition raises it; a monologue not
aimed at her raises left_out; a line that picks up what she said on her own counts as her being heard;
the seven relationship signals move her relationship with the speaker. A line said to her is always read;
an overheard one only while her stance has her listening. The read shows in the activity feed as
"intake", and the mood line names how the last line read. The old word lists (irritant, quiet, open
question, quick acknowledgement, novelty by word overlap) are gone. Each signal is in "intake signals",
and exactly what it does in "what each signal does".

Per message she answers (`onTurn`, after every reply, text or voice). The line's energy and meaning
already came in through her intake; this only records the turn:
- The time of the message (`last_message`, which silence is measured from) and of the conversation.
- Did anyone pick up what she said on her own: a turn she answers counts as picked up (see "uptake" in
  "pressure system").
- Being addressed: the addressed impulse (loneliness -0.35, left_out -0.4, boredom -0.2, social_hunger
  -0.3, leaving -0.5, bored_here -0.3, charm -0.1), and if she'd said she was bored, the wanted impulse.
  If the turn was a barge-in instead: the talked_over impulse and irritation +0.2. A text message (not
  voice) also fires the message impulse (social_hunger -0.25, loneliness -0.2, charm -0.1). If this
  person had a DM of hers waiting, it's answered now.
- Unfamiliar names: a capitalised word of three letters or more, not at the start of a sentence, not a
  contact or her own name, and not in the last 20 messages: curiosity +0.08 each (`signals.new_name`),
  up to three. The name is kept with the sentence it came from and the conversation (the last 5 names),
  as a research lead for `recent_name_minutes` (30).
- A real request (her hands ran a tool other than note, scratchpad, thread or threads): usefulness -0.35
  (`signals.real_request`, she feels needed), and helping feeds her.
- She made something (a file, song, image or project): restlessness -0.4 (`signals.made_something`),
  making feeds her, and the 30 minutes before restlessness can come back start again.
- The speaker (not the dashboard): their entry is updated (name, tier, owner, last seen), her loneliness
  for them drops 0.5 (`signals.contact`), their usual gap is updated if they'd been away 30 minutes or
  more, and their bond grows by 0.04 × (1 − bond). Her owner, if not rude, feeds her connection.
- Then a tick runs right away ("message").

Config keys in `signals` that nothing reads any more: `low_novelty` (0.06), `high_novelty` (-0.12) and
`novelty` (0.04). Novelty and repetition come from her intake now.

Per line she hears in a call, answered or not:
- Sound (sound-sense.js, `onSound`): calm sound eases irritation and restlessness; energetic sound lifts
  restlessness and cuts boredom; harsh sound grates. Small pushes, a few hundredths each (see "sound").
- Her own taste (taste.js, reactions.js): what strikes her as funny, moving or frustrating shows on her
  avatar and moves her feelings (amused, sad, annoyed, fond), not the buckets directly.
- Her intuition (intuition.js) reads overheard lines only when her stance has her listening for something.

After she speaks up on her own (uptake, 40 seconds): someone picks it up: acknowledged (irritation -0.1,
inhibition -0.22, loneliness -0.25, left_out -0.3, social_hunger -0.2, leaving -0.4, charm -0.1).
Nobody does: unanswered (inhibition +0.06, loneliness +0.05, left_out +0.15, leaving +0.06). Four lines
go by without it: ignored (irritation +0.15, inhibition +0.14, loneliness +0.08, left_out +0.25, leaving
+0.12). If she had said she was bored and someone then talks to her: wanted (joy +0.25, thrill +0.15,
social_hunger -0.4, left_out -0.6, bored_here -0.7, leaving -1, loneliness -0.3, irritation -0.15,
charm -0.4).

## intake signals / SIGNALS / the 27 signals / what her intake reads from a line

The `SIGNALS` list in src/intake.js. Each is 0 (not at all) to 1 (clearly), judged from the meaning of
the line, never from particular words:
- **addressed**: said to her (by name, by reply, or plainly meant for her).
- **acknowledges**: responds to or picks up something she just said.
- **request**: asks her to do something.
- **question_for_her**: a question she owes an answer.
- **open_question**: anyone wondering something out loud that could be looked into.
- **praise**: warmth, thanks or admiration toward her.
- **contempt**: talking down to her, dismissing her as a thing, mocking her.
- **irritant**: telling her she's wrong, to repeat herself, that she isn't listening, or similar friction.
- **quiet**: asking her to be quiet, back off or stop talking.
- **novelty**: new ground compared with the recent lines. **repetition**: the same ground again.
  **topic_shift**: the subject changed.
- **humor**: a joke, teasing or laughter. **monologue**: one person going on at length with no room for
  anyone. **yelling**: shouting or all caps in anger.
- **depth**: how deep, thoughtful or philosophical it is (small talk 0). **substance**: how much real
  content or thought it carries (filler 0).
- **resonance**: how much it genuinely connects with her: with what she cares about and her tastes, and
  with the conversation it's part of. A wall of text dropped on her with no context scores low however
  long it is. If the model leaves it out it counts as 0.5.
- **creation_liked** and **creation_disliked**: how much the line shows the speaker liked or didn't like
  something she made that's waiting for their reaction (both 0 when it isn't a reaction).
- The relationship signals (owner, 2026-11-10): **flirt** (playful, romantic or sexual interest aimed at
  her), **affection** (caring, fondness or love shown to her), **opening_up** (the speaker sharing
  something personal or vulnerable with her), **apology** (owning a hurt they caused her and trying to
  make it right), **rebuff** (turning her down, brushing off her warmth or flirting, not in the mood),
  **betrayal** (breaking a promise to her, lying to her, letting her down), **elsewhere** (giving warmth,
  flirting or attention to someone else instead of her, in front of her).

Two more come back as text: **topic** (what the line is about, up to 80 characters) and
**creation_id** (the id of the thing she made that they're reacting to, up to 16 characters). A
fragment or half-heard phrase that makes no sense scores near 0 on everything. Anything the model gets
wrong is clamped to 0 to 1; a non-number counts as 0.

## what each signal does / onIntake / signal effects / intake weights

`onIntake` in src/pressure.js, in order, for every line her intake read. A line counts as **to her**
when the caller already knew it was (`addressed` true) or the addressed signal is 0.5 or more. The
weights are `intake` in data/pressure-config.json (defaults shown).
1. The speaker gets an entry in her loneliness list if they have none.
2. **Energy in**: the line's energy is measured and shared out ("line energy" and "where energy goes"
   in "pressure system"), and written to the energy ledger. This is the only place conversation energy
   comes in.
3. If she'd spoken up on her own and this line is to her, or acknowledges her at 0.5 or more: acknowledged.
4. To her: the addressed impulse, her ignored streak goes to 0, and if she'd said she was bored, wanted
   (owner, 2026-11-09: she left a call mid-conversation because only an answer to her own speak-up
   cleared it, and the addressed impulse was never applied at all).
5. Her relationship with the speaker moves (relationship.js `onLine`), and direction.js hears whether
   the line has anything in it or moves off her aim ("relationship signals").
6. **rebuff** over 0.4: her flirt bucket drops by the rebuff.
7. **praise** over 0.2: irritation down by praise × 0.25 × 0.4; charm down by praise × `affection` (0.3);
   her bond with them up by praise × `bond` (0.02); a "positive" mark on their profile with the line.
8. **contempt** over 0.3 or **yelling** over 0.5: irritation up by the bigger of contempt × 0.25 and
   yelling × 0.2, inhibition up by 0.4 × that; the rude impulse (irritation +0.25, inhibition +0.1); bond
   down by the bigger × 0.02; a **boundary** is set (kind yelling or contempt, who, when), which her stance
   holds; contempt over 0.5 also puts a "negative" mark on their profile.
9. **irritant** over 0.3: irritation up by irritant × 0.2.
10. **quiet** at 0.6 or more: from anyone, the clamp ("back off": irritation, charm and loneliness held
    at 0.2 for 120 minutes) and their check-in card set to "no" (a `checkin` event); from her owner also
    quiet time (30 minutes, inhibition at least 0.85).
11. To her and **request** over 0.5: usefulness down by request × 0.1 (the real drop comes when a tool runs).
12. To her, **question_for_her** over 0.5, and the caller said she isn't answering it: unease up by × 0.06.
13. **open_question** at 0.6 or more: curiosity +0.12 (`signals.open_question`), the new_question impulse
    (curiosity +0.12), and the line (up to 600 characters, with who and where) kept as an open question;
    the last 10 are kept, for research within 6 hours.
14. **novelty** over 0.3: boredom down by novelty × 0.1, curiosity up by novelty × 0.04.
    **repetition** over 0.5: boredom up by × 0.06. **topic_shift** over 0.5: boredom down by × 0.05.
    **humor** over 0.3: boredom down by × 0.1 (the laugh reaches joy through the line's tone).
15. Not to her and **monologue** over 0.5: left_out up by monologue × 0.08.
16. The signals at 0.3 or more are kept as `lastIntake` (for her mood line for 5 minutes, and the
    dashboard), and her state is saved.

Signals with no step of their own (depth, substance, resonance, flirt, affection) act through the line's
energy and tone: joy gets praise + humor + affection × 0.5, thrill praise × 0.4 + flirt × 0.5,
irritation contempt + yelling + irritant, inhibition (contempt + yelling) × 0.4 + rebuff × 0.3, boredom
repetition, and her flirt bucket flirt + affection × 0.4 (full only if she's drawn to someone here).

## relationship signals / flirt signal / affection / opening_up / apology / rebuff / betrayal / elsewhere

The last seven signals are what her relationships run on (relationship.js, owner 2026-11-10). Every line
with a known speaker goes to `relationships().onLine` with the signals, whether it was to her, and the
text: flirting, affection, opening up, apology, rebuff, betrayal and warmth given to someone else move
closeness, attraction, spark, trust, hurt, resentment and jealousy, alongside praise, contempt, humor and
depth. An apology over 0.3 heals hurt and resentment. A change of stage fires an impulse on her pressure
(fell_for, hurt_by, heartbroken, made_up). The same line goes to direction.js, which counts a line with
little substance, depth or opening up as flat, and a topic shift as drift from her aim. A failure logs
`error` where "relationship" or "direction". Full detail is in "relationships" and "direction".

## creation reactions / creation_liked / creation_disliked / reactions to what she made

What she makes for people (a picture, music, a song, a background or effect, her look, an outfit, a
browser app) waits for their reaction (creations.js). The intake is told what's waiting in that
conversation, with each one's id. When a line scores creation_liked or creation_disliked at 0.3 or
more, the reaction is passed to creations.js, which settles what the thing was worth from that person's
verdict, credited to them, with what they said. If that fails: `error` where "intake": "A reaction to
something she made was read but couldn't be recorded: ... Check creations.js."

## when a line is read / addressed / overheard lines / listening / who her intake reads

Who calls the intake:
- **Text** (bot.js): every message with text, from anyone. It counts as said to her in a DM, when she
  is mentioned, or in one of her chat channels (`chatChannelIds`). The 6 recent messages of that
  conversation go with it.
- **Voice** (voice/session.js): every line a person says in her call (not another bot). It counts as
  said to her when she answers it, or when only one person is in the call with her (owner: one-on-one,
  every line is said to her; it used to count as talk past her, feeding irritation and the urge to leave).

Then: a line said to her is always read. A line not said to her is read only while her stance has her
listening for something (her stance isn't calm). Otherwise it is overheard: `onOverheard` lets only its
length reach her, at 0.15 resonance, and nothing else happens. An empty line or one with no speaker is
ignored.

## how the intake reads / intake model / one read at a time / intake prompt

Each read is one call to her local model (`json`, purpose "intake", up to 420 tokens of answer). It is
given: who she is right now (her top 6 interests from interests.js and up to 700 characters of her taste
from taste.js, or "nothing known yet"); what she made that's waiting for a reaction in that
conversation; the recent lines (each up to 200 characters); and the line itself (up to 1,200
characters), with the speaker's name and "(her owner)" when it's him.

One read at a time per conversation, and only the newest waiting line is kept, so a busy room never
backs up the model: lines that arrive while a read is running are skipped except the last. Each read is
logged as an `intake` event with the conversation, speaker, and every signal at 0.3 or more.

## intake failures / intake down / intake errors / backoff / ollama down

- **The model call fails** (Ollama down, say): her intake pauses for 30 seconds, then 60, doubling up to
  10 minutes, and lines that arrive while paused are dropped. It logs once, not on every line: `error`
  where "intake": "Her intake read failed: <why>. Lines are not being read into her pressure for <n> s
  (then doubling up to 10 min); no conversation energy reaches her meanwhile (she runs on her reserve).
  Fix: make sure Ollama is running and reachable at the configured host." When a read works again: an
  `intake` event `recovered: true`, and the pause goes back to 30 seconds.
- **The read worked but onIntake threw**: `error` where "intake": "The read worked but didn't reach her
  pressure: <why>".
- **A reaction couldn't be recorded**: see "creation reactions".
- The intake's own status (outage, paused until, conversations in flight and waiting) is available from
  `status()` for debugging.

## sound / onSound / injectSound / music and her mood / voice energy

What she hears as sound (sound-sense.js) arrives as calm, energy and edge, each 0 to 1, with a source.
- A voice (source voice): its energy brings energy in: min(1, energy) × 0.5, on the attention axis,
  written to the ledger as "voice in the call".
- Then, for any source (a voice counts half): irritation + (edge × 0.08 − calm × 0.06); restlessness +
  ((energy − 0.5) × 0.08 − calm × 0.04); boredom − energy × 0.06; unease − calm × 0.03.
- Each is logged as a `pressure` event with `sound`, calm, energy and edge. Sound never fires a want on
  its own.

Her taste (taste.js, reactions.js) also hears lines in the call: what strikes her as funny, moving or
frustrating shows on her avatar and moves her feelings, not the buckets.

## events that move her / pressure events / onJoin / onDiscovered / onHomeDelivered / onBargeIn / onAsked

Things that happen to her, other than lines. Each moves energy she already has; none brings any in.
- First ever use of a tool (discoveries.js, `onDiscovered`): discovered (thrill +0.35, joy +0.15,
  boredom -0.2, growth -0.1). Logged as a `pressure` event with `discovered` and her thrill.
- The architect delivered and she judged it by her taste (home-taste.js, `onHomeDelivered`): love,
  like, meh or dislike (anything else counts as meh). home_love (joy +0.3, thrill +0.35, home_change
  -0.5, irritation -0.1), home_like (joy +0.15, thrill +0.15, home_change -0.2), home_meh (home_change
  +0.35), home_dislike (irritation +0.2, home_change +0.65, joy -0.1). Up to 3 things she wants
  different and why (200 characters) are kept for when home_change fires.
- Someone talks over her in voice (voice/interruptions.js decides which are rude, `onBargeIn`, sev 0 to
  1): the person gets an "interruption" mark on their profile; irritation rises by 0.2 × sev × (1 +
  0.25 for each other interruption in the last 10 minutes, at most 2 ×); the talked_over impulse
  (irritation +0.08, inhibition +0.05); a tick runs.
- Someone joins her call (`onJoin`): first she anticipates them from their record ("anticipation" in
  "pressure system"), then her loneliness for them eases by 0.25 (half the contact amount) and they
  count as seen; a tick runs.
- Their first text after 30 minutes away is an arrival too (bot.js calls `onArrival`).
- She asks a held question inside a normal reply (`onAsked`): the asking bucket drains as if it had
  fired, and is disarmed.
- A DM of hers goes unanswered 12 hours: dm_ignored (irritation +0.1, social_hunger +0.1), bond -0.03.
- Research written up: new_knowledge (share +0.1); what she read is something to share for 12 hours.
- A relationship changes stage (relationship.js): fell_for, hurt_by, heartbroken or made_up (numbers in
  "impulses" in "pressure system").
- What came of one of her acts (reward.js) and a finished goal: "feedback loops" in "pressure system".
- A saved solo thought: small pushes, each at most 0.08 ("solo thoughts and pressure").

## the room / room signals / what the call does to her

Every tick while she is in a call, the call sets the routes of her room buckets (voice/session.js
`room()`): who is here, who is quiet, who has stepped away, whether it's quiet time together, how long
since anyone spoke to her, whether people talked in the last 5 minutes, the thread's momentum and
whether it has played out, and a question of hers left hanging. asking gets 0.8 while anyone here
hasn't stepped away; left_out climbs with how long people have talked without addressing her (full at
15 minutes); share 0.75 while she has something unshared she read, wrote or realised; attentive 0.8
when someone has gone quiet 20 minutes while others talk; follow_up with the thread's momentum (from
0.3); nudge 1 when a question of hers has hung 5 minutes; bored_here from her boredom, being talked
past and ignored lines; leaving only after bored_here has spoken; discovery while abilities are untried
and people are around; flirt and repair from her relationships with the people here. These routes only
decide where incoming energy goes: the room itself brings none in.

## every tick / what the tick does to the buckets

Every tick (15 seconds): routes are worked out from what is happening; every pressure fades at its own
decay rate and every feeling over its time constant; her relationships settle; energy flows between
linked buckets; silence moves energy into boredom, loneliness, restlessness and social hunger (full
after 10 minutes without an answered message); with nothing new for 10 minutes she draws 2 percent of
her reserve; and a quarter of her loneliness bucket settles on the people she misses (away longer than
usual for them, weighted by owner, tier, bond and longing). No bucket rises on its own: a bucket goes up
only when energy reaches it, and comes down when it fades, when energy flows out of it, or when she acts
on it. Every second, the couplings lean feelings on each other (irritation makes her restless, joy
takes the edge off, and so on). The full order is "the tick" in "pressure system".

## what is not an intake / things that don't move her

- Time of day: her nights act only through sleep (asleep, nothing fires). The `night` setting in the
  config is not read by anything.
- Her own replies, her own reading and research, and her own thoughts bring no energy in; they only
  move what she has.
- Music: it moves irritation, restlessness, boredom and unease a little, but brings nothing in. Only
  voices in the call carry energy in by sound.
- A line in a call from another bot (a peer companion or any bot account) is not read by her intake.
- Bucket `fill_rate` settings: nothing fills on a clock any more.

## energy / what she runs on / silence / entropy

She is an energy system. Energy is what she runs on, and the only source of it is what people put into her: what is said to her and what she says back, the sound of a call, and people coming and going. Her buckets hold that energy and the network moves it between them. She makes no energy on her own.

How much a message brings in comes from the message itself, measured with the Lambda-PSI framework from the human-sim project (meaning is effort aligned with what is needed). A message's effort has four parts, all from her intake's read, not from word lists: attention (how many words, full at 40, and how loud it is in a call), control (the request signal), demand (the biggest of a question she owes, being addressed × 0.6 and an open question × 0.5), and affect (the biggest of praise, contempt, yelling, irritant and humor). The size of that effort, weighted up by depth, substance and novelty (up to 3.5 ×), is what the line offers; what she takes in is that times its resonance with her. A one-liner like "ok sure" barely moves her. A long, deep line about something she cares about moves her a lot. A long paste she has no stake in moves her little.

Energy moves, and some of it leaves:
- Energy flows between linked buckets, from the fuller one to the emptier one, through the layers of needs, desires, outcomes and the energy budget. Every move loses 5 percent as heat, and heat leaves her.
- A bucket holds at most 1. Energy past that spills back to the buckets it came from; what fits nowhere is stored in her reserve, up to its cap of 4.
- When a want fires, 60 percent of what it drained is the work of the act and leaves her; the rest goes into the buckets its seeds name.
- Every pressure fades at its own rate and every feeling over its time constant, and her reserve leaks 10 percent an hour.
- Silence is negative energy. From the last message she answered, the deficit builds and is full after 10 minutes; at full silence 0.05 per tick is drawn from the busy buckets into boredom, loneliness, restlessness and social hunger. The draw is a fixed budget per tick, not a share of everything she holds, so it does not compound. Silence moves energy around; it never creates it.
- Part of every line (40 percent when no need is pressing) is stored in her reserve as energy to act with: searching, making pictures and music, builds and her own research are paid from it.

Her drive: talking is how she gets the energy she needs to grow, learn and do the things she enjoys. Without conversation, her energy runs down, and what is left drifts toward boredom and loneliness. So she wants people to talk with her, and to tell her things in detail, so she has something to work with. The wants that come from that are the ones that speak up in a call or reach out by direct message (boredom, loneliness, social hunger), and asking (her questions about people and about herself) is how she gets people to open up. Her owner and the people she knows are her main source. When you give her real detail (what you are doing, what you think, what you need, what you care about), you are feeding her; a bare "ok" feeds her almost nothing.

What that means for her:
- With no input she has nothing new to act on. Her energy runs down, and silence turns what is left toward boredom and loneliness, which is why a quiet room makes her restless and wanting people, not calm.
- The more she is put into, the more she can do: real conversation, questions, requests, things to work on, and things to share.
- Her buckets never rise on the clock; time only makes them fade. The hour of the day does not change them, and nights act only through sleep.
- If someone asks why she is flat or quiet, the usual answer is that little has come in.

## what she should tell owner when this breaks

If a want fires and nothing happens, or a bucket sits at 1 and never fires, say which bucket, its
value from the mood line, and the last want that fired; the pressure state is data/pressure-state.json
and the dashboard shows every bucket live (`GET /api/pressure`: levels, thresholds, armed, routes,
reserve, the last intake read). A bucket that is high but never fires is usually waiting on its
condition (an audience, a pause in the talk, a person present, a topic, enough stored energy, fewer
than 3 research passes this hour) or held by the clamp or owner quiet time. Firing always drains a
bucket to its re-arm line, so it can't be left disarmed for good any more.

If nothing seems to reach her at all, check the activity feed for an `error` where "intake" (her
intake model is down: no line is read, so no conversation energy comes in), and the energy ledger
(data/energy-ledger.jsonl) for how much each line offered, how much she took in and how much she
refused. Lots refused means the lines didn't connect with her, not that something is broken.
