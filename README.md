# Amy, merged: a companion with no language model in her head

This is an experiment in building an AI companion whose understanding, memory, reasoning and replies come from her
own inspectable machinery instead of a large language model (LLM).

It joins two existing projects:

- **the body**, a full Discord companion (voice calls, text, a pressure system of wants, tools, an avatar, a
  dashboard) that until now used an LLM for all of its thinking, and
- **the brain**, a rule-based conversational reasoning engine that parses sentences, stores what it is told as
  facts, and reasons over them with logic, using no LLM at all.

The goal is to take the LLM out of the body and put the brain in charge of everything the LLM used to do.

**Status: early and experimental.** She answers typed and spoken lines with her own brain today. Most of what
makes the body feel alive (speaking first, wants reacting to what is said, tool use) is not yet reconnected, and
her understanding of ordinary speech is weak. The sections below say exactly what works and what does not.

## Why

An LLM-driven companion is fluent, but its knowledge and reasoning are locked in billions of weights that nobody
can read. It makes things up, it cannot say how it knows something, it forgets, and teaching it one new fact means
prompt tricks or retraining.

The bet here is that a companion can be better than an LLM at specific, measurable things:

- **Exact memory.** A fact she is told is stored as that fact, with who said it and when.
- **No invention.** She answers from what she holds, or says she does not know.
- **Showing her work.** Asked "Is Rex an animal?", she answers "Yes. Rex is an animal. I know this because Rex is
  a beagle, and a beagle is a kind of animal (beagle → dog → animal)."
- **Learning from one telling**, instantly, with no training run.
- **Corrections that stick**, with the old belief retracted and the reason recorded.
- **Running free and offline** for everything except hearing and speech.

It will not match an LLM's breadth of language from hand-written grammar alone. The plan for closing that gap is
described under "Where this is going".

## What is in this repository

```
body/      The companion (Node.js): Discord, voice, pressure, tools, avatar, dashboard.
brain/     The reasoning engine (Python, standard library only): parser, fact store, proofs, rules.
corpus/    Tools for turning real conversations into training and test material for her understanding.
MERGE-PLAN.md          Where the body used the LLM, and the phases for replacing each use.
corpus/TAG-SCHEME.md   The ten-layer tag scheme used to label conversation lines.
start-merged.bat       Starts the merged system on Windows.
```

### The body (`body/`)

A complete companion harness:

- **Discord**: text channels, direct messages, and voice calls with speech-to-text and text-to-speech.
- **Pressure system** (`src/pressure.js`): wants such as boredom, curiosity and loneliness are buckets that fill
  from conversation and from time passing. When one crosses its threshold it fires, and she does something about
  it on her own: speaks up in a quiet call, shares something, asks a question. Nothing autonomous runs on a timer.
- **Tools**: several hundred tool definitions (files, projects, music, her look, calls, lookups, memory).
- **Avatar and dashboard**: a 3D avatar, and a dashboard with a Mind page that shows regions of her mind lighting
  up as she hears, remembers, thinks and speaks.
- **Model guard** (`src/model-guard.js`): every call to any model service is logged with the model, where in the
  code it came from, how long it took and whether it worked. With the brain in charge (`BRAIN=amy`), any call to a
  text-generating model is refused before it leaves and recorded, so nothing keeps using an LLM unseen.

### The brain (`brain/`)

A conversational reasoning engine with no LLM and no third-party Python packages:

- **Parser** (`nlp/`): turns a sentence into one or more frames (who did what to whom, when, how sure). It learns
  verbs it has never seen.
- **Fact store** (`db/`): every assertion with its subject, relation, object, confidence, the speaker who said
  it, and the utterance it came from.
- **Reasoning engine** (`reasoning/engine.py`): subclass and instance inheritance, relation by kind, negative
  inheritance, disjointness, and if-then rules taught in conversation, applied by backward chaining with a depth
  limit, a step budget and cycle detection. Every answer carries its proof.
- **Belief revision and corrections**: "Actually Rex is a basset hound, not a beagle" retracts the old belief and
  records why. Conflicting claims from different speakers are both kept, and the answer says who said what.
- **WordNet**: a dictionary database used for word meanings and category links.
- **Reply realizer** (`dialogue/realizer.py`): words her replies from frames and proofs, and a validator parses
  each generated clause back to check that roles and polarity match.
- **Service** (`interfaces/service.py`): the brain as a long-lived process the body talks to in JSON lines.

### How the two are joined

The brain runs as one always-on Python process beside the Node body.

```
Discord / dashboard
        │  a line someone said
        ▼
   body: respond()  ──BRAIN=amy──►  brain-reply.js ──► brain-client.js ──► brain/interfaces/service.py
        │                                                                        │ parse, learn, reason, word the reply
        │  ◄──────────── reply, what she learned, what she couldn't read ◄───────┘
        ▼
   history, voice (a sentence at a time), pressure, Mind page
```

- `body/src/brain-client.js` starts the brain once, sends it lines, reports failures with the reason and the fix,
  and restarts it if it dies.
- `body/src/brain-reply.js` answers a turn with the brain. The body keeps the conversation history, speaks the
  reply, lets pressure react to being talked to, and records each step of the turn (heard, remembered, thought,
  replied) so the Mind page lights up from her real work.
- `body/src/brain-mind.js` and `cognitive-graph.js` draw what the brain holds into the mind graph: things she
  knows of are nodes, facts are links that say who told her, rules are insights.

## What works today

- Typed and spoken lines are answered by the brain, with no LLM call, through the body's own Discord and
  dashboard paths.
- She learns facts from clean statements, reasons over them, shows her proof, and takes corrections.
- Every model call is logged; text-model calls are blocked when the brain is in charge.
- The Mind page and the mind graph show the brain's knowledge and light up as she takes a turn.

## What does not work yet

- **Understanding ordinary speech.** Measured on real conversation lines, she fully reads about one line in
  five. The hand-written grammar fails on half-sentences, casual phrasing and transcription noise.
- **Telling a fact from a remark.** She treats casual talk as statements of fact and stores wrong things
  ("You are generating crap" became "I am crap"). Feeding her real conversations today would fill her memory
  with wrong facts.
- **Scaling.** She slows down sharply as her memory grows, most likely because every learned rule is checked on
  every turn.
- **Speaking first.** When one of her wants fires (a silent call, an urge to share), nothing is said: wants are
  not wired to the brain yet.
- **Feeding her wants from what is said.** The scores that drive pressure used to come from the LLM reading each
  line. Those calls are blocked, so her buckets move only with time and with being talked to.
- **Tools.** She cannot decide to use a tool from what she understood.
- **Leftover LLM jobs** in the body (background thoughts, memory extraction and others) still try to run, are
  refused, and log an error each time.

## Where this is going

### Phases (see `MERGE-PLAN.md`)

| Phase | What | Status |
|---|---|---|
| 1 | The brain answers lines through the body | Done |
| 2 | Voice calls end to end | Runs through the same path; lightly tested |
| 3 | Pressure: her wants read each line through the brain, and the brain says the line when a want fires | Not started |
| 4 | Memory: the brain's fact store replaces the LLM-written memory | Not started |
| 5 | Tools: she decides to use a tool from what she understood | Not started |
| 6 | Remove every LLM call left on the model-call log | Not started |

### The recognizer: learned, readable weights

Her grammar reads structure and fails on real speech. The plan is a small trained recognizer that runs in front
of the parser and answers one question about any line: what is the speaker doing? It keeps three decisions
separate:

1. what the speaker is doing (asking, telling, venting, praising, correcting ...),
2. what the sentence claims,
3. whether a claim should be kept as knowledge.

It works from an **embedding model** (a small neural model that places lines with similar meaning near each other;
it generates nothing) plus plain features anyone can check. Each kind of line gets one simple layer of weights,
stored in a readable file, and every judgment reports how much came from the meaning of the line and how much from
each feature. It is not an LLM and it does not write her words: it tells her what kind of line she is hearing.

### Regions in the embedding space

Lines that mean similar things land near each other in the embedding space. The longer-term idea is to carve that
space into regions and attach things to them: the rules, facts and ways of responding that belong to each kind of
situation, with learned links between regions. A line lights its region, activation spreads along the links, and
that decides where she looks. Regions decide where to look; the reasoning engine decides what is actually
supported. A rule is only tried when its region is lit, which is also the fix for the scaling problem.

### The tag scheme and the corpus tools (`corpus/`)

To train the recognizer, real conversation lines are labelled by a local model working offline as a labeller
(it never runs inside her). The scheme has ten layers, asked for in five short passes:

| Layer | Question |
|---|---|
| 1 Address | Who is this for, and what does it expect back? |
| 2 Act | What is the speaker doing? |
| 3 Subject | What is it about? |
| 4 Knowledge | What does it claim, and is it worth keeping? |
| 5 Feeling | What is in it, how strong, aimed at what? |
| 6 Stance | What is it doing to the relationship? |
| 7 Charge | What does the line carry that her wants can feed on? |
| 8 Call | What does it ask her mind to do? |
| 9 Form | What shape is the sentence? |
| 10 Links | How does it connect to other lines, and how did her last reply land? |

The tools:

- `compile.py` gathers conversation lines from the bots' databases into one de-duplicated corpus.
- `tag.py` runs the labelling passes with a local model; resumable.
- `studio.py` and `studio.html` are a small page for watching the tagging happen and pausing it.
- `embed.py` computes embeddings for every line.
- `labels.py` and `train.py` build provisional labels and train the recognizer, testing on whole conversations
  held out from training.
- `brain/tools/feed_corpus.py` feeds lines to the brain and scores, line by line, what she read and learned.

All labels are provisional: a model's opinion, tested on held-out conversations and spot-checked by a person.

**No conversation data is in this repository.** The corpus, embeddings, tags and results are local files.

## Running it

Requirements: a recent Node.js (developed on 24), Python 3.11+, and for voice a Discord bot token plus
speech-to-text and text-to-speech keys of your own.

1. `cd body && npm install`
2. Copy `body/.env.example` to `body/.env` and fill in your own Discord token and keys. The example lists every
   setting with its explanation and no values.
3. The brain needs its WordNet database under `brain/data/wordnet/` (not included; see `brain/README.md`).
4. Start it with `start-merged.bat` on Windows, or by hand:

   ```bash
   cd body
   BRAIN=amy AMY_BRAIN_DB=data/amy-chat.db node src/index.js
   ```

5. The dashboard is at `http://localhost:3100`, and her Mind page at `http://localhost:3100/mind.html`.

Tests:

```bash
cd body && npm test                 # the body
cd brain && python -m pytest        # the brain (about ten minutes)
```

## What three things have no rule-based replacement

Writing code or building a website from a request, describing a picture, and generating pictures and music.
Each is either dropped, or kept as a tool she can call that is not her brain.

## Notes on this copy

- This is a cleaned export. Keys, tokens, Discord IDs, private conversation records and machine-specific paths
  were removed or replaced, and people's Discord names were replaced with neutral ones.
- Comments in the code often quote the owner's instructions with a date. They are kept because they record why
  each piece of behaviour exists.
