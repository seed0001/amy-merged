# Amy merged: new champ's body, the Python Amy as the brain, no LLM

Goal (Owner, 2026-11-11): take the LLM out of new champ and put the Python Amy in as the brain, in control of
everything. Two copies were made so the originals are never touched:

- `body/`  copy of `C:\Bots\new champ` (Node): Discord, voice, pressure, tools, avatar, dashboard, phone link.
- `brain/` copy of `C:\Bots\Amy` (Python): parser, fact store, reasoning engine, rules, corrections, WordNet.

The copies have no Discord token and use other dashboard ports (body 3100, brain 8866), so they can't knock the
live bots offline. Her live conversation database was not copied: the merged system starts with clean memory.

## Where the body uses the LLM today (body/src)

About 30 files import `llm.js`, plus 6 that call a model directly.

| Job | Files | What replaces it |
|---|---|---|
| Writing the reply, picking tools | companion.js, actions.js, voice/session.js, llm.js `chat` | brain: understand, learn, reason, reply |
| Scoring what was said (feeds pressure) | intake.js, listen.js, overhear.js | brain's parse: speech act, new facts, questions, feeling words |
| Memory | extract.js, memory.js, summaries.js, topics.js, concepts.js, thread.js, profile-learning.js | brain's fact store, with who said it |
| Inner life | thoughts.js, self-work.js, self-dialogue.js, sleep-on-it.js, journal.js, dreams.js, intuition.js, interests.js, taste.js, question-engine.js, goal-work.js, experience.js | brain: thoughts, induction, investigations, reflection, digestion |
| Background workers that write code | agents.js, project-coder.js | nothing classical writes a website; see "Can't be done without a model" |
| Seeing pictures, making pictures and music | llm.js `describeImages`, `generateImage`, `generateMusic` | not language models, but still neural; decide later |
| Embeddings (bge-m3) | memory.js and two more | brain's WordNet and semantic network |

Speech-to-text and text-to-speech are not LLMs and stay.

## How they join

The brain runs as one long-lived Python process beside the Node body, and the body talks to it over a local
connection. Rewriting 34,000 lines of Python in JavaScript (or the body in Python) would cost weeks and buy nothing.
A long-lived brain also fixes her 11-second first reply: the word database loads once.

The body's `pressure.js` is the pressure system. The brain's own port of it (`dialogue/pressure.py`, `life.py`)
is retired once the body's pressure drives her, so there is one set of wants, not two.

## Phases

1. **Brain service and the reply path.** A small server in `brain/` (hear a line, get her reply, what she learned
   and how it landed). The body's reply path calls it instead of `llm.chat`. A switch (`BRAIN=amy`) makes every
   remaining LLM call fail loudly and get logged, so nothing keeps using a model unseen. Done when: typing to her
   on the body's dashboard gets the brain's answer and the model-call log shows zero text-model calls.
2. **Voice.** The body's voice pipeline: speech-to-text, brain, text-to-speech, in a call.
3. **Pressure.** Intake scores come from the brain's reading of each line instead of a model. When a want fires
   (silence, share, ask, curiosity), the brain says the line from what she actually knows and wonders.
4. **Memory.** The brain's fact store is her memory. The body's model-written memory, summaries and topics are
   retired; the dashboard's mind pages read the brain.
5. **Tools.** She decides to use a tool from what she understood, tool by tool, starting with the ones that map
   cleanly (music, files, calls, lookups, calendar, remembering). The body has 338 tool definitions to triage.
6. **Retire the rest.** Every LLM call left on the log is replaced or removed.

Alongside all of it: the brain's understanding (the benchmark, then parsing that takes what it can from a
sentence). The merged system can only be as good as what she understands.

## Can't be done without a model

- Writing code or building a website from a request.
- Describing a picture.
- Making pictures and music (not LLMs, but neural models).

Each is either dropped or kept as a tool she calls that isn't her brain. Owner decides.
