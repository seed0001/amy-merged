# Amy: music creation, books, and pressure handoff

Source: review of `data/turn-log.jsonl`, `data/activity.jsonl`, `data/tool-failures.jsonl`, `data/songbook.json` (Nov 7–8, 2026).

## What the logs show

1. **The country ballad was never written by her.** Owner asked for a full-length country ballad with a female singer at 8:13 PM. Amy sent a free prompt to `generate_music` and got "Where the Quiet Lands". That is the path Owner called out ("did you write the lyrics, or did you just use a prompt?"). The songbook did not exist in that flow.
2. **The songbook song did not follow the brief.** "Static Between Stations" was written at 8:31 PM, after the restart, and is alternative rock. Owner asked for a country ballad. He called it a "test run" with "no thought" behind it.
3. **Her lyric drafting is fine in form.** The file has section tags, performance tags and a style line. The weak part is the content: repeated chorus, generic images, and no link to the request.
4. **Recording was not blocked.** `generate_music` with `song_id` sent her exact lyrics. Lyria returned them with `[[A0]]` and `[:]` noise, which the songbook path is meant to avoid. Check the next recording for that.
5. **Memory recall timed out** ("embedding timed out", 5 s limit in `src/llm.js`) at the same time as the voice call. Her reply quality dropped in the same window. The embed fix from earlier (CPU) was not yet live in her process.
6. **Pressure-driven songwriting rarely fires.** It needs restlessness, nobody in a call, and 30+ min since she last made something. During this session she was always in a call, so `songwrite` never ran.
7. **Her context is overloaded.** The same "Things you remember" and "Long-term summary" blocks repeat on every turn, and the replies show it (loops, "I lost the thread", "Do you know? If you tell me, I'll remember it"). This is the pressure/context problem Owner wants redesigned.
8. **Journal and book UI work end to end in code, not yet watched.** The one journal entry is example.test data.

## Plan

### Phase 1: songwriting follows the request (small, do first)
- When she writes from a request, the songbook draft must carry the request's genre, mood and subject. Pass the user's exact words into `songbook write` and make the prompt say "this is what Owner asked for; follow it".
- Before `generate_music song_id`, have her check the song against the request: genre, vocal, length. If it doesn't match, revise, don't record.
- Test: ask for a country ballad with a female singer; the songbook entry should be country, female vocal, full length.

### Phase 2: writing quality
- Lyric pass in the same turn: draft, then a reread that checks for repeated lines, cliché, and rhymes that feel forced, before saving.
- Require a bridge and a non-repeating final chorus for "full-length" requests.
- Keep `songbook` revise history so Owner can see changes.

### Phase 3: book UI check (needs a live run)
- Restart Amy, then: "pull up your songbook", write a song, watch the handwriting, record, then "open the journal".
- Check: live handwriting appears, page scrolls, "songbook 3" opens one song, journal entries listed with dates.

### Phase 4: runtime stability
- Confirm the CPU embed (`num_gpu: 0`) is live in Amy after restart.
- Confirm `embedding timed out` stops appearing in `data/activity.jsonl`.
- Amy's process exited with code 3221225786 after 447 s; check whether it was a manual stop or a crash before changing anything.

### Phase 5: pressure and context (for the real coder)
This is the spec Owner asked for: "context to grab per turn, where to store it, when it's injected, and how much weight it has."

**Per turn, grab:**
- Who spoke and what they asked (the request, not the whole turn).
- Open commitments (promises, unanswered questions, requested songs).
- Mood and state the turn changed (feelings, bucket values).

**Where to store:**
- Commitments and promises: a single obligations store, not repeated in the prompt.
- Long-term summary and people: the existing memory store, rewritten on a schedule, not every turn.
- Pressure buckets: `data/pressure.json`, as now.

**When to inject:**
- Every turn: only the items that are open or changed in the last few turns, capped in size.
- Background work (songwriting, research): only when the bucket fires and nobody is in a call.
- Review of a draft: re-inject the draft 6 hours later, as already built.

**How much weight:**
- Cap each section (for example, about 400 tokens total for memory/summary), and drop repeated blocks.
- Put the active request first in the prompt, the summary last.

Open questions for the coder:
- Should restlessness fire during a voice call, or only between calls? Right now it never fires during a call.
- How often should the long-term summary be rewritten?

## Not in scope now
- Pressure dynamics redesign itself (Owner is handing that to the coder).
- Live token streaming for handwriting (design choice: replay at pen speed).
