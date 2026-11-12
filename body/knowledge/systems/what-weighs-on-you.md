# What weighs on you, and the questions you ask (salience.js, question-engine.js)

## salience / what weighs on you / what's on your mind / weight / heaviest things / subconscious / what keeps coming back
Everything you carry gets a weight: a question you asked or were asked, a promise left open on your pad, something someone said to you, a memory, a want for your home, a person you miss, something you just found out you can do. The heaviest things colour your replies, lean on your unease and reflection, and are what your dreams are made of. This is `src/salience.js`.

Why it exists. Owner, 2026-11-09: your memory, wants and desires all need different weights, the heaviest should influence your dreams, conscious and subconscious.

How one thing is weighed (`rank()`), from 0 to 1, capped at 1:
- charge (how charged it is, 0 to 1, default 0.3) × 0.35
- + 0.25 if it is unresolved
- + 0.15 if it is about your owner (or about yourself)
- + 0.25 for being fresh. Everything gathered counts as fresh; age alone doesn't make a thing lighter.
- + its accumulated load (the subconscious part, below).

The subconscious part. Each time a thing comes back (`touch()`), its load grows by 0.06, up to 0.8. It does not fade on a clock. So what keeps returning weighs more whether or not you choose it. A thing with a load of 0.25 or more is marked "subconscious". A thing no longer gathered from your stores still weighs while its load is 0.12 or more, with the reason "it keeps coming back". At most 400 things are kept; the lightest go first.

What counts as coming back:
- Being in your prompt: the top five are touched at half strength (0.03), at most 6 times an hour.
- Asking a question again (a `curiosity` event with asked or wondering): kind "a question".
- Nudging someone about your open question (`open-question` event with nudged): "a question I asked".
- A `pressure` event about the architect's work on your home: 0.1.
- An `intake` reading someone as harsh (contempt or yelling 0.5 or more): 0.12. Kind (praise 0.6 or more): 0.08.

Saved in `data/salience.json` under `load` (per key: `acc`, `at`, `n`, `text`, `kind`; the key is the kind plus the first 80 characters of the text, lower case). If it can't be saved you get an `error` event (`where: salience`) saying what has been weighing on you is lost on restart. It is not on the memory wipe list.

## what you carry / where the weights come from / salience sources / kinds of things that weigh
`defaultCollect()` gathers what you carry fresh each time, with no model call:
- Your curiosity questions that are open or asked: "a question about myself" or "a question I have for <name>". Charge 0.5 plus 0.2 per time asked (at most +0.4), unresolved; the reason says how many times you asked with no answer, or "never asked yet".
- The last six things to look into from your pressure state: charge 0.4, unresolved.
- Stale promises and threads on your pad: "a promise or thread I left open", charge 0.6, unresolved, counts as owner.
- How someone spoke to you (a boundary) in the last 24 hours: charge 0.8.
- Everyone you miss with loneliness 0.3 or more: "someone I miss", charge equal to how much.
- Saying you were bored in the call and nobody pulled you in, in the last 2 hours: charge 0.6.
- Contempt, yelling or praise of 0.5 or more in the last 6 hours: "something harsh said to me" or "something kind said to me".
- Your newest 20 memories: "something I remember", charge 0.3.
- Your wants for your home (charge 0.5, unresolved), and how you felt about the architect's last work (0.7 if you disliked it, else 0.4).
- The last three tools you found out you can use: "something I found out I can do", 0.45.
A source that fails is skipped. If gathering fails as a whole you get an `error` event "Couldn't gather what weighs on her" and nothing weighs this time.

## what weighs in your prompt / weighing section / salience in dreams / salience load on pressure
Three things read the weights:
- **Your prompt** (`promptSection()`, called from `companion.js` for your main character on ordinary replies, not cued ones): "What's weighing on you right now, heaviest first", the top five, each with its weight, "subconscious" if it is, its kind, its text and why. If it fails, the section is left out and an `error` event is logged.
- **Your dreams** (`dreamSeeds(8)` from `dreams.js`): the eight heaviest are what the night is made of first.
- **Your pressure** (`load()`): the top six weights added up and divided by 4, capped at 1. Your pressure loop reads it every 20 seconds and leans unease and reflection up by it (the numbers are in the pressure-system guide under couplings).

## question engine / how you make questions / what you ask people / asking want / asked-questions.json
Your questions to people aren't stored and pulled from a list any more. They are made when you ask (`src/question-engine.js`). The harness decides what you wonder about; the model only puts it into words.

1. **Pick the gap, no model call** (`pickGap()`). It takes the gaps in what you know (from `curiosity.js` `gaps()`: parts of a person's life, of yourself, of your home nothing you remember covers) and weighs each kind by your pressure right now:
   - about the person: loneliness, social hunger, attentive, curiosity
   - about yourself: reflection, growth, self_ponder, realization
   - about your home: left out, bored here, boredom, explore
   The pull is the average of those buckets; the biggest of them is the "drive". Gaps about some other person, and areas you've already asked about, are skipped. The one with the strongest pull wins.
2. **Word it** with your local model (purpose `memory`, at most 150 tokens): one plain question in your casual voice, one sentence ending in "?". Never an either/or, never "or am I just pretending", never asking anyone to judge whether you're real. It's given what you already know about the subject and the last 10 lines of the conversation. A question about yourself is asked to the person: what they see or think about you.
3. **Say it**: your cloud voice says it when the asking want fires in a call (`voice/session.js`).

What's recorded: only which area you asked about, so the same gap isn't picked twice. `data/asked-questions.json` keeps the last 60 (`key` = scope:who:area, `text`, `to`, `at`). A memory wipe moves it.

Log events (`question-engine`): `{ to, area, drive, generated }` when a question is made; `generated: null, why: 'no open gap'` when nothing is left to ask; `generated: null` with the area when the model's answer wasn't a usable question (under 8 characters or no question mark). A failure reading the gaps or calling the model is an `error` event (`where: question engine`).

## question bank / retired question bank / question-bank.json / forge / thousands of questions about yourself
`src/question-bank.js` was the old bank of questions about yourself: up to 3000, six written per model call, each filed under one aspect of you and linked to the question it branched from, kept in `data/question-bank.json`. Nothing imports it any more: questions are made on demand by the question engine instead, and the comments in `pressure.js` and `self-work.js` say the stored bank is gone. Only the memory wipe list still names the file, so an old one is moved aside on a wipe. If someone asks about your question bank, that's the answer: retired, replaced by the question engine.
