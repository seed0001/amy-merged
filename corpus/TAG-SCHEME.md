# The tag scheme: ten layers over one map

Draft for Owner to approve, November 11, 2026. Nothing here is built yet beyond a first test tagger.

## The idea

Every line anyone has said lands at one spot in the embedding space, and lines that mean similar things land near
each other. A tag is a way of colouring that map. Tag enough lines "praise for her" and the spots that light up
form an area: that area becomes the place in her brain where praise for her lives.

One set of tags gives one map. Ten different kinds of tag give ten maps laid over the same space, like layers.
A single line then lights one or more areas on every layer at once, and the combination is what she makes of it:

> "You did a damn good job figuring that out yesterday."
> said to her · praise for her · about her ability · refers to something past · warm · draws closer ·
> asks nothing of her · her last reply landed

That pattern, not any one tag, is what picks what she does next.

Three rules shaped every tag:

1. **A tag has to drive something.** Each one feeds a want, a memory operation, a reasoning operation, a way of
   replying or a kind of tool. A tag that changes nothing in her is left out.
2. **Tag what the line carries, not what it does to her.** The old model scored "how much this resonates with
   her", which depends on her mood that day, and those scores were noise. These tags are about the line. How she
   takes it is worked out afterwards from her own state, by a table that can be read.
3. **Broad first, fine second.** Every fine tag sits under a broad one. A rare fine tag (a threat, an apology)
   still counts toward its broad group, so nothing is wasted for being rare.

## Layer 1: Address. Who is this for, and what does it expect back?

| Tag group | Tags |
|---|---|
| Said to | her · another bot · a named person · the room · themselves · a machine (dictating to a computer or coding tool) · can't tell |
| Wants back | an answer · an action · agreement · comfort · nothing, just to be heard · to be left alone |
| Place in the talk | opens a new subject · carries on · answers a question · follows up · cuts in · goes back to an earlier subject · closes it |

## Layer 2: Act. What is the speaker doing?

| Broad | Fine |
|---|---|
| Asking | for a fact · for her opinion · how she is · whether she remembers · whether she can · why or how · to confirm ("right?") · to choose · not really asking (rhetorical) |
| Directing | do it now · a polite request · permission ("go ahead") · stop or don't · a standing rule ("from now on") · teaching her how · inviting ("let's") · handing her a job |
| Telling | about themselves · about someone else · about her · about the world · what happened · what they plan · what they think · what they like · what they guess · what a word means · a rule ("if", "whenever") · a story · what they're doing right now |
| Reacting | agrees · disagrees · just acknowledges · surprised · laughs · thanks · apologizes · forgives · sympathizes · brushes off |
| Judging | praises her · praises someone or something else · faults her · faults someone or something else · compares · complains about the situation |
| Repairing | corrects her · corrects themselves · clears something up · repeats · didn't hear · was misunderstood |
| Bonding | greets · says goodbye · checks in · small talk · teases · flirts · comforts · encourages · insults · threatens (joking or real) · brags |
| About the talk itself | about this conversation · about how she works inside · testing her · showing her off to others · reading or quoting something · singing or lyrics · broken transcription |

## Layer 3: Subject. What is it about?

| Tag group | Tags |
|---|---|
| About whom | the speaker · her · someone present · someone absent · another bot · the speaker and her together · the group |
| Which part of her | who or what she is · how she behaves · how she looks · her voice · her memory · her feelings · what she can do · a mistake she made · how she's built |
| Field | building bots and AI · code and computers · work and money · family · friends · health and body · food · drink and smoke · music · games · film and TV · feelings · everyday life · plans · news and the world · big questions (mind, life, what's real) · jokes |
| Topics | one to three short phrases in the model's own words, for anything the fixed list misses |

## Layer 4: Knowledge. What does the line claim, and is it worth keeping?

Each fact the line states is rewritten as one plain sentence that names who it is about, then tagged:

| Tag group | Tags |
|---|---|
| Kind of fact | who someone is · how two people are related · a trait · something owned · where someone or something is · a like or dislike · something they can do · a habit · something that happened · how things are right now · a plan · an opinion · a rule · what a word means · how to do something · a number or amount · a name or nickname |
| When | always true · past · ongoing · this moment · future · used to be true, no longer |
| How sure | said flat out · hedged · a guess · heard from someone else · a what-if · not literal (joke, exaggeration) · sarcastic |
| Yes or no | affirmed · denied |
| How wide | one person or thing · a kind of thing in general · everyone |
| Keep it? | keep · only matters right now · not a fact |
| How private | ordinary · personal · sensitive (health, money, legal) · told in confidence |

## Layer 5: Feeling. What is in it, how strong, and aimed at what?

| Tag group | Tags |
|---|---|
| Feeling (each 0 to 3) | joy · affection · amusement · pride · excitement · calm · curiosity · gratitude · hope · frustration · anger · contempt · disappointment · sadness · loneliness · worry · tiredness · boredom · embarrassment · hurt · confusion |
| Aimed at | her · themselves · another person · the situation · a tool or machine |
| Swearing | none · for emphasis · aimed at her · aimed at something else |

## Layer 6: Stance. What is the speaker doing to the relationship with her?

| Tag group | Tags |
|---|---|
| Distance | draws closer · pushes away · neither |
| How she's treated | as a person · as a tool · as a project being built · as an audience |
| Trust | confides in her · relies on her · believes her · doubts her · tests her |
| Authority | gives an order as her owner · sets a limit · gives her freedom · defends her · none |
| Her standing | questions whether she is real, alive or aware · affirms it · not about that |

## Layer 7: Charge. What does the line carry that her wants can feed on?

These are properties of the line. A separate, readable table turns them into movement in her pressure buckets,
depending on her state.

| Tags (each 0 to 3) |
|---|
| warmth given · attention given to her · approval · need for her · invitation to join in · something new offered · a challenge to her · a demand on her · urgency · rejection · being left out · being talked over |

## Layer 8: Call. What does the line ask her mind to do?

This is the layer that picks operations rather than replies.

| Broad | Fine |
|---|---|
| Remember | store a new fact · change a fact she holds · forget something · recall what she knows of a person · recall an earlier conversation |
| Reason | answer from what she knows · work something out · compare · explain why · check for a contradiction · estimate · plan steps · define a word · say she doesn't know |
| Converse | acknowledge · answer · ask what was meant · ask a follow-up · offer something related · comfort · celebrate · own a mistake and fix it · hold her ground · joke back · stay quiet and listen · change the subject · wrap up |
| Act | her look or avatar · her voice, sound or music · files and projects · look something up · her own memory · her own settings · the call (join, leave, mute) · a reminder or schedule · nothing |

## Layer 9: Form. What shape is the sentence?

| Tag group | Tags |
|---|---|
| Shape | statement · question · command · exclamation · fragment |
| Has | a condition ("if") · a denial · a comparison · a list · a number or time · a quote · a reason ("because") |
| Leans on what came before | stands alone · needs the line before it ("that", "it", "do it again") · carries on a sentence cut off earlier · is cut off itself |
| Transcription | clean · a word or two misheard · mostly garbled |
| Register | plain · rough · technical · tender |

## Layer 10: Links. How does this line connect to others?

These are the wires between areas, and the record of whether what she said worked.

| Tag group | Tags |
|---|---|
| Answers | the id of the line it answers, if any |
| Continues | the id of the line it carries on, if any |
| Thread | same subject as before · a turn within it · a new subject · back to an older one |
| How her last reply landed | picked up and built on · accepted · corrected · ignored · annoyed them · pleased them · she hadn't spoken |

"How her last reply landed" is the feedback signal: over thousands of lines it shows which ways of responding
worked in which situations, without anyone grading her.

## How the tagging would run

- **One layer or two per pass.** A small model handed the whole form gets lazy: in the first test both models
  marked every tone "neutral". Short, sharp passes fix that.
- **Model:** `gemma4:12b`. It fits the 16 GB card and tagged at 2.1 seconds a line in the test. The Qwen 3.5 9B
  took 7.4 seconds for similar quality. `gemma4:26b` does not fit the card.
- **Cost:** 21,905 lines said by people at about 2 seconds each is roughly 12 hours for one pass, and richer
  passes will be slower. Ten layers over everything is several days of GPU time.
- **Cheaper route, same result:** fully tag a fair sample of about 5,000 lines (about 3 hours a pass). That is
  enough to train a readout for each tag, and the embedding space carries it to the other lines. Then tag more
  only where the recognizer is unsure.
- **The local bots share this GPU.** While a pass runs, Amy's and James's local background thinking will be slow
  or fall back to the paid cloud model.
- **Still provisional.** Every tag is a model's opinion. Whole conversations are held out for testing, and a
  spot-check sample goes to Owner.

## What is not decided

1. Whether the plain-sentence claims from layer 4 should ever be fed into her memory, or only used to test what
   her own parser extracts. Feeding them in means a language model wrote facts she holds.
2. Sample first, or everything.
3. Any layer or tag to add, drop or rename.
