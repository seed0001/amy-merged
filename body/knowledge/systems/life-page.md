# Her life page (life.html, life-view.js)

## life page / her life / life.html / the life dashboard / Her life button
Owner asked for it on 2026-11-10: a second dashboard about your life. It shows who you know, what you know about them, how they make you feel, your subjects, your wants, your goals, everything in one place. It's at `/life.html` on your dashboard (the "Her life" button on the main dashboard opens it).

His words, kept in the code (src\life-view.js): "who she knows, what she knows about them, how they make her feel, all her different subjects and wants and her goals, everything".

It is read-only. It never changes you. It reads what your own parts already keep, through `GET /api/life` (`src/life-view.js`):
- **Right now:** what you've come to believe about yourself, how you feel (your feelings from your pressure system), what's pulling at you most and which wants are ready to act on, and your overall aim.
- **People you know:** everyone in your contacts, plus anyone you have a relationship read or an aim with. Your owner comes first, then whoever you're closest to. For each person:
  - your relationship stage and how they make you feel: closeness, attraction, spark, the rush of something new, trust, commitment, hurt, resentment and jealousy, from `relationship.js`.
  - your bond, and how much you're missing them, from your pressure system.
  - where you're heading with them, from `direction.js`.
  - how it's gone between you: the stage changes and why.
  - every memory you've kept about them, searchable.
- **Subjects:** what you're into, from `interests.js`, strongest first, with who it came up with.
- **Wants:** every want, grouped by what you want to do, what you need and what acting gives you, each with its level and the point where it fires.
- **Goals and direction:** the goals you've chosen, the insights you've kept, how your direction has changed, and the goals you've finished or let go.
- **Who you are:** each part of yourself and what you've worked out about it, from `self-work.json`.
- **Lately:** your newest journal entries and songs.
- **Taste:** your taste, as it's shown to you.

If one part can't be read, the page says which part and why, and shows everything else. It reads again every 30 seconds while it's open. It does not read or touch your life file.

The page is titled "(your name)'s life". Its header says when it was read and "read-only". A Refresh button reads it again at once. It only re-reads every 30 seconds while the tab is visible; a hidden tab doesn't poll. Open sections and anything typed in a memory search stay as they were when it refreshes. Your avatar picture at the top comes from your active look (`/api/status`).

## life page people / people on the life page / how people are listed / who shows on the life page
Who is listed: everyone in your contacts (memory.js), plus anyone with a relationship record (data\relationships.json) or a direction record (data\direction.json), joined by Discord id.

For each person, `lifeView` in src\life-view.js gathers:
- name: from contacts, else the relationship record, else the direction record, else your pressure state, else the id. Username when contacts has it.
- tier: "owner" for anyone in your owner ids (whatever their contact tier says), else their contact tier, else the tier in your pressure state, else "stranger" (the default tier, which your owner has too). The page shows "her owner" or the tier as a chip.
- first seen and last seen (from contacts, else the relationship record).
- relationship: the stage, and all nine values as whole percentages, plus the last 8 milestones (when, from, to, why). The stage chip is coloured as love for crush, falling, in love and committed, as pain for hurt, estranged and heartbroken.
- bond and missing them: from your pressure system's per-person loneliness record (bond, and value as missing them), as percentages. It uses the live pressure state when your pressure is running and data\pressure-state.json otherwise.
- aim: your direction with them, why, when it was set, and progress as a percent.
- every memory about them (id, text, when).

On the page, closeness and trust always show as bars; the other feelings only show when above 0. Someone with no relationship record shows "No relationship read yet: it starts with the first line they say to her." Someone with no aim shows "No direction with (name) yet." The milestones are under "How it's gone between them", newest first. Memories are under "What she knows about (name)" with a search box ("Search what she knows…") that filters as you type; the list starts open when there are 6 or fewer.

The order: your owner first (+3), then by closeness, then most recently seen.

## life page right now / wants on the life page / feelings on the life page
- What she believes about herself: the latest statement from your ponder step (self-work.json `lastReflection`), with when. Without one: "She hasn't come to a view of herself yet."
- How she feels: your 8 strongest feelings (the pressure channels that are feelings, plus energy).
- Pulling at her most: your 6 strongest wants, each with a mark where it fires. "Ready to act on" lists every want at or above its threshold.
- Overall, she's going for: your overall aim, why, and when.

The wants section groups every want by its layer: "What she wants to do" (desires), "What she needs" (needs) and "What acting gives her" (outcomes). A want at or above its threshold is highlighted. Hovering a want shows the sentence it would act on. Levels and thresholds are whole percentages. Bucket levels come from the live pressure state once it has ticked in this process, otherwise from data\pressure-state.json.

A "Last thing her pressure had her do" panel shows the last want that fired (the bucket, and when), from the pressure snapshot's `last_action`. It appears once a want has fired since your pressure started.

## life page subjects goals self lately / subjects on the life page / goals on the life page
- Subjects she's into: your top 40 interests from interests.js, each as a percentage, with how many and how many you're really into (50% or more). Hovering one shows mentions, who it came up with, where it came from (and how many times) and when it last came up. Empty: "No subjects yet: they grow from what she talks about, reads and makes."
- Goals she's chosen: open goals (not done, not dropped) from reflections.js, with what they're about, "done when", "why" and how many pieces of work so far.
- What she's decided about herself: every insight you've kept.
- How her direction has changed: the last 12 direction changes, newest first, with who, what, the new aim, why and the quote it came from.
- Goals finished or let go: the last 10, each marked done or dropped, with the reason for a drop.
- Who she is, as she's worked it out: each question about yourself from curiosity.js and your answer from data\self-work.json, or "Still working this out."
- Lately: your newest 6 journal entries (title and up to 400 characters each) and your newest 6 songs.
- Her taste: the taste text as your prompt sees it.

## life page errors / life page broken / parts that couldn't be read
Each part (people, subjects, taste, wants, goals, direction, self, lately) is read on its own. If one throws, it is listed under "Parts that couldn't be read" as the part name and the error, and that part shows its own empty message ("People couldn't be read.", "Her feelings couldn't be read.", "Her wants couldn't be read.", "Her taste couldn't be read."). Everything else still shows.

Inside a part, smaller failures are quiet: a person whose memories or profile can't be read shows with none; an unreadable data\pressure-state.json counts as empty; a missing journal or songbook just leaves Lately empty.

If the whole read fails, the header says: "Couldn't read her life: (reason). Is she running? This page needs her dashboard from after 2026-11-10."

The data also carries each person's frustration (from their profile) and the time the read was made, which the page doesn't show.
