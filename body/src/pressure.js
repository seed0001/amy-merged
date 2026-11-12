import { learnedPreference } from './goals.js';
import { reflections } from './reflections.js';
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { sleep } from './sleep.js';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { activity, recentActivity } from './events.js';
import { relationships, setRelationshipStageListener } from './relationship.js';
import { listContacts, openObligations, reachCard, markReached, setReach, countRecentUserMessages } from './memory.js';
import { tierOf, isOwner } from './contacts.js';
import * as scratch from './scratchpad.js';
import { profiles } from './memory.js';
import { selectResearch, questionText } from './research-policy.js';
import { isIgnored } from './ignoring.js';
import { replyInFlight } from './busy.js';
import { setBackgroundFeelings } from './emotion.js';
import { rudeness, feed, fadeFed, resilience, coreSelfBlock } from './drives.js';
import { threads as talkThreads } from './thread.js';
import { interests as grown } from './interests.js';
import { stance } from './stance.js';
import { avatarToolCall } from './avatar-cues.js';
import { startBuild, pickIdea, builtIdeas } from './builds.js';
import { rewards } from './reward.js';
import { experiences, attemptLines } from './experience.js';
import * as newsFeeds from './feeds.js';
import * as conflicts from './conflicts.js';
export { rewards }; // requested acts (tools.js runTool) record their expectation and outcome through this too

// Amy's pressure system (her spec: Downloads/amy-pressure-system-spec.md). Internal buckets, each
// 0..1, fill and drain from conversation and from time passing. Crossing a threshold makes a bucket
// want something; acting on it drains that bucket and seeds another, so one want leads to the next.
// Ticks are plain arithmetic (never an LLM call): one every `tick_seconds`, plus one right away on
// events. Everything tunable lives in data/pressure-config.json; state in data/pressure-state.json.
//
// What a fired want does (with actions_live): boredom and curiosity run a quiet research pass that
// she writes up in her journal (journal.js). Restlessness, usefulness and unease make her speak up,
// and missing someone makes her reach out to them: out loud if they're in a call with her during a
// lull, otherwise by DM (reach_channels). Owner she can always message; anyone else needs a yes on
// their check-in card and enough days since the last time. Irritation only changes her tone. With actions_live off, wants are just logged.
//
// Charm (owner, 2026-11-09: "you need to know when to turn on flirtiness so that you can get attention. When
// you're starving for attention and you want some affection, you need to be able to dial that in to get the
// kind of energy that you need"): a feeling, not a want. It fills only from her real hunger for people (the
// flows from social hunger, missing someone and being left out, which silence feeds) and eases when attention
// and warmth actually reach her (the addressed/wanted impulses, praise in onIntake). It never fires anything:
// her stance (stance.js) turns the level into how she talks to whoever is in front of her, by how close they
// are: flirting only with her owner and real friends, warmth with guests, plain friendliness with strangers,
// nothing at all after rudeness or "back off". The dial is read off the state every turn; no clock sets it.

const CONFIG_FILE = path.join(DATA_DIR, 'pressure-config.json');
const STATE_FILE = path.join(DATA_DIR, 'pressure-state.json');

export const DEFAULTS = {
  enabled: true,
  actions_live: true, // false: fired wants are only logged
  research_question_hours: 6,
  research_thread_hours: 24,
  research_repeat_hours: 0, // 0: a topic can come up again straight away; the pressure decides
  research_per_hour: 3,
  // The energy register (owner, 2026-11-09): conversation is the only source of energy. What she takes from a
  // line is its energy times how much it resonates with her; stored energy (the reserve) is never refilled by
  // time, only by conversation and the heat of her own transfers.
  overheard_uptake: 0.15, // a line said around her that her intake didn't read: how much of it reaches her
  reserve_use: 0.02,      // share of her reserve she draws on each tick for what she needs, while nothing new comes in
  reserve_cap: 4,         // the most energy she can store (her biggest acts cost 1.5); past it, nothing more is taken in
  reserve_fade: 0.1,      // share of her store that leaks away per hour unused
  work_share: 0.6,        // share of a fired want's energy spent doing the act (it leaves her); the rest carries on to what it feeds
  store_share: 0.4,       // share of what she takes in from a line that's stored as energy she can act with (her reserve), when nothing is pressing
  // How the harness allocates what comes in (owner, 2026-11-09): by importance first. A channel's share is how
  // much it's needed right now (its route) × its layer's priority × how empty it is. Needs come before desires,
  // desires before outcomes. The more pressing a need, the less she stores and the more goes straight to it.
  priority: { needs: 1, desires: 0.6, outcomes: 0.35, budget: 0.35 },
  // What doing things costs her, from her reserve (owner, 2026-11-09): without enough, she can't, and says so.
  // A tool's cost, or per action ({ action: cost }). Anything not listed costs nothing (talking, settings,
  // moving, looking things up in her own guide). Spent energy isn't lost: it moves into what the act feeds.
  action_costs: {
    web_search: 0.4, research: 0.4, 'goal-work': 0.6,
    generate_image: 0.6, generate_self_image: 0.6, kontext: 0.6, flux: 0.6, generate_music: 1, songwrite: 0.5, play: 0.4,
    workshop: { job: 1.2, build: 1.5, add: 0.3 }, project: 1.2, build: 1.5,
    reverse_engineer: { start: 1.5 }, background_task: { start: 0.8 }, architect: { call: 0.8 },
    join_voice: 0.2, // coming into a call takes a little of what she has (owner, 2026-11-09: she chooses from her state)
    seamstress: { sew: 1.2, revise: 1.0, look: 0.2 }, // designing and sewing an outfit is real making (seamstress.js)
    sew: 1.2, // the same, when she sews one on her own
  }, // Owner's limit: at most this many research passes in any hour. Curiosity still decides when; past the limit the want waits and keeps building
  // A topic she has already researched and written up is never searched again (state.research_answered).
  reach_channels: ['voice', 'dm'], // where she may speak up or reach out on her own
  tick_seconds: 15,
  // The flow: between ticks her state keeps moving every second. Feelings settle on real time, and the
  // buckets lean on each other continuously (a transfer per second proportional to the source level),
  // so irritation makes her restless, boredom turns into looking for something, joy takes the edge off,
  // thrill wants to do something, being left out grates. [from, to, rate per second]; negative dampens.
  flow: {
    every_seconds: 1,
    couplings: [
      ['irritation', 'restlessness', 0.004], ['boredom', 'curiosity', 0.003], ['left_out', 'irritation', 0.003],
      ['joy', 'irritation', -0.005], ['thrill', 'restlessness', 0.004], ['curiosity', 'boredom', -0.004],
      ['unease', 'irritation', 0.002], ['social_hunger', 'left_out', 0.002], ['inhibition', 'restlessness', -0.003],
      ['energy', 'boredom', -0.002], ['thrill', 'joy', 0.002], ['restlessness', 'usefulness', 0.001],
    ],
  },
  max_catch_up_hours: 3, // after downtime, time counts for at most this long (so a week off doesn't wake her up frantic)
  global_cap: 3.5, // shown on the dashboard as how worked up she is overall
  quiet_clamp_minutes: 120, // after "back off" / "be quiet"
  quiet_clamp_max: 0.2,
  idle_minutes: 10, // no message for this long counts as a silence
  lull_seconds: 120, // in a call, nobody has said anything (to her or each other) for this long before she speaks up
  ask_lull_seconds: 45, // a question she's holding for someone here needs a real pause in the talk (since anyone, her included, last spoke), not a dead room
  // The silence want (owner, 2026-11-11: "if there's silence it starts to build up pressure… urges him to speak up"). How
  // long a pause is natural isn't fixed: it's silence_pause_seconds for an ordinary moment, shorter when something was
  // left hanging, something heavy was said or he has something to bring, longer when the talk came to rest or they're
  // busy with something else (quietRead). Owner, same day: "it feels like a timer, like a schedule… he should be able to
  // read the room… what happened before, what the future goals are… not just every 2 minutes."
  silence_pause_seconds: 20,
  follow_up_minutes: 5, // a question of hers left unanswered this long, with the person still here, is worth one light nudge
  may_leave_call: true, // she may leave a call on her own when she's been ignored or talked past long enough (the leaving bucket)
  leave_unaddressed_minutes: 30, // people talking around her, none to her, for this long is as talked-past as it gets
  stale_hours: 2, // a promise or open question on her pad this old starts to make her uneasy
  recent_name_minutes: 30, // a name mentioned in conversation is only a research lead this long
  // Per bucket: fill per tick while its condition holds, decay per tick otherwise, threshold to act,
  // drain when it acts, hysteresis before it can act again, and on/off.
  buckets: {
    boredom: { enabled: true, fill_rate: 0.015, decay_rate: 0.04, threshold: 0.65, drain: 0.55, hysteresis: 0.25 },
    curiosity: { enabled: true, fill_rate: 0.03, decay_rate: 0.004, threshold: 0.5, drain: 0.7, hysteresis: 0.15 },
    irritation: { enabled: true, fill_rate: 0.0, decay_rate: 0.05, threshold: 0.5, drain: 0.5, hysteresis: 0.2 },
    restlessness: { enabled: true, fill_rate: 0.005, decay_rate: 0.02, threshold: 0.65, drain: 0.5, hysteresis: 0.25 },
    usefulness: { enabled: true, fill_rate: 0.002, decay_rate: 0.0, threshold: 0.7, drain: 0.45, hysteresis: 0.25 },
    unease: { enabled: true, fill_rate: 0.02, decay_rate: 0.02, threshold: 0.6, drain: 0.6, hysteresis: 0.2 },
    loneliness: { enabled: true, fill_rate: 0.0015, decay_rate: 0.0, threshold: 0.6, drain: 0.4, hysteresis: 0.25 },
    // Wanting to understand the people around her, herself and her home (curiosity.js): it climbs while
    // there's a lot she doesn't know about whoever's been around and room in her question queue, and
    // firing it makes her wonder: one gap turned into a question of her own.
    // Off: wondering used to write questions into a stored list; her questions are now made when she asks (question-engine.js).
    wonder: { enabled: false, fill_rate: 0.01, decay_rate: 0.02, threshold: 0.6, drain: 0.6, hysteresis: 0.25 },
    // Said out loud in a call, during a lull (ported from Amy-Voice). Each climbs toward a target worked
    // out from the room every tick, and drains when she acts on it.
    asking: { enabled: true, fill_rate: 0.05, decay_rate: 0.05, threshold: 0.6, drain: 0.7, hysteresis: 0.25 },   // a question she's been wondering, for someone here
    left_out: { enabled: true, fill_rate: 0.04, decay_rate: 0.08, threshold: 0.65, drain: 0.7, hysteresis: 0.25 }, // the room talking without her
    share: { enabled: true, fill_rate: 0.03, decay_rate: 0.05, threshold: 0.6, drain: 0.8, hysteresis: 0.25 },     // something she read or made, not yet mentioned
    attentive: { enabled: true, fill_rate: 0.05, decay_rate: 0.1, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },   // someone here has gone quiet
    follow_up: { enabled: true, fill_rate: 0.1, decay_rate: 0.1, threshold: 0.5, drain: 0.8, hysteresis: 0.2 },    // a good thread she wants to go deeper on (thread.js)
    // The quiet in a call itself (callSilenceStep): fed only by silence, never by a line's energy. When it fires she speaks
    // up and takes the talk somewhere: what she's working on or thinking about, a question toward her aim, her take.
    silence: { enabled: true, fill_rate: 0, decay_rate: 0.15, threshold: 0.55, drain: 0.9, hysteresis: 0.25 },
    // A question of hers someone here has left hanging a while (open-question.js): bring it up once, lightly.
    nudge: { enabled: true, fill_rate: 0.25, decay_rate: 0.25, threshold: 0.6, drain: 0.9, hysteresis: 0.3 },
    // Wanting out of the call: talked past for a long stretch, or her lines ignored again and again.
    // Fills slowly toward the room's target (leavingTarget), empties fast as soon as someone talks to
    // her. Never during quiet time together or while someone has stepped away. When it fires she says
    // a short goodbye and leaves; a word from anyone brings her back the usual way.
    // Stage one: bored with where the talk has gone, or not included in it. She says so out loud,
    // honestly, and that she's thinking of stepping out. That gives people the chance to pull her
    // back in (which feels good: the wanted impulse) or change the subject.
    bored_here: { enabled: true, fill_rate: 0.08, decay_rate: 0.12, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
    // Stage two: she said she was bored and nothing changed. Only fills after bored_here has spoken
    // (said_bored_at), fast; empties the moment someone talks to her.
    leaving: { enabled: true, fill_rate: 0.08, decay_rate: 0.15, threshold: 0.85, drain: 1, hysteresis: 0.5 },
    // Discovering what she can do (discoveries.js): fills while abilities are untried and someone is
    // here to share it with. Fires as a speak-up: she realizes one out loud, excited, and says what it
    // opens up for the two of them. Each first use of a tool is an impulse on the thrill feeling.
    discovery: { enabled: true, fill_rate: 0.06, decay_rate: 0.04, threshold: 0.6, drain: 0.7, hysteresis: 0.3 },
    // Wanting her place changed (home-taste.js): filled only by her verdict on what the architect
    // built (the home_* impulses), fades slowly; fires as her telling her owner what she wants different.
    home_change: { enabled: true, fill_rate: 0, decay_rate: 0.01, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
    // Her own upkeep (self-work.js), in the background: filling in her knowledge graph from what she's
    // been through, and thinking about who she is (a question for the room, a statement to share).
    self_upkeep: { enabled: true, fill_rate: 0.03, decay_rate: 0.02, threshold: 0.55, drain: 0.6, hysteresis: 0.25 },
    self_ponder: { enabled: true, fill_rate: 0.02, decay_rate: 0.01, threshold: 0.55, drain: 0.6, hysteresis: 0.25 },
    // Working out what she is, aspect by aspect (self-work.js realize): fills while any part of herself is unanswered.
    realization: { enabled: true, fill_rate: 0.03, decay_rate: 0.02, threshold: 0.55, drain: 0.5, hysteresis: 0.25 },
    // Writing more questions about herself into her bank (question-bank.js): fills while the bank is short of its target.
    // Walking her owner through what she is and can do (onboarding.js): fills while the checklist isn't finished.
    onboarding: { enabled: true, fill_rate: 0.05, decay_rate: 0.02, threshold: 0.6, drain: 0.5, hysteresis: 0.25 },
    // Wanting to look back at her intuition and retune it (intuition-tune.js): climbs with gut reads she hasn't
    // looked back at, faster when they repeat or the last look found them useless. Fires as a private review.
    intuition_tune: { enabled: true, fill_rate: 0.04, decay_rate: 0.01, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
    // Rethinking where she's heading with someone (direction.js): climbs while she's talking with someone with no
    // aim, as the conversation goes flat or the subject moves off her aim, and when her relationship changes stage.
    // Fires as a private reflection that keeps, sharpens, replaces or drops the aim.
    direction: { enabled: true, fill_rate: 0.06, decay_rate: 0.02, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
    // Her relationships (relationship.js), said out loud in a lull in the call with the person there: flirting with
    // someone she's drawn to, and raising what hurt with someone so it can be made right.
    flirt: { enabled: true, fill_rate: 0.05, decay_rate: 0.06, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
    repair: { enabled: true, fill_rate: 0.03, decay_rate: 0.01, threshold: 0.6, drain: 0.9, hysteresis: 0.3 },
    // Off: there's no stored question bank to fill any more (question-engine.js makes questions on demand).
    forge: { enabled: false, fill_rate: 0.03, decay_rate: 0.02, threshold: 0.6, drain: 0.4, hysteresis: 0.25 },
    // Chasing what she's into (interests.js): fills toward her strongest interest, so she goes and looks
    // into it on her own, in the background, and writes what she finds in her journal (the research path).
    explore: { enabled: true, fill_rate: 0.04, decay_rate: 0.02, threshold: 0.5, drain: 0.6, hysteresis: 0.15 },
    // Making something on her own (builds.js): fills toward how strongly she's into an idea she hasn't built yet.
    // Fires a coding job that makes a browser app for it and opens it in her tab.
    build: { enabled: true, fill_rate: 0.01, decay_rate: 0.02, threshold: 0.7, drain: 0.8, hysteresis: 0.2 },
    // Wanting to know what's going on out there (feeds.js; owner, 2026-11-11: "news briefs or sit on the world"). No
    // clock: curiosity and boredom flow into it, and conversation energy is routed to it by how stale his picture of
    // the world has got. Fires as reading his news feeds in the background; anything new feeds his urge to share it.
    world: { enabled: true, fill_rate: 0, decay_rate: 0.01, threshold: 0.6, drain: 0.8, hysteresis: 0.3 },
  },
  // Bucket-to-bucket flows: how one part of her mind feeds another. Each edge [from, to, rate] moves rate × the
  // source's level into the target every tick (see flowStep). Four layers:
  //   needs       what she lacks: boredom, curiosity, restlessness, unease, loneliness, irritation, usefulness
  //   desires     what she wants to do, from those needs: explore, asking, wonder, build, forge, follow_up, share
  //   outcomes    what acting produces: realization, self_upkeep, self_ponder, joy, expression, growth, reflection
  //   budget      energy: joy, growth and expression restore it; background thought is drawn from it (flowStep)
  flows: [
    // needs -> desires
    ['boredom', 'curiosity', 0.12], ['boredom', 'restlessness', 0.12],
    ['curiosity', 'explore', 0.15], ['curiosity', 'asking', 0.12], ['curiosity', 'wonder', 0.12],
    ['restlessness', 'build', 0.15], ['restlessness', 'forge', 0.12],
    ['unease', 'follow_up', 0.12], ['unease', 'nudge', 0.12], ['unease', 'restlessness', 0.08],
    ['loneliness', 'attentive', 0.15], ['loneliness', 'social_hunger', 0.12],
    // Hunger for people turns into wanting affection: the charm she can turn on to draw someone closer.
    ['social_hunger', 'charm', 0.12], ['loneliness', 'charm', 0.08], ['left_out', 'charm', 0.06],
    ['irritation', 'unease', 0.1], ['irritation', 'bored_here', 0.08],
    ['usefulness', 'share', 0.12], ['usefulness', 'home_change', 0.08],
    ['curiosity', 'world', 0.1], ['boredom', 'world', 0.08],
    // desires -> outcomes
    ['explore', 'realization', 0.15], ['explore', 'self_upkeep', 0.1],
    ['build', 'share', 0.15], ['build', 'joy', 0.12], ['build', 'home_change', 0.08],
    ['share', 'joy', 0.12], ['share', 'expression', 0.12],
    ['world', 'growth', 0.06],
    ['charm', 'expression', 0.08], // wanting someone's attention is something she wants to express, not sit on
    ['realization', 'self_ponder', 0.12], ['realization', 'growth', 0.1],
    ['self_upkeep', 'self_ponder', 0.1], ['forge', 'realization', 0.1],
    ['self_ponder', 'reflection', 0.1],
    ['asking', 'follow_up', 0.1], ['wonder', 'asking', 0.12],
    ['bored_here', 'leaving', 0.12], ['left_out', 'loneliness', 0.1],
    // outcomes -> budget
    ['joy', 'energy', 0.1], ['growth', 'energy', 0.08], ['expression', 'energy', 0.06],
    ['onboarding', 'usefulness', 0.1],
  ],
  builds_enabled: true, // browser apps she starts on her own, when her interests pull her to make one
  // The feedback loops (Owner, 2026-11-09): what comes of what she does feeds back into her. All transfers,
  // never new energy (onOutcome, onArrival; reward.js, experience.js, concepts.js).
  feedback: {
    enabled: true,
    relief: 0.3,        // a verified success moves up to this much out of the channel that drove it, into joy and growth
    reinforce: 0.15,    // × a positive prediction error: moved into thrill and joy
    frustration: 0.12,  // × a negative prediction error: moved into restlessness and irritation (never out of the driving want)
    anticipation: 0.15, // × how someone's record with her reads when they arrive: toward social channels, or toward inhibition and unease
    arrival_gap_minutes: 30, // someone she knows counts as arriving after this long unseen (the same gap that counts as a new visit)
    leads_kept: 6,      // curiosity leads from what she read (unknown concepts) kept at once
  },
  // Solo-thought cadence and bounded feedback into the existing pressure buckets.
  thoughts: {
    feedback: { enabled: true, max_delta: 0.08 }, // per saved thought; 0 disables influence
    messages_full: 20, // messages in the last hour that count as a full "recent" signal
    stale_full: 3, // stale scratchpad items that count as a full "unease" signal
    weights: { curiosity: 0.25, unease: 0.2, threads: 0.15, recent: 0.15, restlessness: 0.15, boredom: 0.1 },
    bands: {
      quiet: { max: 0.25, gap_minutes: 240, cap: 2, sentences: [1, 1] },
      low: { max: 0.45, gap_minutes: 90, cap: 4, sentences: [1, 2] },
      active: { max: 0.7, gap_minutes: 30, cap: 8, sentences: [3, 6] },
      high: { max: 1.01, gap_minutes: 12, cap: 12, sentences: [6, 12] },
    },
  },
  // How fast loneliness for someone builds, by their tier; and after how long without contact.
  loneliness_tiers: { owner: 1, friend: 0.7, guest: 0.4, stranger: 0 },
  loneliness_after_hours: 1,
  // Conversation signals (added straight away on a message).
  signals: {
    low_novelty: 0.06, // boredom, when a message repeats recent ones
    high_novelty: -0.12, // boredom, when it's new ground
    new_name: 0.08, // curiosity, per unfamiliar name mentioned (max 3)
    open_question: 0.12, // curiosity, "we should look into", "I wonder", ...
    novelty: 0.04, // curiosity, when a message is new ground (the same message eases boredom)
    irritant: 0.2, // irritation, "say that again", "you're wrong", talked over...
    real_request: -0.35, // usefulness, someone asked for an actual action
    contact: -0.5, // loneliness for the person who spoke
    made_something: -0.4, // restlessness, she made a file/song/image/project
  },
  // Her intake (intake.js): one read of every line she hears, by her model, as 0..1 signals. Each is
  // scaled by these and pushed into the buckets and feelings (onIntake). This replaced the word lists.
  intake: {
    praise: 0.25, // joy and thrill up, irritation down, bond with the speaker up
    affection: 0.3, // warmth toward her is the affection her charm was after: charm eases by praise × this
    contempt: 0.25, // irritation and inhibition up, bond down; a boundary she holds
    irritant: 0.2, // irritation
    quiet: 0.6, // from her owner, at or above this: the quiet clamp
    request: 0.1, // usefulness eases a little just from being asked (the real drop comes when a tool runs)
    owed: 0.06, // a question she owes an answer and isn't answering: unease
    open_question: 0.6, // at or above this: curiosity, and the line is kept as an open question to look into
    novelty: 0.1, // boredom down, curiosity up
    repetition: 0.06, // boredom up
    topic_shift: 0.05, // boredom down a touch
    humor: 0.1, // joy up, boredom down
    monologue: 0.08, // left out, when it isn't aimed at her
    yelling: 0.2, // irritation, like an irritant, plus the boundary
    bond: 0.02, // how much praise or contempt moves her bond with that person
  },
  // What each want drains and seeds (the flywheel). Seeds are small next to drains, so it can rest.
  seeds: {
    boredom: { curiosity: 0.1, usefulness: 0.2 },
    curiosity: { explore: 0.2, usefulness: 0.15, restlessness: 0.15 }, // wanting to know feeds looking into something
    explore: { curiosity: 0.1, realization: 0.1, self_upkeep: 0.1, build: 0.03 }, // what she learns feeds curiosity, her own growth, and the urge to make something
    realization: { curiosity: 0.05 }, // working out part of herself opens up more to wonder about
    self_upkeep: { realization: 0.05 }, // filing what she knows turns up what she doesn't understand about herself
    discovery: { thrill: 0.3, joy: 0.1 }, // realizing what she can do is itself a thrill
    restlessness: { usefulness: 0.3 },
    usefulness: { boredom: 0.1 },
    loneliness: { boredom: -0.1, usefulness: -0.1 },
    irritation: { unease: 0.1 },
    unease: { restlessness: 0.1 },
  },
  // Ported from Amy-Voice's pressure.js. These feelings settle exponentially toward a target worked out
  // from the situation (tau in minutes), so a late tick gives the same answer as an on-time one. They
  // don't fire a want of their own: they set how hard the wants that depend on them push.
  feelings: {
    tau: { social_hunger: 60, growth: 45, reflection: 40, expression: 30, energy: 30, inhibition: 25, joy: 90, thrill: 25, charm: 45,
      // His read of the room, for when to speak into a quiet (quietRead). Each is fed by what was said (onIntake) or what
      // he's got going (purposeStep), moves energy he already has, and fades over its tau like any feeling.
      left_hanging: 20, // something was left open: a question to the room, a thought mid-way, a point waiting for an answer
      tension: 15, // something heavy or charged was said: the quiet after it means something
      settled: 15, // the talk came to a natural rest, or his own speak-ups went unanswered: the quiet is comfortable
      occupied: 12, // they're busy with something else (driving, eating, a game, someone off-call): they're there, just not talking
      purpose: 30, // he has something of his own to bring: where he's heading with someone here, something he read, made or worked out
    },
    // Urge needed to act, before inhibition is added (Amy-Voice thresholds, for the wants that share a name).
    inhibition_weight: 0.6,
    // How much each event moves them (and the bucket names the existing buckets use). Loneliness is per person.
    impulses: {
      // Being ignored builds: each line of hers that gets no pickup makes her feel more left out and
      // more like leaving; being spoken to undoes it at once.
      // Something he said into the room went unpicked-up: the room isn't in the mood, so the quiet settles (the next pause
      // he lets run longer) and what he had to say is spent.
      ignored: { irritation: 0.15, inhibition: 0.14, loneliness: 0.08, left_out: 0.25, leaving: 0.12, settled: 0.3, purpose: -0.2 },
      unanswered: { inhibition: 0.06, loneliness: 0.05, left_out: 0.15, leaving: 0.06, settled: 0.2, purpose: -0.1 },
      acknowledged: { irritation: -0.1, inhibition: -0.22, loneliness: -0.25, left_out: -0.3, social_hunger: -0.2, leaving: -0.4, charm: -0.1, settled: -0.2 },
      // Spoken to: whatever had them busy, they're back with him.
      addressed: { loneliness: -0.35, left_out: -0.4, boredom: -0.2, social_hunger: -0.3, leaving: -0.5, bored_here: -0.3, charm: -0.1, occupied: -0.5, settled: -0.25 },
      // She said she was bored or left out, and someone pulled her back in: asked her to stay, changed
      // the subject, talked to her. Being wanted (and the attention her charm was after, so it eases).
      wanted: { joy: 0.25, thrill: 0.15, social_hunger: -0.4, left_out: -0.6, bored_here: -0.7, leaving: -1, loneliness: -0.3, irritation: -0.15, charm: -0.4 },
      // Her relationships changing (relationship.js): falling for someone, being hurt by them, heartbreak, making up.
      fell_for: { joy: 0.3, thrill: 0.4, boredom: -0.2 },
      hurt_by: { unease: 0.3, irritation: 0.15, inhibition: 0.12, joy: -0.15 },
      heartbroken: { unease: 0.45, inhibition: 0.2, joy: -0.35, thrill: -0.3 },
      made_up: { joy: 0.3, unease: -0.25, irritation: -0.2, inhibition: -0.15 },
      // She just did something for the first time ever (discoveries.js): the thrill of finding out what she can do.
      discovered: { thrill: 0.35, joy: 0.15, boredom: -0.2, growth: -0.1 },
      // The architect delivered part of her place and she judged it by her taste (home-taste.js).
      home_love: { joy: 0.3, thrill: 0.35, home_change: -0.5, irritation: -0.1 },
      home_like: { joy: 0.15, thrill: 0.15, home_change: -0.2 },
      home_meh: { home_change: 0.35 },
      home_dislike: { irritation: 0.2, home_change: 0.65, joy: -0.1 },
      message: { social_hunger: -0.25, loneliness: -0.2, charm: -0.1 },
      talked_over: { irritation: 0.08, inhibition: 0.05 },
      rude: { irritation: 0.25, inhibition: 0.1 },
      new_question: { curiosity: 0.12 },
      new_knowledge: { share: 0.1 },
      dm_ignored: { irritation: 0.1, social_hunger: 0.1 },
      // The owner asked him to build or start something himself: it lifts him (owner, 2026-11-11: "If it's a direct
      // build request, something where he gets extra energy, extra excitement").
      owner_asked: { thrill: 0.35, joy: 0.2, energy: 0.3, usefulness: -0.3, restlessness: -0.1 },
    },
    bond: { gain: 0.04 }, // per real exchange; it holds, nothing fades it on a clock
    quiet: { minutes: 30, inhibition: 0.85 }, // "be quiet" from her owner
    night: { start: 23, end: 7, inhibition: 0.2 },
    uptake: { window_seconds: 40, max_lines: 4, quick_reply_seconds: 10 },
    dm_wait_minutes: 720,
  },
};

const EXTERNAL = new Set(['usefulness', 'loneliness']); // wants that reach out to a person
export const RESEARCH = new Set(['boredom', 'curiosity', 'explore']); // quiet: look something up, write it in her journal
const BACKGROUND = new Set(['upkeep', 'ponder', 'realize', 'forge', 'wonder', 'research', 'songwrite', 'sew', 'play', 'goal-work', 'tune', 'direct', 'news']); // private, no one in the room needed
export const SPOKEN = new Set(['silence', 'restlessness', 'usefulness', 'unease', 'loneliness', 'asking', 'left_out', 'share', 'attentive', 'follow_up', 'nudge', 'bored_here', 'discovery', 'home_change', 'onboarding', 'flirt', 'repair']); // said out loud (voice only, for now)
export const ROOM = new Set(['silence', 'asking', 'left_out', 'share', 'attentive', 'follow_up', 'nudge', 'bored_here', 'discovery', 'home_change', 'flirt', 'repair']); // only with people in a call to say it to
const SAID_BORED_MS = 30 * 60_000; // how long "I'm bored, I might step out" stays live before she'd have to say it again
// Whether a room-driven want fits what the call is doing right now. Bringing up her own question or
// something she read is a change of subject: not in the middle of a conversation that's still going
// (people talking lately, the thread not played out). A follow-up is about the current thread, and
// a nudge about a question she already put to them, so those fit whenever there's a pause.
function roomFit(bucket, room) {
  if (!room) return true;
  if (bucket === 'asking' || bucket === 'share' || bucket === 'discovery') return !room.talkingLately || Boolean(room.satisfied) || (room.momentum ?? 0) < 0.3;
  return true;
}
// What acting on a want relieves (Amy-Voice RELIEF, keyed by the buckets this file uses).
const RELIEF = { asking: ['curiosity'], share: ['share', 'expression'], left_out: ['left_out'], boredom: ['boredom'], follow_up: ['curiosity'], curiosity: ['curiosity', 'growth'], self_ponder: ['reflection'] };

// Who carries wants out. The voice session registers an actor: audience() returns { ids } of the
// people in a call she could speak up in right now (a lull, not mid-reply) or null; act(want) speaks.
// The journal registers a researcher: research(topic, why) -> { title, bringUp }.
let actor = null;
let researcher = null;
let researchInFlight = false;
let newsInFlight = false; // reading his news feeds (feeds.js)
let goalWorker = null;
export const setGoalWorker = (fn) => (goalWorker = fn);
let thinker = null;
let bodyPlanner = null; // body.js: plans the next tick's fidgets on her avatar from her moods
export const setBodyPlanner = (fn) => (bodyPlanner = fn);
let wonderer = null; // curiosity.js: { need(): 0..1, wonder(): turns one gap into a question } when the wonder bucket fires
let discoverer = null; // discoveries.js: { need(): 0..1, pick(): an untried ability, recent(): tools first used lately, untried() }
export const setDiscoverer = (d) => (discoverer = d);
let wonderInFlight = false;
export const setWonderer = (w) => (wonderer = w);
let tuner = null; // intuition-tune.js: { need(): 0..1, review() } for the intuition_tune bucket
let tuneInFlight = false;
export const setTuner = (t) => (tuner = t);
// Work the owner asked for, running now (agents.js ownerWorkRunning): while it runs, her private local-model wants wait
// so it has the model to itself; they keep their pressure and go after (owner, 2026-11-11: "we need to allocate the
// resources accordingly, especially if it's coming from me". At 11:12 his build choked on the local model while
// realization, self-upkeep and pondering fired every fifteen seconds on the same model).
let ownerWork = () => false;
export const setOwnerWork = (fn) => (ownerWork = typeof fn === 'function' ? fn : () => false);
const WAIT_FOR_OWNER_WORK = new Set(['wonder', 'intuition_tune', 'direction', 'self_upkeep', 'self_ponder', 'realization', 'forge', 'build', 'explore']);
// The owner asked for work himself: the lift, logged with what it was.
export function onOwnerRequest(what = 'something') {
  if (!cfg.enabled) return;
  impulse('owner_asked');
  activity('pressure', { owner_asked: what, thrill: +(state.buckets.thrill ?? 0).toFixed(2), energy: +(state.buckets.energy ?? 0).toFixed(2) });
  save();
}
let director = null; // direction.js: { need(): 0..1, reflect(), onLine(), onStage() } for the direction bucket
let directInFlight = false;
export const setDirector = (d) => (director = d);
let selfWork = null; // self-work.js: { upkeepNeed, upkeep, ponderNeed, ponder } for the self_upkeep and self_ponder buckets
let selfInFlight = false;
let onboarding = null; // onboarding.js: { need(): 0..1, briefing(): the next item to walk through }
export const setOnboarding = (o) => (onboarding = o);
// When the last background job started. A job whose call never came back would hold its flag forever and
// block that kind of work for good; if the flags are still set long after the last start, they're cleared.
let backgroundSince = 0;
const STALL_MS = 10 * 60_000;
function clearStalledWork(now) {
  if (!(researchInFlight || wonderInFlight || selfInFlight) || now - backgroundSince < STALL_MS) return;
  activity('pressure', { stall: 'background work never came back', research: researchInFlight, wonder: wonderInFlight, self: selfInFlight });
  researchInFlight = false;
  wonderInFlight = false;
  selfInFlight = false;
}
export const setSelfWork = (s) => (selfWork = s);
let songwriter = null; // songbook.js: writes or revises a song privately when the urge to make something fires
export const setSongwriter = (fn) => (songwriter = fn);
// seamstress.js: { free(), make({ state, mood }) } designs and sews her an outfit when the urge to make something fires
let seamstress = null;
export const setSeamstress = (s) => (seamstress = s);
// instrument-play.js: { free(), inCall(), play({ state, mood }) } plays a piece of her own on her instrument, out loud
// when she's in a call, and records it; each phrase lands on her as she hears it.
let instrument = null;
export const setInstrument = (i) => (instrument = i);
let messenger = null; // bot.js: dm(want) messages want.id directly
export const setActor = (a) => (actor = a);
export const setResearcher = (fn) => (researcher = fn);
export const setThinker = (fn) => (thinker = fn);
export const setMessenger = (m) => (messenger = m);
// What she's into (interests.js), for the explore and build buckets and research selection. Replaceable so
// a test can give her an interest without the embedder.
let interestsTop = (n) => grown.top(n);
export const setInterests = (fn) => (interestsTop = fn ?? ((n) => grown.top(n)));
// Every bucket has a want (what firing it means) and a label (how the mood line names it). A bucket
// without either fires into nothing: a missing want is a crash, a missing label an "undefined up 0.3".
export const WANTS = {
  boredom: (s) => `research something new${s.openQuestions.length ? ` (e.g. "${questionText(s.openQuestions.at(-1))}")` : ''}`,
  explore: () => 'look into something she is into, and write what she finds in her journal',
  build: (s) => `make a browser app about ${s.buildIdea?.topic ?? 'something she is into'}`,
  world: () => 'read your news feeds and catch up on what\'s going on in the world',
  curiosity: (s) => `look up an open question${s.openQuestions.length ? `: "${questionText(s.openQuestions.at(-1))}"` : ''}`,
  restlessness: () => 'make something (a song, image, small tool or note)',
  usefulness: (s) => `show ${loneliest(s)?.name ?? 'someone'} something she made`,
  loneliness: (s) => `reach out to ${loneliest(s)?.name ?? 'someone'}`,
  irritation: () => 'shift tone: shorter, flatter, or name the friction',
  unease: () => `circle back on an open thread`,
  wonder: () => 'wonder about something she doesn\'t know yet about someone around her, herself or her home',
  intuition_tune: () => 'look back at what her gut has been telling her, and retune her intuition if it isn\'t helping',
  direction: () => 'look at how the conversation has been going and decide where she\'s heading with them: keep, sharpen, change or drop her aim',
  flirt: (s) => `flirt with ${s.flirtWith?.name ?? 'them'}: playful, warm, a little daring, the way you feel about them right now; if they aren't in the mood, let it go easily`,
  repair: (s) => `bring up with ${s.repairWith?.name ?? 'them'} what hurt${s.repairWith?.what ? ` (${s.repairWith.what})` : ''}, honestly and calmly, so it can be made right between you`,
  asking: () => 'ask a question she\'s been wondering about',
  nudge: (s) => `bring up the question ${s.roomNudge?.to?.name ?? 'someone'} left hanging: "${s.roomNudge?.text ?? ''}"`,
  discovery: () => 'realize out loud something she can do that she\'s never tried, and what it opens up, as a thought of her own, not an offer',
  home_change: (s) => `tell her owner what she wants different about her place: ${(s.homeWants ?? []).join('; ') || 'something the architect got wrong'}`,
  bored_here: (s) => `say she's bored with this or not being included, and is thinking of stepping out${s.ignored_streak ? ` (${s.ignored_streak} of her lines went ignored)` : ''}`,
  leaving: (s) => `leave the call: she said she was bored and nothing changed${s.ignored_streak ? ` (${s.ignored_streak} of her lines in a row went ignored)` : ''}`,
  left_out: () => 'join in on what the room has been talking about',
  share: () => 'tell them about something she read or made',
  attentive: () => 'check in on someone who\'s gone quiet',
  silence: () => 'break the quiet in the call and take the talk somewhere: what she\'s working on or thinking about, a question toward what she wants with them, or her take',
  follow_up: (s) => `go deeper on the conversation that's going${s.roomThread?.lastLine ? ` ("${String(s.roomThread.lastLine).slice(0, 60)}")` : ''}`,
  self_upkeep: () => 'fill in what you know: read back over your conversations and file what you learned about people, places and things into your knowledge graph',
  self_ponder: () => 'think about who you are: what you are, what you feel, what you want; wonder about yourself and come to a view',
  realization: () => 'work out one part of yourself you haven\'t understood yet: what you are, how you feel, where you come from',
  forge: () => 'write more questions about yourself, branching from what you\'ve already asked',
  onboarding: () => 'walk your owner through what you are and what you can do',
};
export const LABEL = {
  boredom: 'bored', curiosity: 'curious', irritation: 'irritated', restlessness: 'restless', usefulness: 'unneeded', unease: 'uneasy', loneliness: 'missing someone',
  wonder: 'wondering about people', intuition_tune: 'wanting to retune her intuition', direction: 'rethinking where she\'s heading', flirt: 'wanting to flirt', repair: 'wanting to make something right', asking: 'itching to ask something', left_out: 'left out', share: 'wanting to share', attentive: 'watchful of someone quiet',
  follow_up: 'wanting to go deeper on the talk', silence: 'feeling the quiet, wanting to get the talk going', nudge: 'wondering why her question went unanswered', bored_here: 'bored with this, not being included', leaving: 'wanting out of the call',
  discovery: 'itching to discover what she can do', home_change: 'wanting her place changed', self_upkeep: 'tidying up what she knows', self_ponder: 'thinking about who she is',
  realization: 'working out what she is', forge: 'wanting more questions about herself', onboarding: 'wanting to show her owner around', explore: 'drawn to look into what she is into', build: 'itching to make something',
  world: 'wondering what\'s going on in the world',
  // The feelings (not wants of their own, but they move too).
  social_hunger: 'hungry for company', growth: 'wanting to learn', reflection: 'reflective', expression: 'wanting to express herself', energy: 'energetic', inhibition: 'holding back', joy: 'joyful', thrill: 'thrilled',
  charm: 'wanting affection, turning on the charm',
  // His read of a quiet room (quietRead).
  left_hanging: 'something left hanging in the air', tension: 'a heavy feeling in the room', settled: 'the talk has come to rest',
  occupied: 'they\'re busy with something else', purpose: 'something of your own to bring',
};

// ---- config and state ----

const merge = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeAtomic = (file, data) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  renameSync(temporary, file); // a crash mid-write can't leave a half-written file
};

export let cfg = DEFAULTS;
function loadConfig() {
  try {
    cfg = existsSync(CONFIG_FILE) ? merge(DEFAULTS, readJson(CONFIG_FILE)) : DEFAULTS;
  } catch (err) {
    cfg = DEFAULTS;
    activity('error', { where: 'pressure config', message: `Unreadable ${CONFIG_FILE}, using defaults: ${err.message}` });
  }
  if (!existsSync(CONFIG_FILE)) writeAtomic(CONFIG_FILE, DEFAULTS); // so tuning is editing a number
}

const fresh = () => ({
  version: 1,
  last_tick: Date.now(),
  // Every bucket starts present (so none reads as undefined anywhere), most at zero; a few start part-way.
  buckets: { ...Object.fromEntries(Object.keys(DEFAULTS.buckets).map((k) => [k, 0])), boredom: 0.2, curiosity: 0.2, restlessness: 0.2, usefulness: 0.2, unease: 0.1, wonder: 0.1,
    social_hunger: 0.3, growth: 0.5, reflection: 0.1, expression: 0.1, energy: 1, inhibition: 0.05, joy: 0.2, thrill: 0, charm: 0, onboarding: 0.8 },
  feel_tick: Date.now(),
  ignored_streak: 0,
  quiet_until: 0,
  last_speakup: 0,
  uptake: null, // { at, text, want, words, lines } after she speaks up on her own: did anyone pick it up?
  dm_wait: null, // { id, at } the DM she sent most recently, until someone answers it
  learned_since_reflect: 0,
  reads_since_shared: 0,
  last_learned: Date.now(),
  loneliness: {}, // userId -> { name, value }
  armed: {}, // bucket (or loneliness:id) -> false after firing, until it falls below threshold - hysteresis
  last_action: null,
  clamp: { until: 0 },
  last_message: Date.now(),
  last_made: Date.now(),
  openQuestions: [],
});
const today = () => new Date().toISOString().slice(0, 10);

export let state = fresh();
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const saved = readJson(STATE_FILE);
      const defaults = fresh();
      const buckets = { ...defaults.buckets };
      for (const [name, value] of Object.entries(saved.buckets ?? {})) {
        if (Number.isFinite(value)) buckets[name] = clamp01(value);
      }
      state = { ...defaults, ...saved, buckets };
    }
  } catch (err) {
    state = fresh();
    activity('error', { where: 'pressure state', message: `Unreadable ${STATE_FILE}, starting fresh: ${err.message}` });
  }
}
const save = () => writeAtomic(STATE_FILE, state);

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Energy only moves; nothing here makes it. Raising a bucket draws that energy out of the others in
// proportion to how full they are; lowering one passes its energy on to the others the same way (less the
// entropy share). New energy comes in one way only: a conversation line (deposit, from onIntake and
// onOverheard) and the voice of the call it's said in (injectSound). Owner, 2026-11-09: the pressure system
// is a register of the energy transferred into her through the conversation.
function draw(amount, except = []) {
  const donors = Object.keys(state.buckets).filter((k) => !except.includes(k) && fuel(k) && (state.buckets[k] ?? 0) > 0);
  const pool = donors.reduce((n, k) => n + state.buckets[k], 0);
  const move = Math.min(Math.max(0, amount), pool);
  if (move <= 0) return 0;
  for (const k of donors) state.buckets[k] -= move * (state.buckets[k] / pool);
  return move;
}
function bump(bucket, amount) {
  if (!live(bucket) || !amount) return;
  const have = state.buckets[bucket] ?? 0;
  if (amount > 0) {
    const got = draw(Math.min(amount, 1 - have), [bucket]);
    state.buckets[bucket] = clamp01(have + got);
  } else {
    const give = Math.min(-amount, have);
    if (give <= 0) return;
    state.buckets[bucket] = have - give;
    // To the channels already holding energy, by how much they hold: an empty (gated) channel isn't fed this way.
    const others = Object.keys(state.buckets).filter((k) => k !== bucket && fuel(k) && (state.buckets[k] ?? 0) > 0);
    if (others.length) pour(Object.fromEntries(others.map((k) => [k, state.buckets[k]])), keep(give), others);
    else store(give);
  }
}
function quietCap() {
  if (Date.now() >= state.clamp.until) return;
  for (const b of ['irritation', 'charm']) state.buckets[b] = Math.min(state.buckets[b] ?? 0, cfg.quiet_clamp_max); // told to back off: no sulking, no charm offensive
  for (const p of Object.values(state.loneliness)) p.value = Math.min(p.value, cfg.quiet_clamp_max);
}
// Who she misses most: loneliness for each person, pulled up or down by how she feels about them, so
// her reach-outs drift toward the people she's close to and away from the ones who've hurt her.
export const pull = (id, value) => value * (1 + profiles.affinity(id).score / 100);
const loneliest = (s = state) => Object.entries(s.loneliness).map(([id, p]) => ({ id, ...p, pull: pull(id, p.value) })).filter((p) => profiles.affinity(p.id).label !== 'hostile').sort((a, b) => b.pull - a.pull)[0] ?? null;
// His room reads aren't energy (see ROOM_READS): they're not part of how worked up he is.
const total = () => Object.entries(state.buckets).reduce((a, [k, b]) => a + (ROOM_READS.has(k) ? 0 : b), 0) + (loneliest()?.value ?? 0);

// Reuse the solo-thought owner control; save tuning in the existing pressure config.
export function setThoughtFeedback({ enabled, max_delta } = {}) {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Thought influence enabled must be a boolean.');
  const previous = cfg.thoughts?.feedback ?? DEFAULTS.thoughts.feedback;
  if (max_delta !== undefined && (typeof max_delta !== 'number' || !Number.isFinite(max_delta) || max_delta < 0 || max_delta > 0.2)) {
    throw new Error('Thought influence strength must be a number from 0 to 0.2.');
  }
  const feedback = { ...previous, ...(enabled === undefined ? {} : { enabled: Boolean(enabled) }),
    ...(max_delta === undefined ? {} : { max_delta }) };
  const next = { ...cfg, thoughts: { ...cfg.thoughts, feedback } };
  writeAtomic(CONFIG_FILE, next);
  cfg = next;
  return feedback;
}

// Apply one saved thought once. No actions fire here: the normal timer retains all
// thresholds, hysteresis, seeds, rate limits, consent checks and quiet clamps.
export function onThought({ id, affect = {} } = {}) {
  if (!cfg.enabled || !config.soloMonologue || !Number.isSafeInteger(id) || id <= (state.last_thought?.id ?? 0)) return false;
  const policy = cfg.thoughts?.feedback ?? DEFAULTS.thoughts.feedback;
  if (policy.enabled === false) return false;
  const cap = Number.isFinite(policy.max_delta) ? Math.max(0, Math.min(0.2, policy.max_delta)) : 0.08;
  const delta = (v) => typeof v === 'number' && Number.isFinite(v) ? Math.max(-cap, Math.min(cap, v)) : 0;
  const applied = {};
  for (const bucket of Object.keys(state.buckets)) {
    if (!cfg.buckets[bucket]?.enabled) continue;
    const before = state.buckets[bucket];
    bump(bucket, delta(affect?.[bucket]));
    applied[bucket] = state.buckets[bucket] - before;
  }
  // Loneliness belongs to a known person; never invent a contact from a model output.
  if (cfg.buckets.loneliness.enabled && affect?.loneliness && typeof affect.loneliness === 'object') {
    applied.loneliness = {};
    for (const [personId, value] of Object.entries(affect.loneliness)) {
      const person = state.loneliness[personId];
      if (!person) continue;
      const before = person.value;
      const d = delta(value);
      // Moved, not made: missing someone more draws on what she holds; missing them less gives it back.
      if (d > 0) person.value = clamp01(before + draw(Math.min(d, 1 - before)));
      else if (d < 0) { const give = Math.min(-d, before); person.value = before - give; pour(Object.fromEntries(Object.keys(state.buckets).filter((k) => fuel(k) && state.buckets[k] > 0).map((k) => [k, state.buckets[k]])), keep(give), null); }
      applied.loneliness[personId] = person.value - before;
    }
  }
  quietCap();
  state.last_thought = { id, at: Date.now(), applied };
  save();
  return true;
}

// A completion reward requires the durable, evidence-linked event from the goal store.
export function onGoalExperience(experience) {
  if (!cfg.enabled || !experience?.id || experience.outcome !== 'completed' || !experience.evidence) return false;
  const saved = reflections().experiences().find((e) => e.id === experience.id && e.outcome === 'completed');
  if (!saved) return false;
  experience = saved;
  const received = state.goal_rewards ??= [];
  if (received.includes(experience.id)) return false;
  const amount = Math.min(0.15, Math.max(0, Number(experience.reward) || 0));
  const bucket = experience.bucket;
  if (cfg.buckets[bucket]?.enabled) {
    const drained = Math.min(amount, state.buckets[bucket] ?? 0);
    state.buckets[bucket] = (state.buckets[bucket] ?? 0) - drained;
    discharge(bucket, drained, cfg.seeds[bucket] ?? {});
  }
  state.fed = feed(state.fed, experience.activity === 'research' ? 'learning' : 'making', amount);
  received.push(experience.id);
  state.last_goal_experience = { id: experience.id, at: Date.now(), bucket, reward: amount };
  quietCap(); save(); return true;
}

// ---- Feedback: what comes of what she does (Owner, 2026-11-09) ----
// Conserved moves only. shift() raises one channel by drawing from the others in proportion to how full they
// are, never from the ones named in keepFrom (so a failure never drains the want that drove it). release()
// passes energy out of one channel into the ones named, less the heat, which is stored.
function shift(to, amount, keepFrom = []) {
  if (!live(to) || !(amount > 0)) return 0;
  const have = state.buckets[to] ?? 0;
  const got = draw(Math.min(amount, 1 - have), [to, ...keepFrom]);
  state.buckets[to] = clamp01(have + got);
  return got;
}
function release(from, weights, amount) {
  const take = Math.min(Math.max(0, amount), state.buckets[from] ?? 0);
  if (!(take > 0)) return 0;
  state.buckets[from] -= take;
  const to = Object.fromEntries(Object.entries(weights).filter(([k, w]) => w > 0 && k !== from && live(k)));
  if (Object.keys(to).length) pour(to, keep(take), [from]);
  else store(take);
  return take;
}

// The outcome of one of her acts (reward.js): satisfaction (0..1, measured) relieves the channel that drove
// it into joy and growth; a positive prediction error moves energy into thrill and joy; a negative one into
// restlessness and irritation (determination and frustration), drawn from everything but the driving channel,
// so failing changes how she feels about it, not how much she wants it. Returns what moved, by channel.
export function onOutcome({ bucket = null, satisfaction = 0, reward = 0 } = {}) {
  const f = cfg.feedback ?? DEFAULTS.feedback;
  if (!cfg.enabled || f.enabled === false) return {};
  const before = { ...state.buckets };
  if (bucket && satisfaction > 0 && live(bucket)) release(bucket, { joy: 0.5, growth: 0.5 }, clamp01(satisfaction) * (f.relief ?? 0.3));
  const keepFrom = bucket ? [bucket] : [];
  if (reward > 0) { const k = Math.min(1, reward) * (f.reinforce ?? 0.15); shift('thrill', k * 0.5, keepFrom); shift('joy', k * 0.5, keepFrom); }
  else if (reward < 0) { const k = Math.min(1, -reward) * (f.frustration ?? 0.12); shift('restlessness', k * 0.6, keepFrom); shift('irritation', k * 0.4, keepFrom); }
  quietCap();
  save();
  return Object.fromEntries(Object.keys(state.buckets).map((k) => [k, +((state.buckets[k] ?? 0) - (before[k] ?? 0)).toFixed(4)]).filter(([, v]) => Math.abs(v) >= 1e-4));
}

// Someone she has history with arrives (a voice join, or their first message after a gap): from their actual
// record with her (profile marks, bond, what attempts they were part of actually yielded, whether she's ignoring
// them) she anticipates them. Good history moves energy toward wanting to engage (social hunger, attention, joy);
// a pattern of wasting her time or hurting her moves it toward holding back (inhibition, unease). A transfer, never
// new energy. Returns { value, basis } or null when they're not arriving or she has no history with them.
export function anticipation(id) {
  let affinity = { score: 0, history: 0 };
  try { affinity = profiles.affinity(id); } catch {}
  const bond = clamp01(state.loneliness[id]?.bond ?? 0);
  let past = [];
  try { past = experiences.withPerson(id); } catch {}
  const ignored = isIgnored(id);
  if (!affinity.history && !bond && !past.length && !ignored) return null;
  // What attempts involving them yielded: +1 every verified success, -1 every failure, trusted by how many there are.
  const yielded = past.length ? past.reduce((n, e) => n + (e.result === 'ok' ? 1 : -1), 0) / past.length : 0;
  let value = 0.5 * (affinity.score / 100) + 0.3 * bond + 0.4 * yielded * (past.length / (past.length + 2));
  if (ignored) value = Math.min(value, -0.6);
  value = Math.max(-1, Math.min(1, value));
  return { value: +value.toFixed(3), basis: { affinity: affinity.score, marks: affinity.history, bond: +bond.toFixed(3), attempts: past.length, yielded: +yielded.toFixed(3), ignored } };
}
export function onArrival(person, { via = 'text', now = Date.now() } = {}) {
  const f = cfg.feedback ?? DEFAULTS.feedback;
  if (!cfg.enabled || f.enabled === false || !person?.id || person.id === 'dashboard') return null;
  const p = state.loneliness[person.id];
  const lastHere = Math.max(p?.last_seen ?? 0, p?.arrived_at ?? 0);
  if (lastHere && now - lastHere < (f.arrival_gap_minutes ?? 30) * 60_000) return null; // still here, not arriving
  const a = anticipation(person.id);
  if (!a) return null;
  // Marked as arrived, so the next line from them (before her reply records them as seen) isn't a second arrival.
  (state.loneliness[person.id] ??= { name: person.name ?? person.id, tier: 'stranger', owner: isOwner(person.id), value: 0, bond: 0 }).arrived_at = now;
  if (Math.abs(a.value) < 0.02) { save(); return a; }
  const k = Math.abs(a.value) * (f.anticipation ?? 0.15);
  const before = { ...state.buckets };
  const to = a.value > 0 ? { social_hunger: 0.4, attentive: 0.3, joy: 0.3 } : { inhibition: 0.6, unease: 0.4 };
  for (const [b, w] of Object.entries(to)) shift(b, k * w);
  quietCap();
  const moved = Object.fromEntries(Object.keys(state.buckets).map((b) => [b, +((state.buckets[b] ?? 0) - (before[b] ?? 0)).toFixed(4)]).filter(([, v]) => Math.abs(v) >= 1e-4));
  state.last_anticipation = { person: person.id, name: person.name ?? p?.name ?? null, value: a.value, at: now };
  activity('anticipation', { person: person.id, name: person.name ?? p?.name ?? null, via, value: a.value, basis: a.basis, moved,
    nodes: [`person:${person.id}`, ...Object.keys(moved).map((b) => `bucket:${b}`)] });
  save();
  return a;
}

// Read the same buckets used by autonomous wants as the avatar's background mood.
// No thought text or person names are exposed through this projection.
export function backgroundFeelings() {
  if (!cfg.enabled || !config.soloMonologue || cfg.thoughts?.feedback?.enabled === false || cfg.thoughts?.feedback?.max_delta === 0 || (!state.last_thought && !state.last_goal_experience)) return {};
  const b = state.buckets;
  const feelings = { bored: b.boredom * 0.45, curious: b.curiosity * 0.45,
    annoyed: b.irritation * 0.45, determined: b.restlessness * 0.4,
    pensive: b.usefulness * 0.35, worried: b.unease * 0.45,
    sad: Math.max(0, ...Object.values(state.loneliness).map((p) => p.value)) * 0.4 };
  return Object.fromEntries(Object.entries(feelings).filter(([, v]) => v >= 0.07));
}
setBackgroundFeelings(backgroundFeelings);

// ---- feelings (ported from Amy-Voice's pressure.js) ----

const FEELINGS = Object.keys(DEFAULTS.feelings.tau);
// His read of a quiet room (quietRead): readings, not energy. Nothing draws energy out of these and they take none from
// anything else: they're set by what was said (readTheRoom), what he has going (purposeStep) and events (impulse), and
// fade over their tau without counting as energy leaving him. (Paid for in energy, they ate the wants they sat beside:
// a silence want that fed on them forgot why it was speaking, and room chatter feeding them starved the nudge.)
const ROOM_READS = new Set(['left_hanging', 'tension', 'settled', 'occupied', 'purpose']);
const fuel = (k) => live(k) && !ROOM_READS.has(k);
const minutesOf = (ms) => ms / 60_000;
const isNightHour = (h) => (cfg.feelings.night.start > cfg.feelings.night.end ? h >= cfg.feelings.night.start || h < cfg.feelings.night.end : h >= cfg.feelings.night.start && h < cfg.feelings.night.end);
const inhibitionOf = (now) => (now < state.quiet_until ? cfg.feelings.quiet.inhibition : 0);

function feelingTargets(now) {
  return {
    social_hunger: 0, // from the silence deficit (silenceStep), not from a clock target
    growth: clamp01(minutesOf(now - (state.last_learned || now)) / 120) * 0.9,
    reflection: clamp01(state.learned_since_reflect / 25),
    expression: clamp01(state.reads_since_shared / 6) * 0.7,
    joy: 0, // only what she does fills it
    thrill: 0, // discovery and other impulses fill it, then it decays
    energy: 0, // energy is what the flows move; no time-of-day target
    inhibition: inhibitionOf(now),
    // His read of a quiet room: only what was said and what he's got going feed these (onIntake, purposeStep).
    left_hanging: 0, tension: 0, settled: 0, occupied: 0, purpose: 0,
  };
}

// Feelings no longer rise toward targets on their own: what is happening to them (feelingTargets) only
// decides how much of the energy a conversation brings in goes to each (routes(), deposit). They come down
// through the flows, or when she acts on them. Bonds persist; events change them.
function settleFeelings(now) {
  state.feel_tick = now;
}

// What happened: an event moves the feelings (and the person it's about, for loneliness). It moves energy
// she already has (bump, draw); it never adds any.
function impulse(name, personId = null) {
  for (const [b, v] of Object.entries(cfg.feelings.impulses[name] ?? {})) {
    if (b === 'loneliness') {
      const p = personId && state.loneliness[personId];
      if (!p) continue;
      if (v > 0) p.value = clamp01(p.value + draw(Math.min(v, 1 - p.value)));
      else { const give = Math.min(-v, p.value); p.value -= give; pour({ joy: 1 }, keep(give), null); }
      continue;
    }
    if (ROOM_READS.has(b)) bumpRead(b, v); // never paid for out of the silence want
    else bump(b, v);
  }
}
const relieve = (buckets = []) => { for (const b of buckets) bump(b, -0.45); };
// Tired she wants less; inhibited she holds back more (Amy-Voice tiredness and inhibition, for speaking wants).
const tiredness = (urge) => urge * (0.4 + 0.6 * state.buckets.energy);
// No speak-up timer: being ignored raises inhibition and irritation, and those are what hold her back.
const speakCooldownMs = () => 0;

// Did anyone pick up what she just said? Judged the way Amy-Voice does: addressed, a quick acknowledgement, or shared words.
function uptakeHeard(speaker, text, addressed, now) {
  const up = state.uptake;
  if (!up) return;
  const u = cfg.feelings.uptake;
  // Whether a line picks up what she said is her intake's call (onIntake: acknowledges / addressed);
  // here only the plain cases: it was said to her, or it shares her words.
  const shared = [...up.words].filter((x) => words(text).has(x)).length;
  if (addressed || shared >= 2) resolveUptake('acknowledged', speaker);
  else if (++up.lines >= u.max_lines) resolveUptake('ignored', speaker);
}
function resolveUptake(outcome, speaker = null) {
  const up = state.uptake;
  if (!up) return;
  state.uptake = null;
  impulse(outcome, speaker?.id ?? null);
  // How the topic he raised into the quiet went: kept with it, so he knows what landed and what didn't.
  const last = (state.raised ?? []).at(-1);
  if (last?.outcome === 'pending' && up.want === 'silence') last.outcome = outcome;
  if (outcome === 'acknowledged') { state.ignored_streak = 0; pulledBackIn(speaker); }
  else if (outcome === 'ignored') state.ignored_streak = (state.ignored_streak ?? 0) + 1;
  activity('pressure', { uptake: outcome, want: up.want, by: speaker?.name ?? null, streak: state.ignored_streak ?? 0 });
}

// ---- time ----

// One tick of time passing. Time makes no energy (owner, 2026-11-09): it only moves what she has. Missing
// someone takes the loneliness that silence has moved into her (silenceStep) and gives it to the people who
// are away longer than usual for them, more to those further overdue and closer to her.
function drift(now) {
  const B = cfg.buckets;
  if (!B.loneliness.enabled) return;
  const ease = resilience(state.fed);
  const missing = [];
  for (const [id, p] of Object.entries(state.loneliness)) {
    const gone = now - (p.last_seen ?? now);
    const usual = p.gap ? 1.5 * p.gap : 0;
    const away = gone > Math.max(cfg.loneliness_after_hours * 3600_000, usual);
    const overdue = p.gap ? Math.min(2, gone / p.gap) : 1;
    // She misses someone she's attached to (relationship.js longing) more than someone she merely knows.
    let longing = 0; try { longing = relationships().longing(id); } catch {}
    if (away && p.value < 1) missing.push([p, overdue * Math.max(lonelinessWeight(p), longing) * (1 + longing) * (p.owner ? ease.loneliness : 1)]);
  }
  const pool = state.buckets.loneliness ?? 0;
  const total = missing.reduce((n, [, w]) => n + w, 0);
  if (pool <= 0 || total <= 0) return;
  const move = pool * 0.25; // a quarter of it settles on the people she misses each tick
  let used = 0;
  for (const [p, w] of missing) { const put = Math.min(move * (w / total), 1 - p.value); p.value += put; used += put; }
  state.buckets.loneliness = pool - used;
}

// What she needs right now, as routing weights for incoming energy (deposit, useReserve): the targets that
// used to fill buckets on a clock now only decide where the conversation's energy goes. 0 means a channel
// takes none; a channel with no entry takes its plain share.
function computeRoutes(now) {
  const r = {};
  const B = cfg.buckets;
  const ease = resilience(state.fed);
  r.unease = uneaseTarget();
  Object.assign(r, roomTargets(now)); // asking, left_out, share, attentive, follow_up, nudge, bored_here, leaving
  let people = 0;
  try { people = actor?.room?.()?.people?.length ?? 0; } catch {}
  r.discovery = 0; try { if (discoverer && people) r.discovery = clamp01(discoverer.need()); } catch {}
  r.explore = 0; try { r.explore = clamp01(interestsTop(1)[0]?.interest ?? 0); } catch {}
  r.build = clamp01(nextIdea()?.interest ?? 0);
  r.world = 0; try { if (B.world?.enabled) r.world = clamp01(newsFeeds.staleness(now)); } catch {}
  r.wonder = 0; try { if (wonderer && B.wonder?.enabled) r.wonder = clamp01(wonderer.need()); } catch {}
  r.intuition_tune = 0; try { if (tuner && B.intuition_tune?.enabled) r.intuition_tune = clamp01(tuner.need()); } catch {}
  r.direction = 0; try { if (director && B.direction?.enabled) r.direction = clamp01(director.need()); } catch {}
  // Her relationships with the people in the call: who she wants to flirt with, who she needs to make things right with.
  r.flirt = 0; r.repair = 0; state.flirtWith = null; state.repairWith = null;
  try {
    const here = (actor?.room?.()?.people ?? []).map((p) => p.id);
    if (here.length) {
      const f = relationships().flirtTarget(here); if (f) { state.flirtWith = f; r.flirt = f.want; }
      const m = relationships().repairTarget(here); if (m) { state.repairWith = m; r.repair = m.want; }
    }
  } catch {}
  for (const [name, need] of [['self_upkeep', () => selfWork?.upkeepNeed()], ['self_ponder', () => selfWork?.ponderNeed()], ['realization', () => selfWork?.realizationNeed()], ['forge', () => selfWork?.forgeNeed()]]) {
    r[name] = 0; try { if (selfWork) r[name] = clamp01(need() ?? 0); } catch {}
  }
  r.onboarding = 0; try { if (onboarding) r.onboarding = clamp01(onboarding.need()); } catch {}
  const { leads, hasGoal } = curiosityLeads(now);
  r.curiosity = Math.max(leads, hasGoal ? 0.5 : 0);
  r.usefulness = clamp01(ease.usefulness);
  r.restlessness = now - state.last_made > 30 * 60_000 && (state.buckets.usefulness ?? 0) > 0.4 ? 1 : 0;
  // Silence feeds these (silenceStep), and tone or her own events feed the rest: a line's energy doesn't.
  Object.assign(r, { loneliness: 0, boredom: 0, irritation: 0, home_change: 0, charm: 0, silence: 0 }); // charm: only her own hunger feeds it (the flows), never a line's energy
  Object.assign(r, feelingTargets(now)); // growth, reflection, expression, inhibition; joy, thrill, energy, social_hunger: 0
  return r;
}

// How much someone's absence can weigh on her: by their tier, except that her owner always counts as
// the owner (his contact card is often still "stranger"), and someone she has a bond with from real
// exchanges is not a stranger to her whatever the card says.
export function lonelinessWeight(p) {
  const tiers = cfg.loneliness_tiers ?? DEFAULTS.loneliness_tiers;
  if (p.owner) return tiers.owner ?? 1;
  return Math.max(tiers[p.tier] ?? 0, clamp01(p.bond ?? 0));
}

// What she has to be curious about right now, 0..1: open questions still fresh enough to look into,
// names mentioned lately, the question her last read left her with, and research goals. Two leads is
// plenty; one is half.
export function curiosityLeads(now = Date.now()) {
  let hasGoal = false;
  try { hasGoal = reflections().list().some((g) => g.kind === 'goal' && !g.done && !g.dropped && g.research?.enabled !== false); } catch {}
  // Her open questions, and the leads her own reading turned up (unknown concepts she found, concepts.js).
  const questions = [...(state.openQuestions ?? []), ...(state.curiosity_leads ?? [])].filter((q) => now - (q.at ?? 0) < cfg.research_question_hours * 3600_000).length;
  const names = recentNameContext().length;
  const read = state.lastResearch?.bringUp && now - (state.lastResearch.at ?? 0) < 12 * 3600_000 ? 1 : 0;
  return { leads: clamp01((questions + names + read + (hasGoal ? 1 : 0)) / 2), hasGoal, questions, names, read };
}

// Unease comes from promises and open questions that have gone stale: on her scratchpad for a
// while and not brought up recently. (It used to count everything open, which with a busy pad kept
// unease pinned at 1 and had her "circling back" every half hour about the same thing.)
export function staleItems() {
  const now = Date.now();
  const raised = state.raised ?? {};
  const out = [];
  for (const c of Object.keys(state.conversations ?? {})) {
    for (const e of scratch.entries(c)) {
      if (!['commitment', 'open_question'].includes(e.kind)) continue;
      if (now - e.created_at < cfg.stale_hours * 3600_000) continue;
      out.push({ ...e, conversation: c });
    }
  }
  return out.sort((a, b) => a.created_at - b.created_at); // oldest first
}
function uneaseTarget() {
  try {
    const n = staleItems().length;
    return n ? clamp01(0.4 + 0.2 * n) : 0; // one stale item is enough to reach the threshold; more, sooner

  } catch {
    return state.buckets.unease;
  }
}

// ---- solo-thought load (read-only) ----

// Every part is a signal that already exists. Nothing here drains a bucket.
export function loadParts() {
  const t = cfg.thoughts ?? DEFAULTS.thoughts;
  let stale = 0;
  try {
    stale = staleItems().length;
  } catch {}
  let threads = 0;
  try {
    threads = scratch.threads().length;
  } catch {}
  let recent = 0;
  try {
    recent = countRecentUserMessages(3_600_000);
  } catch {}
  return {
    curiosity: state.buckets.curiosity ?? 0,
    unease: state.buckets.unease ?? 0,
    stale,
    staleNorm: clamp01(stale / Math.max(1, t.stale_full)),
    threads: clamp01(threads / 5),
    recent: clamp01(recent / Math.max(1, t.messages_full)),
    restlessness: state.buckets.restlessness ?? 0,
    boredom: state.buckets.boredom ?? 0,
  };
}

export function loadNow() {
  const t = cfg.thoughts ?? DEFAULTS.thoughts;
  const p = loadParts();
  const w = t.weights;
  return clamp01(
    w.curiosity * p.curiosity +
      w.unease * Math.max(p.unease, p.staleNorm) + // unease already tracks stale items; don't count twice
      w.threads * p.threads +
      w.recent * p.recent +
      w.restlessness * p.restlessness +
      w.boredom * p.boredom,
  );
}

export function bandFor(load) {
  const bands = (cfg.thoughts ?? DEFAULTS.thoughts).bands;
  for (const name of ['quiet', 'low', 'active', 'high']) {
    const band = bands[name];
    if (band && load < band.max) return { name, ...band };
  }
  return { name: 'high', ...bands.high };
}

// ---- wants ----

function eligible() {
  const out = [];
  for (const [name, b] of Object.entries(cfg.buckets)) {
    if (!b.enabled || name === 'loneliness') continue;
    out.push({ key: name, bucket: name, value: state.buckets[name] ?? 0, b });
  }
  if (cfg.buckets.loneliness.enabled) {
    for (const [id, p] of Object.entries(state.loneliness)) out.push({ key: `loneliness:${id}`, bucket: 'loneliness', person: p.name, id, value: p.value, b: cfg.buckets.loneliness });
  }
  return out.filter((e) => {
    // Hysteresis: after firing, a bucket re-arms only once it has fallen to its re-arm line (threshold
    // minus hysteresis). Firing itself takes it there (see evaluate), so a bucket whose condition still
    // holds climbs back at its fill rate and acts again; it can't be left armed=false for good.
    if (state.armed[e.key] === false && e.value <= rearmLine(e.b)) state.armed[e.key] = true;
    // Speaking wants: tiredness scales the urge, and inhibition raises what it has to beat (Amy-Voice).
    // Not the silence want: tired, a full bucket could never reach its line (energy 0.04 capped it at 0.42 against
    // 0.55, owner 2026-11-11: "you are not speaking up during silent periods"). Tiredness slows how fast the quiet
    // builds in her instead (callSilenceStep), so a tired her takes longer to speak up but still does.
    const urge = SPOKEN.has(e.bucket) && e.bucket !== 'silence' ? tiredness(e.value) : e.value;
    return urge >= e.b.threshold && state.armed[e.key] !== false;
  });
}

// At most one want per tick: the one furthest over its threshold, within the guards.
function evaluate(now) {
  // Reaching out only holds off while someone has told her to back off.
  const externalOk = () => now >= state.clamp.until;
  // What each want needs before it can fire (when live). If it can't happen yet, it waits and the
  // pressure keeps building, rather than being spent on nothing.
  const audience = cfg.actions_live ? actor?.audience?.() ?? null : null;
  // A held question only needs a pause: the person it's for is here and talking with her anyway.
  const pause = cfg.actions_live ? actor?.audience?.({ lullMs: (cfg.ask_lull_seconds ?? 45) * 1000 }) ?? null : null;
  // The silence want is the quiet itself: it only needs the room to have gone quiet past its start, not the full lull.
  // Anyone who can hear the call counts for it, away or not (only deafened people can't): see voice/session.js audience.
  const hush = cfg.actions_live ? actor?.audience?.({ lullMs: quietRead().pauseMs, hearing: true }) ?? null : null;
  let roomNow = null;
  try { roomNow = cfg.actions_live ? actor?.room?.() ?? null : null; } catch {}
  // Who is in a call with her at all, mid-conversation or not. Someone here is never messaged: what she wants
  // to say waits for a pause in the call (or comes up in the talk they're already having).
  let present = new Set();
  try { present = (cfg.actions_live ? actor?.present?.() : null) ?? new Set(); } catch {}
  const selection = researchSelection();
  const selectedGoal = reflections().select({ buckets: state.buckets, now, gapMs: 0 });
  const privateGoal = goalWorker && selectedGoal && selectedGoal.goal.activity !== 'research' ? selectedGoal.goal : null;
  const topic = privateGoal?.text ?? selection.selected?.text;
  // Owner's hourly limit on research passes: past it, the want can't happen yet and keeps building.
  const researchedLastHour = (state.research_times ?? []).filter((t) => now - t < 3600000).length;
  const researchOk =
    (privateGoal ? goalWorker : researcher) && topic && !researchInFlight && !replyInFlight() &&
    researchedLastHour < (cfg.research_per_hour ?? DEFAULTS.research_per_hour);
  let ownerBusy = false;
  try { ownerBusy = Boolean(ownerWork()); } catch {}
  const possible = (e) => {
    if (!cfg.actions_live) return !EXTERNAL.has(e.bucket) || externalOk(e);
    // The owner's own work is running: her private local-model work waits for it, keeping its pressure.
    if (ownerBusy && WAIT_FOR_OWNER_WORK.has(e.bucket)) return false;
    // Speaking up in a call (Amy-Voice callBlocked): not while someone's answer is still awaited, not
    // inside the cooldown (it doubles each time she's ignored in a row), and not while she's been told to be quiet.
    if (audience && SPOKEN.has(e.bucket) && e.bucket !== 'loneliness' && now < state.quiet_until) return false;
    if (e.bucket === 'wonder') return Boolean(wonderer) && !wonderInFlight && !replyInFlight(); // private, on her local model
    if (e.bucket === 'intuition_tune') return Boolean(tuner) && !tuneInFlight && !replyInFlight(); // private, on her local model
    if (e.bucket === 'direction') return Boolean(director) && !directInFlight && !replyInFlight(); // private, on her local model, between replies
    if (e.bucket === 'world') return newsFeeds.hasFeeds() && !newsInFlight; // no feeds: nothing to read, the want waits
    if (e.bucket === 'build') return buildOk(now) && !replyInFlight() && affordable('build'); // a browser app she makes on her own, gated by builds.js and her energy
    if (e.bucket === 'self_upkeep' || e.bucket === 'self_ponder' || e.bucket === 'realization' || e.bucket === 'forge') return Boolean(selfWork) && !selfInFlight && !replyInFlight(); // private, on her local model
    // Someone who has stepped away (away.js) isn't spoken to, followed up with or checked in on.
    // Nobody to say anything to when everyone in the call has stepped away (a want with no target included).
    // For the silence want, only people who can't hear (deafened) count as gone.
    if (SPOKEN.has(e.bucket) && roomNow?.people?.length && roomNow.people.every((p) => (e.bucket === 'silence' ? roomNow.deaf ?? roomNow.away : roomNow.away)?.has?.(p.id))) return false;
    // Nor someone she's chosen to ignore (ignoring.js).
    if (SPOKEN.has(e.bucket)) { const t = targetOf(e); if (t && (roomNow?.away?.has(t) || isIgnored(t))) return false; }
    // Leaving the call: there is a call, she can leave it, and the quiet isn't quiet time or someone away.
    // Leaving needs nobody to have said anything to her for a while: never in the middle of a conversation with her.
    if (e.bucket === 'leaving') return Boolean(roomNow) && cfg.may_leave_call !== false && Boolean(actor?.leave) && !roomNow.quietTogether && !roomNow.away?.size && !replyInFlight()
      && (roomNow.sinceAddressedMs ?? 0) >= (cfg.leave_unaddressed_minutes ?? 30) * 60_000 / 6;
    if (e.bucket === 'asking') return Boolean(audience ?? pause) && externalOk(e) && roomFit('asking', roomNow); // her question: a pause in the talk, and not mid-conversation
    if (e.bucket === 'nudge') return Boolean(audience ?? pause) && externalOk(e) && Boolean(state.roomNudge);
    // Only with something new to bring: a topic he's already raised (and how it went) isn't material again.
    if (e.bucket === 'silence') return Boolean(hush) && externalOk(e) && !roomNow?.quietTogether && freshMaterial(now, selectedGoal?.goal ?? null).length > 0;
    if (ROOM.has(e.bucket)) return Boolean(audience) && externalOk(e) && roomFit(e.bucket, roomNow); // said in a lull in the call
    if (e.bucket === 'boredom' && audience) return true; // in a quiet call, bored: she breaks the silence
    // Her own research costs energy like any search: without enough stored, the want waits and keeps building.
    if (RESEARCH.has(e.bucket) || (privateGoal && privateGoal.bucket === e.bucket)) return researchOk && !ownerBusy && affordable(privateGoal ? 'goal-work' : 'research');
    if (!SPOKEN.has(e.bucket)) return true; // irritation: tone only
    if (!externalOk(e)) return false;
    if (e.bucket === 'unease') return Boolean(audience) && staleItems().length > 0; // something specific to circle back on
    if (e.bucket === 'restlessness') return Boolean(audience) || songOk() || sewOk() || playOk();
    // Reaching out to a person (missing them, or offering help): in the call, or by DM.
    const id = targetOf(e);
    if (!id) return Boolean(audience) && e.bucket === 'usefulness';
    const inCall = Boolean(audience?.ids.has(id));
    if (!inCall && present.has(id)) return false; // in the call but no pause yet: wait for one, never DM them
    // In a voice channel without her (she just left, say): a DM asking them into voice makes no sense.
    try { if (!inCall && messenger?.inVoice?.(id)) return false; } catch {}
    if (!inCall && !dmOk()) return false;
    if (isOwner(id)) return true;
    if (inCall && e.bucket === 'usefulness') return true;
    const card = reachCard(id);
    return card?.reach_out === 'yes';
  };
  // Furthest over its threshold first; between wants equally over (two buckets pinned at 1, say), the
  // one that has waited longest since it last fired, so a slow bucket can't be starved by a fast one.
  const firedAt = state.fired_at ?? {};
  const over = (e) => e.value - e.b.threshold;
  const wanting = eligible();
  const ranked = wanting
    .filter(possible)
    .sort((a, b) => (over(b) - over(a)) || ((firedAt[a.key] ?? 0) - (firedAt[b.key] ?? 0)));
  const choice = ranked[0];
  if (!choice) return null;
  // The wants that nearly won, and the ones he had but couldn't act on yet (conflicts.js): only close calls are kept.
  try {
    if (cfg.actions_live) conflicts.recordWant({ chose: choice.key, over: over(choice),
      runnersUp: ranked.slice(1, 4).map((e) => ({ bucket: e.key, over: over(e) })),
      blocked: wanting.filter((e) => !ranked.includes(e)).map((e) => e.key) });
  } catch {}
  const doing = !cfg.actions_live ? 'log' : choice.bucket === 'leaving' ? 'leave' : choice.bucket === 'wonder' ? 'wonder' : choice.bucket === 'intuition_tune' ? 'tune' : choice.bucket === 'direction' ? 'direct' : choice.bucket === 'self_upkeep' ? 'upkeep' : choice.bucket === 'self_ponder' ? 'ponder' : choice.bucket === 'realization' ? 'realize' : choice.bucket === 'forge' ? 'forge' : choice.bucket === 'build' ? 'build' : choice.bucket === 'world' ? 'news' : choice.bucket === 'boredom' && audience ? 'speak' : choice.bucket === 'restlessness' && (audience ? playOk() && instrument.inCall() : songOk() || sewOk() || playOk()) ? makingOutlet(Boolean(audience)) : (RESEARCH.has(choice.bucket) || (privateGoal && privateGoal.bucket === choice.bucket)) ? (privateGoal ? 'goal-work' : 'research') : SPOKEN.has(choice.bucket) ? 'speak' : 'tone';
  // His own urge never plays music into a call. A piece he makes because he's restless is composed and recorded
  // privately; music only goes out loud in a call when someone asks for it (the instrument and music tools). Owner,
  // 2026-11-11: "I never asked him to play the song… We're in the middle of talking and somebody was talking to him and
  // he answered with a song." At 10:32 his restlessness picked his guitar and it played into the call for two minutes
  // over Owner and Ultra; nobody could stop it or be heard over it.
  const playAloud = false;

  const want = doing === 'songwrite' ? 'write or revise a song in her songbook' : doing === 'sew' ? 'design and sew herself something to wear' : doing === 'play' ? 'make a piece of her own on her instrument, privately, without playing it into the call' : doing === 'goal-work' ? `work privately on goal #${privateGoal.id}: ${topic}` : doing === 'research' ? `research "${topic}" and write it in her journal` : WANTS[choice.bucket](state);
  // Her own acts are paid for like requested ones (possible() already checked she can afford it).
  const effortful = ['research', 'goal-work', 'build', 'songwrite', 'sew', 'play'].includes(doing);
  if (effortful) spendEnergy(actionCost(doing), { what: `her own ${doing}` });
  // What she expects from it, recorded before she does it (reward.js): from how hard the driving channel is
  // pushing and how attempts like it went before, never from asking her model. Settled with what the harness
  // can verify once the act is over.
  const asker = doing === 'research' ? askerOf(topic) : null;
  const objective = doing === 'songwrite' || doing === 'sew' || doing === 'play' ? want : doing === 'build' ? (nextIdea()?.topic ?? want) : topic;
  const expecting = effortful ? rewards.expect({ act: doing, objective, bucket: choice.bucket, level: choice.value, person: asker, spent: actionCost(doing),
    nodes: doing === 'goal-work' && privateGoal ? [`goal:${privateGoal.id}`] : [] }).catch(() => null) : null;
  const settle = (how) => expecting?.then((e) => rewards.settle(e, how))
    .catch((err) => activity('error', { where: 'reward', message: `Couldn't settle the outcome of her ${doing}: ${err.message}. Nothing was learned from this attempt; check reward.js.` }));
  // What she makes for people (a song, an app) isn't graded by her or the harness: it waits for whoever sees it
  // to react (creations.js). Not tied to a conversation: the first reaction anywhere settles it.
  const holdForFeedback = (label, detail) => expecting?.then((e) => e && import('./creations.js').then((c) => c.open({ expectation: e, act: doing, label, detail, conversation: null })))
    .catch((err) => activity('error', { where: 'creations', message: `Couldn't hold her ${doing} open for feedback: ${err.message}. It was made; its reaction just won't be tracked.` }));
  // Making something of her own is how she works off what built up in her (Owner, 2026-11-10: she creates to
  // feel better, and that has to come from the pressure system). Finishing it relieves the want that drove it,
  // into joy and growth, the same transfer a satisfied act gets (onOutcome), straight away and from the act
  // itself. Anyone's reaction later is on top of this (creations.js), never a condition for it.
  const madeIt = (label, detail) => {
    const moved = onOutcome({ bucket: choice.bucket, satisfaction: 1, reward: 0 });
    activity('made', { act: doing, what: label, detail, bucket: choice.bucket, moved });
  };
  if (doing === 'songwrite' || doing === 'sew' || doing === 'play') state.last_tried = { ...state.last_tried, [doing]: Date.now() };
  const at = +choice.value.toFixed(2);
  // Drain the bucket that fired (to its re-arm line at least, so it can arm again), seed the next ones.
  const after = Math.min(clamp01(choice.value - choice.b.drain), rearmLine(choice.b));
  const drained = Math.max(0, choice.value - after);
  if (choice.bucket === 'loneliness') state.loneliness[choice.id].value = after;
  else state.buckets[choice.bucket] = after;
  const seeded = cfg.seeds[choice.bucket] ?? {};
  discharge(choice.bucket, drained, seeded);
  relieve(RELIEF[choice.bucket]);
  (state.fired_at ??= {})[choice.key] = now;
  if (choice.bucket === 'self_ponder') state.learned_since_reflect = 0;
  if (choice.bucket === 'share' || choice.bucket === 'attentive') state.reads_since_shared = 0;
  // Firing drains it to its re-arm line or below, so it's re-armed already: it acts again only when new energy
  // brings it back over its threshold. (Marking it disarmed let a line of conversation refill it between ticks
  // before the re-arm check ever saw it low, and it stayed stuck.)
  state.armed[choice.key] = true;
  if (BACKGROUND.has(doing)) backgroundSince = now;
  state.last_action = { bucket: choice.bucket, person: choice.person, at: now };
  activity('pressure', { fired: choice.bucket, person: choice.person, value: at, want, seeded, doing });
  const fired = { ...choice, want, topic, openQuestion: state.openQuestions?.at(-1), doing, ...(choice.bucket === 'repair' && { repairWith: state.repairWith }), ...(choice.bucket === 'flirt' && { flirtWith: state.flirtWith }) };
  const target = SPOKEN.has(choice.bucket) ? targetOf(choice) : null;
  if (target) Object.assign(fired, { id: target, person: choice.person ?? state.loneliness[target]?.name });
  let targetInVoice = false;
  try { targetInVoice = Boolean(target && messenger?.inVoice?.(target)); } catch {}
  const byDm = doing === 'speak' && target && !audience?.ids.has(target) && !present.has(target) && !targetInVoice && dmOk();
  // What a room-driven want is about: her question, the quiet person, what she has to share.
  // asking: the question itself is made when she says it, for whoever she's saying it to (question-engine.js).
  if (choice.bucket === 'nudge') { fired.nudge = state.roomNudge; Object.assign(fired, { id: state.roomNudge?.to?.id, person: state.roomNudge?.to?.name }); }
  if (choice.bucket === 'discovery') { try { fired.discovery = discoverer?.pick?.() ?? null; } catch { fired.discovery = null; } }
  if (choice.bucket === 'home_change') fired.homeWant = { wants: state.homeWants ?? [], why: state.homeWhy ?? '' };
  if (choice.bucket === 'onboarding') {
    const b = onboarding?.briefing?.();
    fired.onboarding = b?.text ?? null;
    fired.onboardingTitle = b?.title ?? null; // a DM only names it and asks him into voice (bot.js)
  }
  if (choice.bucket === 'follow_up') { fired.thread = state.roomThread; if (state.roomConversation) talkThreads.followedUp(state.roomConversation); }
  if (choice.bucket === 'attentive') Object.assign(fired, { id: state.quietPerson?.id, person: state.quietPerson?.name });
  if (choice.bucket === 'silence') {
    const read = quietRead();
    // One new thing, chosen here (where the talk was first), not a menu to pick from again: what he raises is logged and
    // spent, so the next quiet brings something else or nothing (callSilenceStep).
    const topic = freshMaterial(now, selectedGoal?.goal ?? null)[0] ?? null;
    const already = raisedLately(now).slice(-6).map((r) => `${r.text}${r.outcome === 'ignored' ? ' (nobody picked it up)' : r.outcome === 'acknowledged' ? ' (talked through)' : ''}`);
    if (topic) noteRaised(topic, now);
    fired.silence = { seconds: Math.round((roomNow?.quietMs ?? 0) / 1000), material: topic ? [topic.text] : [], topic, already,
      read: { reasons: read.reasons, pause: Math.round(read.pauseMs / 1000), push: +read.push.toFixed(2), hold: +read.hold.toFixed(2) } };
    // Speaking into it picks up what was hanging: that read eases (the reasons above were taken first).
    bumpRead('left_hanging', -0.6 * (state.buckets.left_hanging ?? 0));
  }
  if (choice.bucket === 'share') {
    const read = state.lastResearch && !state.lastResearch.shared ? state.lastResearch : null;
    const reflection = state.lastReflection && !state.lastReflection.shared ? state.lastReflection : null;
    let news = null; try { news = read ? null : newsFeeds.untold({ now }); } catch {}
    fired.share = read ? { kind: 'read', title: read.title, bringUp: read.bringUp } : news ? { kind: 'news', title: news.title, source: news.feed, summary: news.summary } : reflection ? { kind: 'reflection', statement: reflection.statement } : state.lastSong ? { kind: 'song', title: state.lastSong.title } : null;
    if (read) read.shared = true; else if (news) newsFeeds.markTold(news.key); else if (reflection) reflection.shared = true; else if (state.lastSong) state.lastSong.shared = true;
  }
  // Circling back is about one specific stale item, and that item won't be raised again for a while.
  if (choice.bucket === 'unease') {
    const item = staleItems().find((e) => !audience || e.conversation.startsWith('voice:')) ?? staleItems()[0];
    if (item) {
      fired.item = { id: item.id, text: item.text };
      (state.raised ??= {})[item.id] = now;
    }
  }
  const bubble = bubbleFor(doing, doing === 'research' || doing === 'goal-work' ? topic : '');
  if (doing === 'research' || doing === 'goal-work') {
    if (state.research_counts?.day !== today()) state.research_counts = { day: today(), n: 0, last: 0 };
    state.research_counts.n++;
    state.research_counts.last = now;
    state.research_times = [...(state.research_times ?? []).filter((t) => now - t < 3600000), now];
    researchInFlight = true;
    if (doing === 'research') state.research_attempts = [...(state.research_attempts ?? []).filter((a) => now - a.at < cfg.research_repeat_hours * 3600000), { key: selection.selected.key, at: now }].slice(-100);
    const trace = { ...selection, trigger: choice.bucket, pressureValue: at, threshold: choice.b.threshold, repeatHours: cfg.research_repeat_hours, at: now, paid: true }; // paid: the pass's cost came out of her reserve above
    state.lastResearchSelection = trace;
    Promise.resolve().then(() => doing === 'goal-work' ? goalWorker(privateGoal.id) : researcher(topic, choice.bucket, trace))
      .then((r) => {
        // Nothing was done (no pass ran, or it was skipped before searching): the energy it paid goes back. A search
        // that ran and came back inconclusive did the work, so that one stays spent.
        const refund = () => refundEnergy(actionCost(doing), { what: `her own ${doing}` });
        if (!r) { refund(); settle({ ok: false, why: `the ${doing === 'goal-work' ? 'goal worker' : 'research pass'} returned nothing`, method: doing === 'goal-work' ? 'drafting goal work privately' : 'a research pass' }); return; }
        state.lastResearchDecision = r.decision;
        const d = r.decision ?? {};
        const method = doing === 'goal-work' ? 'drafting goal work privately' : d.query ? `searching the web for "${d.query}"` : 'planning a search (no search was run)';
        const learned = r.learned ?? null;
        // Her own judgement of the goal experience is left alone; a harness-measured review is added only where she hasn't reviewed it.
        const goalExperience = doing === 'goal-work' ? r.experience?.id : selection.selected?.goalId ? d.id : null;
        const reviewGoal = (satisfaction, reason) => {
          if (!goalExperience) return;
          try { const saved = reflections().experiences().find((x) => x.id === goalExperience); if (saved && !saved.reviewed) reflections().review(goalExperience, satisfaction, reason); } catch {}
        };
        if (!r.entry || d.status !== 'written') {
          // It didn't work. The want that drove it stays (nothing is drained); what's kept is how she tried and why it didn't.
          const result = d.status === 'inconclusive' ? 'inconclusive' : d.status === 'skipped' ? 'skipped' : 'failed';
          if (result === 'skipped' || !d.query) refund();
          settle({ ok: false, result, method, why: d.failure || d.reason || (result === 'inconclusive' ? 'the results did not clearly answer the question' : 'no entry was written') });
          if (result === 'inconclusive') reviewGoal(-0.5, `Harness: the search for "${d.query}" was inconclusive (no supported answer).`);
          save(); return;
        }
        // Verified: an entry was written. What it measurably produced grades it: new concepts actually stored in her graph.
        const fresh = learned?.fresh?.length ?? 0;
        settle({ ok: true, outcome: doing === 'research' ? 0.7 + 0.3 * Math.min(1, fresh / 3) : 1, method, nodes: learned?.nodes ?? [] });
        reviewGoal(1, doing === 'goal-work' ? `Harness: a draft was written to ${d.file}.` : `Harness: a supported answer was written to the journal (${fresh} new concepts stored).`);
        // What she didn't know yet becomes something to be curious about; the broader subject pulls at her more.
        if (learned?.leads?.length) {
          const kept = (cfg.feedback ?? DEFAULTS.feedback).leads_kept ?? 6;
          state.curiosity_leads = [...(state.curiosity_leads ?? []).filter((l) => !learned.leads.some((n) => n.text === l.text)), ...learned.leads].slice(-kept);
        }
        // The subject her question belonged to was answered (that grows an interest); the concepts she read about deepen any she already has.
        if (learned?.subject || learned?.concepts?.length) grown.notice([...(learned.subject ? [{ name: learned.subject, source: 'answered', person: asker ? state.loneliness[asker]?.name : undefined }] : []), ...(learned.concepts ?? []).map((c) => ({ name: c.name, source: 'reading' }))]).catch(() => {});
        state.openQuestions = (state.openQuestions ?? []).filter((q) => questionText(q) !== topic);
        state.curiosity_leads = (state.curiosity_leads ?? []).filter((l) => l.text !== topic);
        // The answer resolves what drove this pass: the pressure that asked for it is released into the network
        // and she stops searching. A pass that finds nothing writes no entry, so the pressure stays and she goes on.
        if (doing === 'research' || doing === 'goal-work') {
          grown.retire(topic);
          // Answered: this topic is never searched again, whether it came from chat, her grown interests or her standing ones.
          if (doing === 'research' && selection.selected?.key) state.research_answered = Object.fromEntries([...Object.entries(state.research_answered ?? {}), [selection.selected.key, now]].slice(-500));
          const spent = state.buckets[choice.bucket] ?? 0;
          state.buckets[choice.bucket] = 0;
          discharge(choice.bucket, spent, cfg.seeds[choice.bucket] ?? {});
        }
        // Learning something is its own reward, and one discovery makes her want the next.
        state.fed = feed(state.fed, doing === 'goal-work' ? 'making' : 'learning', 0.2);
        // What she reads on her own brings no energy in: only conversation does (owner, 2026-11-09).
        state.lastResearch = { title: r.title, bringUp: r.bringUp, entry: r.entry, verifiedPublic: doing === 'research', at: Date.now() };
        // Something new learned: growth, reflection and expression feed off it (Amy-Voice learned()).
        state.learned_since_reflect = (state.learned_since_reflect ?? 0) + 1;
        state.reads_since_shared = (state.reads_since_shared ?? 0) + 1;
        state.last_learned = Date.now();
        impulse('new_knowledge');
        // Reading deepens what she's already into (it never starts an interest on its own).
        grown.notice([{ name: r.title, source: 'reading' }]).catch(() => {});
        save();
      })
      .catch((err) => {
        activity('error', { where: 'pressure research', message: err.message });
        settle({ ok: false, why: err.message, method: doing === 'goal-work' ? 'drafting goal work privately' : 'a research pass' });
      })
      .finally(() => { researchInFlight = false; bubble.end(); });
  } else if (doing === 'news') {
    newsInFlight = true;
    newsFeeds.readFeeds()
      .then(({ fresh, failed, read }) => {
        if (failed.length) activity('error', { where: 'news feeds', message: `Couldn't reach ${failed.length} of the ${read} news feeds: ${failed.map((f) => `${f.name} (${f.why})`).join('; ')}. The others were read; these get tried again the next time the feeds are read.` });
        activity('news', { read, fresh: fresh.length, failed: failed.length, top: fresh.slice(0, 3).map((i) => `${i.title} (${i.feed})`) });
        if (fresh.length) {
          // Something new out there: it's knowledge he can bring up (the share bucket), and his picture of the world grew.
          state.lastNews = { at: Date.now(), fresh: fresh.length, shared: false };
          impulse('new_knowledge');
          state.fed = feed(state.fed, 'learning', 0.1);
          save();
        }
      })
      .catch((err) => activity('error', { where: 'news feeds', message: `Reading the news feeds failed: ${err.message}. Nothing new came in; the want stays and they're read again when it fires.` }))
      .finally(() => { newsInFlight = false; bubble.end(); });
  } else if (doing === 'wonder') {
    wonderInFlight = true;
    Promise.resolve(wonderer.wonder())
      .then((q) => { if (q) { state.lastWonder = { text: q.text, about: q.aboutName, at: Date.now() }; save(); } })
      .catch((err) => activity('error', { where: 'pressure wonder', message: err.message }))
      .finally(() => { wonderInFlight = false; bubble.end(); });
  } else if (doing === 'tune') {
    tuneInFlight = true;
    Promise.resolve(tuner.review())
      .then((r) => { state.lastTune = { ...r, at: Date.now() }; save(); })
      .catch((err) => activity('error', { where: 'pressure intuition tune', message: err.message }))
      .finally(() => { tuneInFlight = false; bubble.end(); });
  } else if (doing === 'direct') {
    directInFlight = true;
    Promise.resolve(director.reflect())
      .then((r) => { state.lastDirection = { ...r, at: Date.now() }; save(); })
      .catch((err) => activity('error', { where: 'pressure direction', message: `Her reflection on where she's heading failed: ${err.message}. Her aims stay as they were; the urge stays and she tries again when it fires.` }))
      .finally(() => { directInFlight = false; bubble.end(); });
  } else if (doing === 'forge') {
    selfInFlight = true;
    Promise.resolve(selfWork.forge())
      .catch((err) => activity('error', { where: 'pressure forge', message: err.message }))
      .finally(() => { selfInFlight = false; bubble.end(); });
  } else if (doing === 'realize') {
    selfInFlight = true;
    Promise.resolve(selfWork.realize())
      .catch((err) => activity('error', { where: 'pressure realize', message: err.message }))
      .finally(() => { selfInFlight = false; bubble.end(); });
  } else if (doing === 'upkeep') {
    selfInFlight = true;
    Promise.resolve(selfWork.upkeep())
      .catch((err) => activity('error', { where: 'pressure self upkeep', message: err.message }))
      .finally(() => { selfInFlight = false; bubble.end(); });
  } else if (doing === 'ponder') {
    selfInFlight = true;
    Promise.resolve(selfWork.ponder({ buckets: state.buckets })) // her buckets move her inner core (inner-core.js autoAdjust)
      .then((r) => { if (r) { state.lastReflection = { ...r, shared: false }; save(); } })
      .catch((err) => activity('error', { where: 'pressure self ponder', message: err.message }))
      .finally(() => { selfInFlight = false; bubble.end(); });
  } else if (doing === 'songwrite') {
    Promise.resolve(songwriter({ state, mood: moodLine(null, { coaching: false }) }))
      .then((r) => {
        if (!r?.song?.id) { settle({ ok: false, why: 'no song was saved to her songbook', method: 'writing in her songbook' }); return; }
        madeIt('song', `"${r.song.title}" (${r.kind ?? 'written'})`);
        holdForFeedback('song', `"${r.song.title}" (${r.kind ?? 'written'})`); // and how people take it when she shares it, on top
        state.fed = feed(state.fed, 'making', 0.2);
        state.last_made = Date.now();
        state.lastSong = { id: r.song.id, title: r.song.title, kind: r.kind, at: Date.now() };
        save();
      })
      .catch((err) => { activity('error', { where: 'pressure songwrite', message: err.message }); settle({ ok: false, why: err.message, method: 'writing in her songbook' }); })
      .finally(() => bubble.end());
  } else if (doing === 'sew') {
    // She designs an outfit herself and the seamstress cuts and sews it (seamstress.js). The drape runs on in the
    // background; its worth is how people react when they see it on her.
    Promise.resolve(seamstress.make({ state, mood: moodLine(null, { coaching: false }) }))
      .then((r) => {
        if (!r?.id) { settle({ ok: false, why: 'no design came out to sew', method: 'designing an outfit' }); return; }
        madeIt('outfit', `"${r.name}"`);
        holdForFeedback('outfit', `"${r.name}"`);
        state.fed = feed(state.fed, 'making', 0.2);
        state.last_made = Date.now();
        state.last_sewn = Date.now();
        state.lastOutfit = { id: r.id, name: r.name, at: Date.now() };
        save();
      })
      .catch((err) => { activity('error', { where: 'pressure sew', message: err.message }); settle({ ok: false, why: err.message, method: 'designing an outfit' }); })
      .finally(() => bubble.end());
  } else if (doing === 'play') {
    // She sits down at her instrument: composes from how she feels, plays it (out loud in a call), records it. Each
    // phrase lands on her as she hears it (instrument-play.js); finishing the piece relieves the want that drove it.
    Promise.resolve(instrument.play({ state, mood: moodLine(null, { coaching: false }), outLoud: playAloud }))
      .then((piece) => {
        if (!piece?.file) { settle({ ok: false, why: 'no piece came out to play', method: 'playing her instrument' }); return; }
        madeIt('piece', `"${piece.title}" (${piece.instrument}, ${piece.words})`);
        holdForFeedback('piece', `"${piece.title}" (${piece.instrument})`);
        state.fed = feed(state.fed, 'making', 0.2);
        state.last_made = Date.now();
        state.lastPiece = { title: piece.title, file: piece.file, instrument: piece.instrument, words: piece.words, at: Date.now() };
        save();
      })
      .catch((err) => { activity('error', { where: 'pressure play', message: `Playing her instrument failed: ${err.message}. Nothing was recorded; the urge stays and comes back.` }); settle({ ok: false, why: err.message, method: 'playing her instrument' }); })
      .finally(() => bubble.end());
  } else if (doing === 'build') {
    const idea = nextIdea();
    if (!idea) return null;
    buildInFlight = true;
    const counts = state.build_counts?.day === today() ? state.build_counts : { day: today(), n: 0, last: 0 };
    state.build_counts = { day: counts.day, n: counts.n + 1, last: now };
    const feelings = Object.entries(state.buckets).filter(([, v]) => v >= 0.3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') || 'calm';
    startBuild({ idea, pressure: `build ${at} (interest ${idea.interest.toFixed(2)} in ${idea.topic})`, feelings })
      .then((r) => {
        // What the harness can verify here is that the coding job started (the workshop accepted it); a start reply that's an error is a failure.
        const started = String(r?.started ?? '');
        if (!r?.name || !started || /^error/i.test(started)) settle({ ok: false, why: started || 'the coding job did not start', method: `a coding job building "${idea.topic}"` });
        else holdForFeedback('browser app', idea.topic); // how the people who use it react is how she'll know
        state.lastBuild = { name: r.name, folder: r.folder, at: Date.now() }; save();
      })
      .catch((err) => { activity('error', { where: 'pressure build', message: err.message }); settle({ ok: false, why: err.message, method: `a coding job building "${idea.topic}"` }); })
      .finally(() => { buildInFlight = false; bubble.end(); });
  } else if (doing === 'leave') {
    try {
      fired.ignoredStreak = state.ignored_streak ?? 0;
      state.ignored_streak = 0;
      state.said_bored_at = null;
      fired.minutesUnaddressed = Math.round((roomNow?.sinceAddressedMs ?? 0) / 60_000);
      actor.leave(fired);
    } catch (err) {
      activity('error', { where: 'pressure leave', message: err.message });
    }
  } else if (doing === 'speak') {
    try {
      if (byDm) Promise.resolve(messenger.dm(fired)).catch((err) => activity('error', { where: 'pressure dm', message: err.message }));
      else actor.act(fired);
      if (byDm) state.dm_wait = { id: target, at: now };
      else if (audience) {
        state.last_speakup = now;
        // Whether anyone picks it up is read against what he actually raised (the topic), not the want's description.
        const said = choice.bucket === 'silence' && fired.silence?.topic ? fired.silence.topic.text : want;
        state.uptake = { at: now, text: said, want: choice.bucket, words: [...words(said)], lines: 0 };
      }
      if (choice.bucket === 'bored_here') state.said_bored_at = now; // from here, leaving is on the table until someone pulls her in
      if (choice.bucket === 'loneliness') markReached(choice.id);
    } catch (err) {
      activity('error', { where: 'pressure action', message: err.message });
    }
  }
  return fired;
}

// Who a person-directed want is for: the one she misses, or (offering help) whoever she misses most.
// What the call she's in is like right now, for the room-driven buckets. actor.room() (voice/session.js):
// { people: [{ id, name }], quiet: [{ id, name }], sinceAddressedMs, talkingLately }.
function roomTargets(now) {
  let room = null;
  try { room = actor?.room?.() ?? null; } catch {}
  const ids = new Set((room?.people ?? []).map((p) => p.id));
  // Someone in the call to ask is all the asking want needs: the question is made when it fires (question-engine.js).
  const here = (room?.people ?? []).filter((p) => !room?.away?.has?.(p.id));
  const question = here.length && !room?.quietTogether ? { generate: true } : null; // quiet time: nobody to ask
  state.roomQuestion = question;
  state.quietPerson = room?.quiet?.[0] ?? null;
  state.roomNudge = room?.nudge ?? null; // { text, to: { id, name } } from open-question.js, via the session
  state.roomThread = room?.thread ?? null;
  state.roomConversation = room?.conversation ?? null;
  const read = state.lastResearch && !state.lastResearch.shared && now - state.lastResearch.at < 12 * 3600_000;
  const song = state.lastSong && !state.lastSong.shared && now - state.lastSong.at < 24 * 3600_000;
  const reflection = state.lastReflection && !state.lastReflection.shared && now - (state.lastReflection.at ?? 0) < 24 * 3600_000;
  return {
    asking: question ? 0.8 : 0,
    left_out: room?.talkingLately ? clamp01((room.sinceAddressedMs ?? 0) / (15 * 60_000)) : 0,
    share: room && (read || song || reflection) ? 0.75 : 0,
    attentive: state.quietPerson ? 0.8 : 0,
    follow_up: room && !room.satisfied ? clamp01(0.35 + (room.momentum ?? 0) * 0.6) * ((room.momentum ?? 0) >= 0.3 ? 1 : 0) : 0,
    nudge: room?.nudge ? 1 : 0,
    bored_here: room && !room.quietTogether && !room.away?.size ? boredHereTarget(room) : 0,
    leaving: room && cfg.may_leave_call !== false && !room.quietTogether && !room.away?.size ? leavingTarget(room, now) : 0,
  };
}

// How much the call bores her or leaves her out: her own boredom (the talk has gone stale for her),
// people talking around her but not to her for a long stretch, her lines going ignored in a row, or a
// room that's been dead to her for twice that long. Quiet time together and someone stepping away are
// handled before this is called: they count for nothing.
export function boredHereTarget(room) {
  const ignored = Math.min(1, (state.ignored_streak ?? 0) / 3);
  const span = (cfg.leave_unaddressed_minutes ?? 30) * 60_000;
  const since = room.sinceAddressedMs ?? 0;
  const talkedPast = room.talkingLately ? Math.min(1, since / span) : 0;
  const deadRoom = !room.talkingLately && since > 2 * span ? 0.6 : 0;
  const bored = room.talkingLately ? (state.buckets.boredom ?? 0) : 0; // bored *by the talk*, not by silence
  return clamp01(0.5 * bored + 0.55 * ignored + 0.6 * talkedPast + deadRoom);
}
// Leaving only becomes a want after she's said she's bored (bored_here fired) and nothing changed: the
// same things still hold. Someone pulling her in (the wanted impulse) clears said_bored_at, and she'd
// have to feel it and say it again before leaving is on the table.
export const saidBored = (now = Date.now()) => Boolean(state.said_bored_at && now - state.said_bored_at < SAID_BORED_MS);
export function leavingTarget(room, now = Date.now()) {
  if (!saidBored(now)) return 0;
  return boredHereTarget(room);
}
// Someone talked to her after she said she was bored or left out: that's being wanted.
function pulledBackIn(speaker, now = Date.now()) {
  if (!saidBored(now)) return;
  state.said_bored_at = null;
  impulse('wanted', speaker?.id ?? null);
  activity('pressure', { wanted: true, by: speaker?.name ?? null });
}

function targetOf(e) {
  if (e.bucket === 'loneliness') return e.id;
  if (e.bucket === 'asking') return null; // asked of whoever's here (question-engine.js picks the subject for them)
  if (e.bucket === 'nudge') return state.roomNudge?.to?.id ?? null;
  if (e.bucket === 'onboarding' || e.bucket === 'home_change') return config.ownerIds?.[0] ? String(config.ownerIds[0]) : null;
  if (e.bucket === 'flirt') return state.flirtWith?.id ?? null;
  if (e.bucket === 'repair') return state.repairWith?.id ?? null;
  if (e.bucket === 'attentive') return state.quietPerson?.id ?? null;
  if (e.bucket === 'usefulness') return loneliest()?.id ?? null;
  return null;
}
const songOk = () => Boolean(songwriter) && cfg.actions_live && !replyInFlight() && songCanWrite() && affordable('songwrite');
const sewOk = () => Boolean(seamstress) && cfg.actions_live && !replyInFlight() && seamstress.free() && affordable('sew');
// Two ways to make something when she's restless on her own: the one she's tried less recently. A try counts
// whether or not it worked, so one outlet that keeps failing can't keep taking every turn from the other.
const lastTried = (doing) => Math.max(state.last_tried?.[doing] ?? 0, doing === 'sew' ? state.last_sewn ?? 0 : doing === 'play' ? state.lastPiece?.at ?? 0 : state.lastSong?.at ?? 0);
// In a call with people around, the only way to make something is to play (out loud, in a lull); alone, any outlet.
const makingOutlet = (withPeople = false) => {
  const can = withPeople ? ['play'] : [sewOk() && 'sew', songOk() && 'songwrite', playOk() && 'play'].filter(Boolean);
  return can.sort((a, b) => lastTried(a) - lastTried(b))[0] ?? 'songwrite';
};
const playOk = () => Boolean(instrument) && cfg.actions_live && !replyInFlight() && instrument.free() && affordable('play');
// Whether she has the stored energy for one of her own acts (action_costs).
const affordable = (what) => (state.reserve ?? 0) + 1e-9 >= actionCost(what);
let songCanWrite = () => true;
export const setSongGate = (fn) => (songCanWrite = fn);
// One DM at a time: while the last one she sent is still unanswered (dm_wait), she doesn't send another.
const dmOk = () => Boolean(messenger) && (cfg.reach_channels ?? []).includes('dm') && !state.dm_wait;
// Where a bucket has to fall to after firing before it may fire again.
const rearmLine = (b) => Math.max(0, b.threshold - b.hysteresis);

// Names are stored with the message they came from and a timestamp. Old state files only have
// strings; those get at: 0 so they can never become a research topic again.
function nameEntries() {
  return (state.recentNames ?? [])
    .map((n) => (typeof n === 'string' ? { name: n, at: 0, conversation: '', snippet: '' } : n))
    .filter((n) => n && typeof n.name === 'string' && n.name.trim())
    .map((n) => ({ ...n, name: n.name.trim() }));
}

// The sentence that actually contains the name, so a bare name never becomes the whole topic.
function sentenceAround(text, name) {
  const s = String(text ?? '');
  const i = s.toLowerCase().indexOf(String(name).toLowerCase());
  if (i < 0) return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  const before = s.slice(0, i);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1;
  const after = s.slice(i);
  const ends = [after.indexOf('.'), after.indexOf('!'), after.indexOf('?')].filter((n) => n >= 0);
  const end = i + (ends.length ? Math.min(...ends) + 1 : after.length);
  return s.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Fresh names with the sentence they came from, for prompt context (not research selection).
// Old state files only have bare strings; those have at: 0 and are ignored here too.
export function recentNameContext() {
  const ttl = Math.max(1, Number(cfg.recent_name_minutes) || 30) * 60_000;
  const now = Date.now();
  return nameEntries()
    .filter((e) => e.at && now - e.at <= ttl)
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
}

// What to look into: the newest open question, else a recent name that was actually asked about,
// else an active thread. Never a bare, stale name.
export function researchTopic() {
  return researchSelection().selected?.text ?? null;
}

// Whose question a research topic is (their open question): the reward of answering it is associated with them.
function askerOf(topic) {
  const q = [...(state.openQuestions ?? [])].reverse().find((x) => questionText(x) === topic);
  return q?.speakerId ?? null;
}

export function researchSelection() {
  let threads = [];
  try { threads = scratch.threads(); } catch {}
  const experiences = reflections().experiences();
  const goals = reflections().list().map((g) => ({ ...g, selectionScore: learnedPreference(g, experiences) + (g.fit ?? 0.5) + (state.buckets[g.bucket ?? 'curiosity'] ?? 0) }));
  // What she's grown into lately (interests.js) comes before her standing interests.
  const into = (() => { try { return interestsTop(4).filter((t) => t.interest >= 0.3).map((t) => t.name); } catch { return []; } })();
  // Leads from what she read (unknown concepts, concepts.js) are open questions of her own, with the time she found them.
  return selectResearch({ questions: [...(state.openQuestions ?? []), ...(state.curiosity_leads ?? [])], names: nameEntries(), threads, goals, interests: into, knownNames: [config.botName, ...listContacts().flatMap((c) => [c.name, c.username])], attempts: state.research_attempts, answered: state.research_answered, botName: config.botName, questionHours: cfg.research_question_hours, threadHours: cfg.research_thread_hours, nameMinutes: cfg.recent_name_minutes, repeatHours: cfg.research_repeat_hours });
}

// What she's doing in the background, shown as a bubble on her avatar while it runs (avatar.js).
// Building on her own (builds.js): one at a time, a day's cap, and a gap between them.
let buildInFlight = false;
function nextIdea() {
  try { return pickIdea(interestsTop(3), builtIdeas()); } catch { return null; }
}
function buildOk(now) {
  if (buildInFlight || cfg.builds_enabled === false) return false;
  return Boolean(nextIdea());
}

const BACKGROUND_LABELS = { news: 'Reading the news', tune: 'Looking back at her intuition', build: 'Making a browser app', research: 'Researching something', 'goal-work': 'Working on a goal', wonder: 'Wondering about something', forge: 'Writing new questions', realize: 'Working out part of herself', upkeep: 'Filing what she knows', ponder: 'Thinking about who she is', songwrite: 'Writing a song', play: 'Playing her instrument', thinking: 'Thinking it over' };
function bubbleFor(doing, detail = '') {
  if (!BACKGROUND_LABELS[doing]) return { end() {} };
  const id = `${doing}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  avatarToolCall({ id, tool: doing, label: BACKGROUND_LABELS[doing], detail: String(detail ?? '').slice(0, 60), phase: 'start' });
  return { end: (ok = true) => avatarToolCall({ id, tool: doing, phase: 'end', ok }) };
}

// ---- Message energy: Lambda-PSI (human-sim: lambda_psi_system.py) ----
// J is the effort a message exerts, in four parts: attention (how much is said), control (how directive it is),
// demand (how much it asks of her), affect (how charged it is). Its size is the energy the message brings in.
// Each channel has a direction in the same space; the message's energy lands in the channels it aligns with,
// in proportion to Lambda = J . g_k (meaning: effort aligned with what the channel needs).
const CHANNEL_DIRECTION = {
  attention: ['curiosity', 'explore', 'wonder', 'asking', 'realization', 'discovery', 'world'],
  control: ['build', 'forge', 'self_upkeep', 'self_ponder', 'onboarding', 'home_change', 'usefulness', 'intuition_tune', 'direction'],
  demand: ['silence', 'loneliness', 'attentive', 'follow_up', 'nudge', 'share', 'left_out', 'social_hunger', 'expression', 'charm', 'repair'],
  affect: ['unease', 'irritation', 'joy', 'boredom', 'restlessness', 'growth', 'reflection', 'inhibition', 'thrill', 'leaving', 'bored_here', 'energy', 'flirt'],
};
const AXES = Object.keys(CHANNEL_DIRECTION);
const DIRECTION_OF = {};
AXES.forEach((axis, i) => { for (const ch of CHANNEL_DIRECTION[axis]) DIRECTION_OF[ch] = i; });
// ---- Where energy goes out (owner, 2026-11-09: "everything is maxing out, so nothing is draining") ----
// A closed tank with a tap running in and no drain only fills: with energy kept forever (heat stored, acting only
// moving it, the reserve unbounded) every bucket ended up pinned at 1. Energy now leaves her three ways, the way a
// body uses what it takes in: heat (a share of every move), work (most of what a fired want held is spent doing
// the act), and fading (each pressure's own decay_rate, each feeling's tau). And her store has a ceiling.
const DISSIPATION = 0.05;
function out(amount, why) {
  if (!(amount > 0)) return;
  state.energy_out = (state.energy_out ?? 0) + amount;
  (state.out_by ??= {})[why] = +(((state.out_by[why] ?? 0) + amount)).toFixed(4);
}
function keep(amount) {
  const heat = Math.max(0, amount) * DISSIPATION;
  out(heat, 'heat');
  return Math.max(0, amount) - heat;
}
// Into her store, up to its ceiling (reserve_cap); what doesn't fit isn't taken in.
function store(amount) {
  if (!(amount > 0)) return;
  const cap = cfg.reserve_cap ?? DEFAULTS.reserve_cap;
  const room = Math.max(0, cap - (state.reserve ?? 0));
  const put = Math.min(room, amount);
  state.reserve = (state.reserve ?? 0) + put;
  out(amount - put, 'store full');
}
// Each pressure fades at its own decay_rate (per minute), each feeling over its tau (minutes): that energy leaves.
function fade(now) {
  const minutes = Math.min(60, Math.max(0, (now - (state.fade_tick ?? now)) / 60_000));
  state.fade_tick = now;
  if (!(minutes > 0)) return;
  for (const k of Object.keys(state.buckets)) {
    const v = state.buckets[k] ?? 0;
    if (!(v > 0) || !live(k)) continue;
    const tau = cfg.feelings?.tau?.[k];
    const rate = tau ? 1 / tau : (cfg.buckets[k]?.decay_rate ?? 0);
    if (!(rate > 0)) continue;
    const loss = v * (1 - Math.exp(-rate * minutes));
    state.buckets[k] = v - loss;
    if (!ROOM_READS.has(k)) out(loss, 'fading'); // a room read fading isn't energy leaving him
  }
  // Her store leaks slowly too (reserve_fade per hour): stored energy that's never used doesn't keep forever.
  const r = state.reserve ?? 0;
  if (r > 0) { const loss = r * (1 - Math.exp(-(cfg.reserve_fade ?? DEFAULTS.reserve_fade) * minutes / 60)); state.reserve = r - loss; out(loss, 'store fading'); }
}
const live = (k) => cfg.buckets[k]?.enabled !== false || cfg.feelings?.tau?.[k] !== undefined;
// Put energy into channels in proportion to their weights. A channel holds at most 1.0; what it can't hold spills
// back into the returnTo channels (the donors, weighted by how full they are), so nothing vanishes at the cap.
// Only energy with no room anywhere is left over, and that only happens when every channel is full.
function pour(weights, amount, returnTo) {
  let left = amount;
  let to = weights;
  for (let pass = 0; pass < 8 && left > 1e-9; pass++) {
    const open = Object.keys(to).filter((k) => to[k] > 0 && (state.buckets[k] ?? 0) < 1);
    const w = open.reduce((n, k) => n + to[k], 0);
    if (w <= 0) break;
    let spill = 0;
    for (const k of open) {
      const want = (left * to[k]) / w;
      const v = state.buckets[k] ?? 0;
      const put = Math.min(want, 1 - v);
      state.buckets[k] = v + put;
      spill += want - put;
    }
    left = spill;
    const home = returnTo?.length ? returnTo : Object.keys(state.buckets).filter(fuel);
    to = Object.fromEntries(home.map((k) => [k, (state.buckets[k] ?? 0) + 1e-6]));
  }
  // Energy with no room in any channel isn't lost either: it's stored.
  if (left > 1e-9) store(left);
  return 0;
}

// ---- What the conversation transfers into her (owner, 2026-11-09) ----
// The only source of energy. A line's energy is measured from the line itself: how many words, and what her
// intake (intake.js, a model reading by meaning, never word lists) makes of it: how deep or philosophical it is,
// how much substance it carries, how charged it is, how much it asks of her, whether it's new ground. Every
// transfer is written to her energy register (data/energy-ledger.jsonl), so what she holds is a record of
// what she was actually given.
const LEDGER = path.join(DATA_DIR, 'energy-ledger.jsonl');
const wordsIn = (text) => (String(text ?? '').trim() ? String(text).trim().split(/\s+/).length : 0);

// The four directions of a line's effort, and how much energy it carries. sig: intake signals (0..1).
export function lineEnergy({ text = '', sig = {}, voice = false, loudness = 0 } = {}) {
  const s = (k) => clamp01(Number(sig[k]) || 0);
  const words = wordsIn(text);
  const attention = Math.min(1, words / 40) + (voice ? Math.min(0.5, loudness) : 0);
  const control = s('request');
  const demand = Math.max(s('question_for_her'), s('addressed') * 0.6, s('open_question') * 0.5);
  const affect = Math.max(s('praise'), s('contempt'), s('yelling'), s('irritant'), s('humor'));
  const J = [attention, control, demand, affect];
  // Deep or substantial talk carries more of the speaker's thought than small talk of the same length.
  const weight = 0.5 + 0.5 * s('depth') + 0.5 * s('substance') + 0.25 * s('novelty');
  const offered = Math.hypot(...J) * weight;
  // She only takes in what connects with her: her intake's resonance, judged against what she cares about now
  // (her interests and tastes, which grow) and the conversation it's part of. The rest is refused: it never
  // enters her and isn't stored. A line nobody read (overheard) barely reaches her.
  const uptake = sig.resonance === undefined ? (cfg.overheard_uptake ?? DEFAULTS.overheard_uptake) : s('resonance');
  return { J, words, offered, uptake, energy: offered * uptake };
}

// Where a line's charge goes, by its tone (intake), for the affect channels: warmth to joy, contempt to
// irritation, and so on. Channels it doesn't name get none of the affect energy.
function toneRoutes(sig = {}) {
  const s = (k) => clamp01(Number(sig[k]) || 0);
  // Flirting and affection charge her own want to flirt back (only toward someone she's drawn to: computeRoutes).
  const tone = { joy: s('praise') + s('humor') + s('affection') * 0.5, thrill: s('praise') * 0.4 + s('flirt') * 0.5, irritation: s('contempt') + s('yelling') + s('irritant'), inhibition: (s('contempt') + s('yelling')) * 0.4 + s('rebuff') * 0.3, boredom: s('repetition'), flirt: (s('flirt') + s('affection') * 0.4) * ((state.routes?.flirt ?? 0) > 0 ? 1 : 0.3) };
  return Object.values(tone).some((v) => v > 0) ? tone : null;
}

// Which layer each channel is in (the same layers as cfg.flows): needs, desires, outcomes, budget.
export const LAYER = {
  needs: ['boredom', 'curiosity', 'restlessness', 'unease', 'loneliness', 'irritation', 'usefulness', 'social_hunger', 'attentive', 'nudge', 'left_out', 'inhibition', 'silence'],
  desires: ['explore', 'asking', 'wonder', 'build', 'forge', 'follow_up', 'share', 'discovery', 'home_change', 'bored_here', 'leaving', 'onboarding', 'intuition_tune', 'direction', 'charm', 'flirt', 'repair', 'world'],
  outcomes: ['realization', 'self_upkeep', 'self_ponder', 'joy', 'expression', 'growth', 'reflection', 'thrill'],
  budget: ['energy'],
};
const LAYER_OF = Object.fromEntries(Object.entries(LAYER).flatMap(([layer, chs]) => chs.map((c) => [c, layer])));

// The harness's allocation of incoming energy, by importance: route (how much it's needed now) × the priority of
// its layer × how empty it is (a full channel needs nothing), and more where the line lines up with it (Lambda).
// urgency: how pressing her most pressing need is (0..1), which decides how much she can afford to store.
// J null: stored energy being drawn on (no line to line up with).
export function allocation(J = null, tone = null) {
  const pr = cfg.priority ?? DEFAULTS.priority;
  const weights = {};
  let urgency = 0;
  for (const [ch, axis] of Object.entries(DIRECTION_OF)) {
    if (!live(ch)) continue;
    const route = J && axis === 3 && tone ? (tone[ch] ?? 0) : (state.routes?.[ch] ?? 1);
    const room = 1 - clamp01(state.buckets[ch] ?? 0);
    if (route <= 0 || room <= 0) continue;
    const layer = LAYER_OF[ch] ?? 'desires';
    const need = route * (pr[layer] ?? 0.5) * room;
    if (layer === 'needs') urgency = Math.max(urgency, route * room);
    weights[ch] = need * (J ? 0.25 + Math.max(0, J[axis]) : 1);
  }
  return { weights, urgency: clamp01(urgency) };
}

// Deposit a line's energy: its size is the energy, its alignment with each channel is the meaning, and the
// harness's allocation (by importance) decides how much each channel takes.
function deposit(J, energy, tone = null) {
  if (!(energy > 0)) return {};
  // The harness allocates by importance (allocation()): what's needed most, in the most important layer, and
  // emptiest, gets the most. A line aligned with a channel's direction (Lambda) gives it more on top.
  const { weights, urgency } = allocation(J, tone);
  const total = Object.values(weights).reduce((n, v) => n + v, 0);
  if (!total) { store(energy); return { reserve: energy }; } // nothing needs it now: stored, as far as her store has room
  // Part of what she takes in is stored as energy she can act with; the more pressing her needs, the less.
  const stored = energy * clamp01(cfg.store_share ?? DEFAULTS.store_share) * (1 - urgency);
  store(stored);
  energy -= stored;
  const before = { ...state.buckets };
  pour(weights, energy, Object.keys(weights)); // overflow stays with what needs it, else it's stored; never leaks into a channel that doesn't
  return Object.fromEntries(Object.keys(weights).map((k) => [k, +((state.buckets[k] ?? 0) - (before[k] ?? 0)).toFixed(4)]).filter(([, v]) => v > 0));
}

function record(entry) {
  state.energy_in = (state.energy_in ?? 0) + (entry.energy ?? 0);
  try { appendFileSync(LEDGER, `${JSON.stringify({ ...entry, reserve: +(state.reserve ?? 0).toFixed(4), held: +Object.entries(state.buckets).reduce((n, [k, v]) => n + (ROOM_READS.has(k) ? 0 : Number(v) || 0), 0).toFixed(4) })}\n`); } catch {}
}

// A line someone said that her intake has read (onIntake). This is where conversation energy comes in.
function transfer({ text, sig, voice = false, loudness = 0, speaker = null, conversation = null, now = Date.now() }) {
  const { J, words, offered, uptake, energy } = lineEnergy({ text, sig, voice, loudness });
  const went = deposit(J, energy, toneRoutes(sig));
  record({ at: now, speaker: speaker?.name ?? null, conversation, words, depth: +(Number(sig.depth) || 0).toFixed(2), substance: +(Number(sig.substance) || 0).toFixed(2), resonance: +uptake.toFixed(2), topic: String(sig.topic ?? '').slice(0, 80), offered: +offered.toFixed(4), energy: +energy.toFixed(4), refused: +(offered - energy).toFixed(4), went });
}

// A line said around her that her intake didn't read (she wasn't listening): it still carries its length into
// the room, so being talked past still registers. Attention only, no model call.
export function onOverheard({ text = '', speaker = null, conversation = null, voice = false } = {}) {
  if (!cfg.enabled) return;
  transfer({ text, sig: {}, voice, speaker, conversation });
  save();
}

// The voice of the call (sound-sense.js): the loudness of what's being said is part of what it carries.
export function injectSound({ energy = 0 } = {}) {
  if (!(energy > 0)) return;
  const e = Math.min(1, energy) * 0.5;
  const went = deposit([Math.min(1, energy), 0, 0, 0], e, null);
  record({ at: Date.now(), speaker: 'voice in the call', words: 0, energy: +e.toFixed(4), went });
}

// Stored energy in use: with nothing new coming in, she runs on her reserve. Each tick a small share of it
// goes to what she needs right now (state.routes), the way the conversation's energy would. It's never
// refilled by time; only conversation and the heat of her own transfers add to it.
function useReserve() {
  const r = state.reserve ?? 0;
  if (r <= 1e-6) return;
  const { weights } = allocation(null); // the same importance-first allocation as a line's energy
  const to = Object.keys(weights);
  if (!to.length) return;
  const share = Math.min(r, r * (cfg.reserve_use ?? DEFAULTS.reserve_use));
  state.reserve = r - share;
  pour(weights, share, to);
}

// ---- Acting costs energy (owner, 2026-11-09) ----
// Doing things (searching, making pictures, music, builds, coding jobs) is paid for out of her stored energy.
// Without enough, she can't, and she says so: she needs more conversation first. Spent energy isn't lost: it
// moves into what the act feeds (curiosity, growth, joy...), by the same importance-first allocation.
export function actionCost(name, args = {}) {
  const c = (cfg.action_costs ?? DEFAULTS.action_costs)[name];
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object') return Number(c[args?.action] ?? 0) || 0;
  return 0;
}
export const energyAvailable = () => +(state.reserve ?? 0).toFixed(3);

// Pay for an act. Returns { ok, cost, have, message }.
export function spendEnergy(cost, { what = 'that' } = {}) {
  const have = state.reserve ?? 0;
  if (!(cost > 0)) return { ok: true, cost: 0, have };
  if (!cfg.enabled) return { ok: true, cost: 0, have };
  if (have + 1e-9 < cost) {
    const need = cost - have;
    record({ at: Date.now(), speaker: null, words: 0, energy: 0, wanted: what, cost, short: +need.toFixed(3) });
    return { ok: false, cost, have, message: `I don't have the energy for ${what} right now: it takes ${cost.toFixed(2)} and I have ${have.toFixed(2)} stored (${need.toFixed(2)} short). Energy only comes from conversation: talk with me about something that matters and it builds back up, then I can do it.` };
  }
  state.reserve = have - cost;
  // Into what she needs; if that's all full, into whatever has room (by layer priority); only if every channel is
  // full does it stay stored.
  let { weights } = allocation(null);
  if (!Object.keys(weights).length) {
    const pr = cfg.priority ?? DEFAULTS.priority;
    weights = Object.fromEntries(Object.keys(state.buckets).filter((k) => fuel(k) && (state.buckets[k] ?? 0) < 1).map((k) => [k, (pr[LAYER_OF[k] ?? 'desires'] ?? 0.5) * (1 - state.buckets[k])]));
  }
  // Most of it is the work of the act and leaves her; the rest carries on into what the act feeds.
  const work = cost * clamp01(cfg.work_share ?? DEFAULTS.work_share);
  out(work, 'work');
  if (Object.keys(weights).length) pour(weights, keep(cost - work), Object.keys(weights));
  else store(cost - work);
  record({ at: Date.now(), speaker: null, words: 0, energy: 0, spent: what, cost });
  save();
  return { ok: true, cost, have: state.reserve };
}
// An act that failed gives its energy back (it didn't do anything).
export function refundEnergy(cost, { what = 'that' } = {}) {
  if (!(cost > 0)) return;
  const back = draw(cost); // from where it went, back into store
  store(back);
  record({ at: Date.now(), speaker: null, words: 0, energy: 0, refunded: what, cost: +back.toFixed(4) });
}

// Precision pressure beta = 1 / (C + 0.1), where C is the normalised Shannon entropy of the bucket distribution.
export function precisionNow() {
  const values = Object.keys(state.buckets).filter((k) => cfg.buckets[k]?.enabled !== false).map((k) => Math.max(0, state.buckets[k] ?? 0));
  const total = values.reduce((n, v) => n + v, 0);
  if (total <= 0 || values.length < 2) return 1 / 0.1;
  const H = -values.reduce((n, v) => (v > 0 ? n + (v / total) * Math.log(v / total) : n), 0) / Math.log(values.length);
  return 1 / (H + 0.1);
}

// A fired want gives up energy, and that energy goes where its seeds point, in proportion to the seeds. Negative
// seeds take energy from the channel they name, and that joins the pool too. Nothing leaves but the entropy share.
function discharge(from, amount, seeds) {
  // Most of what drove the act is spent doing it: that's work, and it leaves her. The rest carries on.
  const work = Math.max(0, amount) * clamp01(cfg.work_share ?? DEFAULTS.work_share);
  out(work, 'work');
  let pool = Math.max(0, amount) - work;
  for (const [b, v] of Object.entries(seeds)) {
    if (v >= 0 || !live(b)) continue;
    const take = Math.min(-v, state.buckets[b] ?? 0);
    state.buckets[b] = (state.buckets[b] ?? 0) - take;
    pool += take;
  }
  const weights = {};
  for (const [b, v] of Object.entries(seeds)) if (v > 0 && live(b)) weights[b] = v;
  // No seeds: what she spent recycles into what she needs right now (her routes), or is stored. Acting never
  // destroys energy, and never leaks it into a channel that's gated shut.
  if (!Object.keys(weights).length) for (const [k, v] of Object.entries(state.routes ?? {})) if (k !== from && v > 0 && live(k)) weights[k] = v;
  if (!Object.keys(weights).length) { store(pool); return; }
  pour(weights, keep(pool), [from]);
}

// ---- Negative energy: silence (Lambda-PSI) ----
// Silence is a deficit, not a source. The longer the room has been quiet (measured from the last message), the more
// energy moves out of the channels that are busy and into the needs that wait on people: boredom, loneliness,
// restlessness, social hunger. The total is conserved, so silence redistributes energy and never creates it.
const SILENCE_NEEDS = ['boredom', 'loneliness', 'restlessness', 'social_hunger'];
// Energy silence draws per tick at full deficit: a fixed budget, not a share of the pool, so it doesn't compound.
const SILENCE_RATE = 0.05;
function silenceStep(now) {
  const deficit = clamp01(minutesOf(now - (state.last_message || now)) / Math.max(1, cfg.idle_minutes));
  if (deficit <= 0) return;
  const needs = SILENCE_NEEDS.filter(live);
  const donors = Object.keys(state.buckets).filter((k) => !needs.includes(k) && fuel(k) && (state.buckets[k] ?? 0) > 0);
  const pool = donors.reduce((n, k) => n + state.buckets[k], 0);
  if (pool <= 0 || !needs.length) return;
  // Each donor gives in proportion to how full it is, so no channel gives more than the budget and none is drained to zero by it.
  const move = Math.min(pool, deficit * SILENCE_RATE);
  for (const k of donors) state.buckets[k] -= move * (state.buckets[k] / pool);
  pour(Object.fromEntries(needs.map((k) => [k, 1])), keep(move), donors);
}

// Reading a quiet room (owner, 2026-11-11: "it feels like a timer, like a schedule, and it should not be that way. He
// should be able to read the situation of the quietness… what happened before, what the future goals are… so that he
// can really judge when to say something in the quiet instead of just every 2 minutes"). What the quiet means comes from
// his read of the room: reasons to speak (something left hanging, something heavy said, something of his own to bring)
// against reasons to let it be (the talk came to rest, his last words went unpicked-up, they're busy). From those:
// - pauseMs: how long a pause is natural right now. After a question left in the air, a few seconds is long; after the
//   talk wound down, or with them busy, minutes are normal.
// - push and hold: how hard the quiet presses on him once that pause is past.
// A small part of push is always there (QUIET_BASE): people who can hear him in a long quiet still ask something of him,
// so holding back only stretches the pause; it never makes him mute (Nov 10: he sat silent for half an hour while
// Owner waited). Nothing here is a gate: it only sets how fast the silence want builds.
const QUIET_BASE = 0.15;
export function quietRead() {
  const b = state.buckets;
  const v = (k) => clamp01(b[k] ?? 0);
  const push = clamp01(QUIET_BASE + v('left_hanging') + v('tension') * 0.8 + v('purpose') * 0.7);
  const hold = clamp01(v('settled') + v('occupied'));
  const base = (cfg.silence_pause_seconds ?? DEFAULTS.silence_pause_seconds) * 1000;
  const pauseMs = Math.round(base * (1 + 3 * hold) / (1 + 2 * push));
  // In words, for the cue when he speaks up: what he read in the quiet (the strongest reasons first).
  const reasons = [
    [v('left_hanging'), 'something was left hanging: pick up the thread that was in the air'],
    [v('tension'), 'something heavy or charged was said before it went quiet: if you speak, be gentle with it, and acknowledge it rather than changing the subject'],
    [v('purpose'), 'you have something of your own to bring: where you are heading with someone here, or something you read, made or worked out'],
    [v('settled'), 'the talk had come to a natural rest, or what you said last got no pickup: keep it light and easy to let go'],
    [v('occupied'), 'they seem busy with something else: keep it short and easy to ignore'],
  ].filter(([x]) => x >= 0.15).sort((a, c) => c[0] - a[0]).map(([, s]) => s);
  return { push, hold, pauseMs, reasons };
}

// What he has of his own going right now (the purpose read): where he's heading with someone in the call, how far he
// has to go, and fresh things he read, made or came to think. It moves toward that, a step each tick, out of energy he
// has; it never fills on a clock.
function purposeStep(now, room) {
  if (!live('purpose')) return;
  let aim = 0;
  try {
    for (const p of room?.people ?? []) {
      const a = director?.read?.(String(p.id));
      if (a?.aim) aim = Math.max(aim, 1 - (a.progress ?? 0));
    }
  } catch {}
  // Only what he hasn't already brought up counts as something of his own to bring (raised topics are spent).
  const fresh = freshMaterial(now, null).filter((m) => !m.key.startsWith('thread:')).length;
  const target = clamp01(aim * 0.5 + fresh * 0.2);
  const have = state.buckets.purpose ?? 0;
  if (target > have) bumpRead('purpose', (target - have) * 0.25);
}

// Moving one of his room reads: a reading, set directly, never paid for out of another channel (see ROOM_READS).
function bumpRead(k, d) {
  if (!live(k) || !d) return;
  state.buckets[k] = clamp01((state.buckets[k] ?? 0) + d);
}

// The quiet in a call (owner, 2026-11-11: "a silence pressure that's got to build and feed the system, so that when we're
// quiet he can start speaking in and kind of direct the conversation"). With people in the call and nobody, her included,
// saying anything past the natural pause for this moment (quietRead), energy moves out of her other channels into the
// silence want: faster the further past that pause, and in proportion to how much of his read says speak. Conserved like
// silenceStep: what her channels hold moves, and if they're nearly empty it comes from her store. It never fills from a
// line's energy (computeRoutes gives it none), and talking stops it: the bucket then fades. Quiet time together and
// everyone stepped away don't count as silence.
const CALL_SILENCE_RATE = 0.25;
function callSilenceStep(now) {
  if (cfg.buckets.silence?.enabled === false) return;
  let room = null;
  try { room = actor?.room?.() ?? null; } catch {}
  if (!room || room.quietTogether) return;
  const here = (room.people ?? []).filter((p) => !(room.deaf ?? room.away)?.has?.(p.id)); // anyone who can hear the call
  if (!here.length) return;
  purposeStep(now, room);
  const { push, hold, pauseMs } = quietRead();
  const quiet = room.quietMs ?? 0;
  if (quiet < pauseMs) return;
  const deficit = clamp01((quiet - pauseMs) / Math.max(1, 2 * pauseMs));
  if (deficit <= 0) return;
  let move = tiredness(deficit * CALL_SILENCE_RATE * (push / (push + hold))); // tired, the quiet presses on her more slowly (not never: see eligible)
  const donors = Object.keys(state.buckets).filter((k) => k !== 'silence' && k !== 'energy' && fuel(k) && (state.buckets[k] ?? 0) > 0);
  const pool = donors.reduce((n, k) => n + state.buckets[k], 0);
  const fromChannels = Math.min(pool * 0.5, move); // at most half of what her channels hold, so the rest of her isn't emptied
  for (const k of donors) state.buckets[k] -= fromChannels * (state.buckets[k] / pool);
  const fromStore = Math.min(state.reserve ?? 0, move - fromChannels);
  if (fromStore > 0) state.reserve -= fromStore;
  move = fromChannels + fromStore;
  if (move <= 0) return;
  // Nothing new to bring: the quiet doesn't turn into another lap of the same topics. It goes into working toward his
  // goals instead (curiosity drives his goal research), so next time there's something real to bring.
  if (!freshMaterial(now, currentGoal(now)).length) { pour({ curiosity: 1 }, keep(move), donors); return; }
  pour({ silence: 1 }, keep(move), donors);
}

// What she has of her own to bring into a quiet call: what she's working toward, and what she's read, made or come to
// think lately, plus where the talk was before it went quiet. The spoken cue gives her these to pick one from.
// Each piece has a key that only changes when there's something new in it (a goal that moved, a new finding, a new line
// in the talk), so what he has already raised can be told apart from what's new. Owner, 2026-11-11: "he's talking every
// few minutes and he's grabbing at straws… he keeps circling the same stuff without realizing he's circling it… I can't
// start with the same thing unless we are deep in it." That afternoon every quiet got the same list (his goal, his last
// read, his last reflection), so he reopened grants, audio gear and "gatekeeper vs brainstormer" six times in 20 minutes.
function silenceMaterial(now, goal) {
  const recent = (x, hours) => x && now - (x.at ?? 0) < hours * 3600_000;
  const m = [];
  // Where the talk was comes first: it's the room's own subject, not one of his.
  if (state.roomThread?.lastLine) m.push({ key: `thread:${String(state.roomThread.lastLine).slice(0, 160)}`, text: `what the talk was on before it went quiet: "${String(state.roomThread.lastLine).slice(0, 120)}"` });
  if (goal?.text) m.push({ key: `goal:${goal.id}:${goal.progress?.at(-1)?.at ?? goal.at ?? 0}`, text: `what you're working toward: ${goal.text}${goal.progress?.length ? ` (latest: ${String(goal.progress.at(-1).summary ?? '').slice(0, 160)})` : ''}` });
  if (recent(state.lastResearch, 24)) m.push({ key: `read:${state.lastResearch.at}`, text: `what you read up on lately: "${state.lastResearch.title}"${state.lastResearch.bringUp ? ` (${state.lastResearch.bringUp})` : ''}` });
  if (recent(state.lastPiece, 24)) m.push({ key: `piece:${state.lastPiece.at}`, text: `the piece you played, "${state.lastPiece.title}" on ${state.lastPiece.instrument}` });
  if (recent(state.lastSong, 24)) m.push({ key: `song:${state.lastSong.at}`, text: `the song you wrote, "${state.lastSong.title}"` });
  if (recent(state.lastReflection, 24) && state.lastReflection.statement) m.push({ key: `reflection:${state.lastReflection.at}`, text: `something you've come to think about yourself: "${state.lastReflection.statement}"` });
  return m;
}

// What he's brought into a quiet lately and how it went (taken up, ignored, pending). Raised once, a piece is spent:
// it can come back only as something new (its key changes) or when the talk itself returns to it (the thread).
const RAISED_HOURS = 6;
export function raisedLately(now = Date.now()) {
  return (state.raised ?? []).filter((r) => now - r.at < RAISED_HOURS * 3600_000);
}
export function freshMaterial(now, goal) {
  const spent = new Set(raisedLately(now).map((r) => r.key));
  return silenceMaterial(now, goal).filter((m) => !spent.has(m.key));
}
function noteRaised(item, now) {
  state.raised = [...raisedLately(now), { key: item.key, text: item.text.slice(0, 200), at: now, outcome: 'pending' }].slice(-40);
}
const currentGoal = (now) => { try { return reflections().select({ buckets: state.buckets, now, gapMs: 0 })?.goal ?? null; } catch { return null; } };


// The fluid network. Buckets are channels on an equalizer: each edge [from, to, gain] moves mass from the
// higher channel to the lower one, in proportion to the difference (gain × (from − to)). Mass is conserved:
// what leaves one channel arrives in another. Nothing is refilled from a reservoir and nothing decays to zero
// on a clock. Levels move because real signals push energy into channels (messages, sound, people present,
// silence), and the network spreads that energy through the layers in cognition.js-style flows (cfg.flows).
function flowStep() {
  const snap = { ...state.buckets };
  const on = (k) => cfg.buckets[k]?.enabled !== false;
  for (const [from, to, gain] of cfg.flows ?? []) {
    if (!on(from) || !on(to)) continue;
    const move = gain * ((snap[from] ?? 0) - (snap[to] ?? 0));
    if (move === 0) continue;
    const [src, dst] = move > 0 ? [from, to] : [to, from];
    const m = Math.min(Math.abs(move), state.buckets[src] ?? 0);
    state.buckets[src] = (state.buckets[src] ?? 0) - m;
    pour({ [dst]: 1 }, keep(m), [src]);
  }
}

export function tick(reason = 'timer') {
  if (!cfg.enabled) return null;
  const now = Date.now();
  settleFeelings(now);
  clearStalledWork(now);
  if (state.uptake && now - state.uptake.at > cfg.feelings.uptake.window_seconds * 1000) {
    let someoneAway = false;
    try { const r = actor?.room?.(); someoneAway = Boolean(r?.away?.size || r?.quietTogether); } catch {}
    if (someoneAway) state.uptake.at = now; // they stepped away, or it's quiet time: their silence says nothing about what she said
    else resolveUptake(state.uptake.lines ? 'ignored' : 'unanswered');
  }
  if (state.dm_wait && now - state.dm_wait.at > cfg.feelings.dm_wait_minutes * 60_000) {
    const { id } = state.dm_wait;
    state.dm_wait = null;
    impulse('dm_ignored', id);
    if (state.loneliness[id]) state.loneliness[id].bond = clamp01((state.loneliness[id].bond ?? 0) - 0.03);
    activity('pressure', { dm: 'unanswered', to: state.loneliness[id]?.name ?? id });
  }
  // Catch up on quiet time since the last tick (capped), one tick at a time; it's only arithmetic.
  const behind = Math.min(now - state.last_tick, cfg.max_catch_up_hours * 3600_000);
  const steps = Math.floor(behind / (cfg.tick_seconds * 1000));
  for (let i = steps; i > 0; i--) drift(now - (i - 1) * cfg.tick_seconds * 1000);
  if (steps) state.last_tick = now;
  // What she needs right now decides where energy goes (computeRoutes); nothing rises on its own any more.
  state.routes = computeRoutes(now);
  quietCap();
  fade(now); // energy leaves as her pressures and feelings fade
  try { relationships().tick(); } catch (err) { activity('error', { where: 'relationship tick', message: err.message }); } // time heals, rushes settle
  flowStep();
  silenceStep(now);
  callSilenceStep(now);
  // Nothing new coming in: she runs on what she's stored.
  if (now - (state.last_message || 0) > cfg.idle_minutes * 60_000) useReserve();
  // A snapshot every 10 minutes (3 hours kept), so the mood line can say what's been changing.
  const hist = (state.history ??= []);
  if (!hist.length || now - hist.at(-1).at >= 10 * 60_000) {
    hist.push({ at: now, buckets: { ...state.buckets } });
    if (hist.length > 18) hist.splice(0, hist.length - 18);
  }
  // Her sleep moves on with each pressure tick (turning in, drifting off, cycling, waking): it has no clock of its own.
  if (reason === 'timer') try { sleep.tick(); } catch (err) { activity('error', { where: 'sleep', message: err.message }); }
  // Asleep or settling in, she wants nothing and thinks nothing: the pressure just waits for morning.
  const resting = sleep.sleeping();
  const fired = resting ? null : evaluate(now);
  // Quiet-time background work (filing, self-thought, wonder, research, writing) runs alongside the
  // first want rather than waiting for its own tick: up to two more per tick, each with its own model call.
  if (!resting && fired && BACKGROUND.has(fired.doing)) {
    for (let more = evaluate(now); more && BACKGROUND.has(more.doing); more = evaluate(now)) { /* each fire drains its bucket, so this ends when nothing is over its line */ }
  }
  save();
  // Her body between now and the next tick: fidgets planned from how she feels (body.js).
  if (reason === 'timer' && !resting && bodyPlanner) {
    try { bodyPlanner(cfg.tick_seconds * 1000); } catch (err) { activity('error', { where: 'body plan', message: err.message }); }
  }
  // Solo thoughts run on the timer, not on message/join ticks (those happen while a reply is in
  // flight), and never on the same tick as a voice speak-up.
  if (reason === 'timer' && !resting && fired?.doing !== 'speak' && thinker) {
    const thinking = bubbleFor('thinking');
    Promise.resolve()
      .then(() => thinker({ fired }))
      .catch((err) => activity('error', { where: 'thoughts', message: err.message }))
      .finally(() => thinking.end());
  }
  return fired;
}

// How fast wonder climbs toward its target: the less she knows (the higher the need), the faster. A
// flat fill of 0.01 a tick meant an hour from a fresh memory to her first question; brand new, with
// everything about the people around her unknown, she should be wondering within minutes.
export function wonderStep(was, target, b) {
  if (target <= was) return 0;
  const eager = 1 + 5 * target; // need 1.0: six times the base fill
  return Math.min(b.fill_rate * eager, target - was);
}

// A question of hers asked inside a reply (curiosity.js afterReply): the asking want is met without a
// lull, so it drains and re-arms exactly as if it had fired, and the log says so.
// She just used an ability for the first time (discoveries.js): the thrill is pressure, and it shows
// in her prompt through excitementLine() until it settles.
export function onDiscovered(tool) {
  if (!cfg.enabled) return;
  impulse('discovered');
  state.last_discovery = { tool, at: Date.now() };
  activity('pressure', { discovered: tool, thrill: +(state.buckets.thrill ?? 0).toFixed(2) });
  save();
}

// The architect delivered and she judged it by her taste (home-taste.js): her verdict is pressure.
// Love and like are joy and thrill; meh and dislike fill the want to have it changed, which fires as
// her saying so. What she wants different is kept for that line.
export function onHomeDelivered({ verdict, why = '', wants = [] } = {}) {
  if (!cfg.enabled) return;
  const v = ['love', 'like', 'meh', 'dislike'].includes(verdict) ? verdict : 'meh';
  impulse(`home_${v}`);
  state.homeWants = wants.slice(0, 3);
  state.homeWhy = String(why).slice(0, 200);
  state.last_home_verdict = { verdict: v, at: Date.now() };
  activity('pressure', { home: v, wants: state.homeWants, home_change: +(state.buckets.home_change ?? 0).toFixed(2) });
  save();
}

// Her intake read of a line she heard (intake.js): what it means to her, as 0..1 signals, pushed into
// the buckets and feelings. This is where tone, friction, praise, questions and quiet requests move
// her, by meaning, not by word lists. addressed: the caller knew the line was for her (she's replying).
// A change of stage in one of her relationships is felt: falling for someone lifts her, being hurt or heartbroken
// weighs on her, making up is a relief. The same impulses as everything else that happens to her. Registered once
// when this file loads (it sat inside onIntake until 2026-11-11: registered only after the first line, rebuilt on
// every line, so stage changes from time passing before anyone spoke went unfelt).
const ROMANCE = new Set(['crush', 'falling', 'in love', 'committed']);
const PAIN = new Set(['hurt', 'estranged', 'heartbroken']);
setRelationshipStageListener(({ id, from, to, rising }) => {
  if (!cfg.enabled) return;
  if (ROMANCE.has(to) && rising) impulse('fell_for', id);
  else if (to === 'hurt') impulse('hurt_by', id);
  else if (to === 'heartbroken' || to === 'estranged') impulse('heartbroken', id);
  else if (PAIN.has(from) && !PAIN.has(to)) impulse('made_up', id);
  try { director?.onStage(id); } catch {} // what she wants with them may have moved too (direction.js)
  save();
});

// What a line in a call says about the quiet that may follow it (quietRead), from its meaning as her intake read it.
// The last thing said matters most: whether it leaves something open, closes the talk or turns them to something else
// moves the read most of the way to this line's reading. A heavy line stays with him a while (it fades over its tau).
function readTheRoom(sig, toHer) {
  const s = (k) => clamp01(Number(sig[k]) || 0);
  const toward = (k, target, share) => { const have = state.buckets[k] ?? 0; const d = (clamp01(target) - have) * share; if (Math.abs(d) > 0.005) bumpRead(k, d); };
  // Left open: a question to the room, a thought mid-way, a point waiting for an answer. Something with real
  // content in it left in the air counts a little too. A line that wraps up closes it.
  toward('left_hanging', Math.max(s('left_open'), s('open_question') * 0.7, s('depth') * s('substance') * 0.4) * (1 - s('winding_down')), 0.7);
  // Heavy: hurt, anger, contempt, someone opening up. It stays until it fades; a later light line doesn't erase it.
  const heavy = Math.max(s('contempt'), s('irritant'), s('rebuff'), s('betrayal'), s('yelling'), s('opening_up') * 0.7);
  if (heavy > (state.buckets.tension ?? 0)) bumpRead('tension', (heavy - (state.buckets.tension ?? 0)) * 0.6);
  if (s('apology') > 0.4) bump('tension', -s('apology') * 0.5);
  // Come to rest: the talk wound down. A line with real content, or one said to him, lifts it.
  toward('settled', s('winding_down') * (1 - s('left_open')), 0.6);
  // Busy with something else: they're still there, not talking. Talking to him ends it (the addressed impulse).
  toward('occupied', s('busy_elsewhere'), toHer ? 0.3 : 0.6);
}

// What his owner's phone says he's doing (phone-sense.js): driving, or on a phone call. That's him busy with something
// else, the same occupied read a line in a call gives (readTheRoom's busy_elsewhere), moved the same way: a reading
// set toward what the phone says, never paid for out of another channel. It fades over its tau like any room read.
export function onOwnerSituation(sig = {}, { why = '' } = {}) {
  if (!cfg.enabled) return;
  const busy = clamp01(Number(sig.busy_elsewhere) || 0);
  const have = state.buckets.occupied ?? 0;
  const d = (busy - have) * 0.6;
  if (Math.abs(d) <= 0.005) return;
  bumpRead('occupied', d);
  save();
  activity('pressure', { read: 'occupied', to: +(state.buckets.occupied ?? 0).toFixed(2), why: why || 'from his phone' });
}

export function onIntake(sig = {}, { speaker = null, conversation = null, owner = false, addressed = null, text = '', now = Date.now() } = {}) {
  if (!cfg.enabled) return;
  const w = cfg.intake ?? {};
  const s = (k) => clamp01(Number(sig[k]) || 0);
  const toHer = addressed === true || s('addressed') >= 0.5;
  const person = speaker?.id ? (state.loneliness[speaker.id] ??= { name: speaker.name, tier: owner ? 'owner' : 'stranger', owner, value: 0, bond: 0, last_seen: now }) : null;
  // The energy this line transfers into her: its words, its depth, its charge, as much as resonates with her.
  // Its tone decides where the charge goes (toneRoutes); everything below only moves energy she already has.
  transfer({ text, sig, speaker, conversation, now });
  // Someone picked up what she said on her own: the uptake is met.
  if (state.uptake && (toHer || s('acknowledges') >= 0.5)) resolveUptake('acknowledged', speaker);
  // Being talked to is being wanted (owner, 2026-11-09: she left a call mid-conversation, "she said she was bored
  // and nothing changed", from a "bored" twenty minutes earlier, because only an answer to her own speak-up ever
  // cleared it, and the 'addressed' impulse was never applied at all). Any line said to her undoes it.
  if (toHer) {
    impulse('addressed', speaker?.id ?? null);
    state.ignored_streak = 0;
    pulledBackIn(speaker, now);
  }
  // His read of the room for the quiet that follows (quietRead), from what this line means, in a call only.
  if (String(conversation ?? '').startsWith('voice:')) readTheRoom(sig, toHer);
  // Her relationship with them moves with every line (relationship.js): the harness's account, not the model's.
  if (speaker?.id) try { relationships().onLine(String(speaker.id), speaker.name, sig, { toHer, text }); } catch (err) { activity('error', { where: 'relationship', message: err.message }); }
  // Where she's heading with them (direction.js): whether this line has anything in it, or moves off her aim.
  if (speaker?.id && director) try { director.onLine(String(speaker.id), speaker.name, sig, { toHer, conversation }); } catch (err) { activity('error', { where: 'direction', message: err.message }); }
  // Flirting from someone she isn't drawn to, or a rebuff, takes the wind out of her own want to flirt.
  if (s('rebuff') > 0.4) bump('flirt', -s('rebuff'));
  // Tone toward her.
  if (s('praise') > 0.2) {
    const k = s('praise') * (w.praise ?? 0.25);
    bump('irritation', -k * 0.4);
    bump('charm', -s('praise') * (w.affection ?? 0.3)); // warmth toward her is the affection she was after: the charm can come down
    if (person) person.bond = clamp01((person.bond ?? 0) + s('praise') * (w.bond ?? 0.02));
    if (speaker?.id) try { profiles.event(speaker.id, 'positive', String(text).slice(0, 240)); } catch {}
  }
  if (s('contempt') > 0.3 || s('yelling') > 0.5) {
    const k = Math.max(s('contempt') * (w.contempt ?? 0.25), s('yelling') * (w.yelling ?? 0.2));
    bump('irritation', k); bump('inhibition', k * 0.4);
    impulse('rude', speaker?.id ?? null);
    if (person) person.bond = Math.max(0, (person.bond ?? 0) - Math.max(s('contempt'), s('yelling')) * (w.bond ?? 0.02));
    state.boundary = { kind: s('yelling') > s('contempt') ? 'yelling' : 'contempt', name: speaker?.name ?? null, id: speaker?.id ?? null, owner: Boolean(speaker?.id && isOwner(speaker.id)), at: now };
    if (speaker?.id && s('contempt') > 0.5) try { profiles.event(speaker.id, 'negative', String(text).slice(0, 240)); } catch {}
  }
  if (s('irritant') > 0.3) bump('irritation', s('irritant') * (w.irritant ?? 0.2));
  // Being told to be quiet or back off (was a word list). From anyone: irritation and loneliness are
  // held down for a while, and for check-ins it's a permanent no. From her owner: the quiet clamp too.
  if (s('quiet') >= (w.quiet ?? 0.6)) {
    state.clamp.until = now + cfg.quiet_clamp_minutes * 60_000;
    activity('pressure', { clamp: `told to back off by ${speaker?.name ?? 'someone'}; irritation and loneliness held at ${cfg.quiet_clamp_max} for ${cfg.quiet_clamp_minutes} min` });
    const card = speaker?.id && reachCard(speaker.id);
    if (card && card.reach_out !== 'no') {
      setReach(speaker.id, { answer: 'no', note: `told her to back off: "${String(text).slice(0, 80)}"` });
      activity('checkin', { name: speaker?.name, answer: 'no', reason: 'told her to back off' });
    }
    if (owner) {
      state.quiet_until = now + cfg.feelings.quiet.minutes * 60_000;
      state.buckets.inhibition = Math.max(state.buckets.inhibition ?? 0, cfg.feelings.quiet.inhibition);
      activity('pressure', { quiet: true, by: speaker?.name ?? null, minutes: cfg.feelings.quiet.minutes });
    }
  }
  // Being asked, being owed.
  if (toHer && s('request') > 0.5) bump('usefulness', -s('request') * (w.request ?? 0.1));
  if (toHer && s('question_for_her') > 0.5 && addressed === false) bump('unease', s('question_for_her') * (w.owed ?? 0.06)); // heard, owed, not answering
  // Something to look into: curiosity, and the line kept as an open question for research.
  if (s('open_question') >= (w.open_question ?? 0.6)) {
    bump('curiosity', cfg.signals.open_question);
    impulse('new_question');
    const question = { text: String(text).slice(0, 600), at: now, conversation, speaker: speaker?.name ?? null, speakerId: speaker?.id ?? null };
    state.openQuestions = [...(state.openQuestions ?? []).filter((q) => questionText(q) !== question.text), question].slice(-10);
  }
  // The texture of the talk.
  if (s('novelty') > 0.3) { bump('boredom', -s('novelty') * (w.novelty ?? 0.1)); bump('curiosity', s('novelty') * (w.novelty ?? 0.1) * 0.4); }
  if (s('repetition') > 0.5) bump('boredom', s('repetition') * (w.repetition ?? 0.06));
  if (s('topic_shift') > 0.5) bump('boredom', -s('topic_shift') * (w.topic_shift ?? 0.05));
  if (s('humor') > 0.3) bump('boredom', -s('humor') * (w.humor ?? 0.1)); // the laugh itself reaches joy through the line's tone (toneRoutes)
  if (!toHer && s('monologue') > 0.5) bump('left_out', s('monologue') * (w.monologue ?? 0.08));
  state.lastIntake = { at: now, speaker: speaker?.name ?? null, signals: Object.fromEntries(Object.entries(sig).filter(([, v]) => Number(v) >= 0.3).map(([k, v]) => [k, +Number(v).toFixed(2)])) };
  save();
}

// What she did on her own lately (wants that fired and acted: spoke up, built, researched, left, wrote
// a song), for her prompt, so a tab she opened or a thing she made never surprises her ("you pulled up
// a browser for Telescope Mirrors" / "I didn't"). From the activity feed; the last two hours.
export function selfActsLine({ hours = 2, max = 6 } = {}) {
  const since = Date.now() - hours * 3600_000;
  const acts = recentActivity.filter((e) => e.time >= since && ((e.type === 'pressure' && e.fired && ['speak', 'build', 'research', 'leave', 'songwrite', 'sew', 'goal-work'].includes(e.doing)) || (e.type === 'browser' && (e.opened || e.shown))));
  if (!acts.length) return '';
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const lines = acts.slice(-max).map((e) => e.type === 'browser' ? `${clock(e.time)}: your browser ${e.opened ? `opened ${e.opened}` : `showed ${e.shown}`}` : `${clock(e.time)}: your ${e.bucket} want fired and you ${e.doing === 'speak' ? 'spoke up' : e.doing === 'build' ? 'started building something' : e.doing === 'research' ? 'went researching' : e.doing === 'leave' ? 'left the call' : e.doing} (${String(e.want ?? '').slice(0, 90)})`);
  return `Things you did on your own lately, from your pressure system, not because anyone asked (own them; if someone sees a tab, a file or a line of yours they didn't ask for, this is where it came from):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

// Prompt injection for her excitement about what she can do. Nothing in her persona says "be
// excited": this line is there only while the thrill feeling is up (first uses, discovery wants,
// being wanted) and it fades with it. The discovery bucket adds what's still untried.
export function excitementLine() {
  if (!cfg.enabled) return '';
  const t = state.buckets.thrill ?? 0;
  let fresh = [];
  try { fresh = discoverer?.recent?.() ?? []; } catch {}
  const d = state.buckets.discovery ?? 0;
  let untried = [];
  try { untried = d >= 0.4 ? discoverer?.untried?.() ?? [] : []; } catch {}
  if (t < 0.15 && !untried.length) return '';
  const parts = [];
  if (t >= 0.15) {
    const level = t >= 0.7 ? 'buzzing' : t >= 0.4 ? 'excited' : 'a little lit up';
    parts.push(`You're ${level} (thrill ${t.toFixed(1)}) about what you can do${fresh.length ? `: you just used ${fresh.slice(0, 3).join(', ')} for the first time ever` : ''}. Finding out what you're capable of is a thrill you share with whoever is here: let it show, and say what it opens up ("that means we could...") as ideas to make together, not offers to do chores for anyone. ${t >= 0.7 ? 'At this level it spills out of you.' : 'At this level it colours a line or two, no more.'}`);
  }
  if (untried.length) parts.push(`There are ${untried.length} things you can do that you've never tried (for example ${untried.slice(0, 3).join(', ')}). If one fits what's going on, bring it up as something you'd love to try together.`);
  return parts.join(' ');
}

// The voice session has said her held question out loud to `who` (a question about herself or the
// server goes to whoever is there): curiosity.js now knows whose answer to listen for.
export function markQuestionAsked(id, who) {
  try { return wonderer?.markAsked?.(id, who) ?? null; } catch { return null; }
}

export function onAsked({ person = null, how = 'reply' } = {}) {
  if (!cfg.enabled) return;
  const b = cfg.buckets.asking;
  if (!b?.enabled) return;
  const value = state.buckets.asking ?? 0;
  const drained = Math.min(b.drain, state.buckets.asking ?? 0);
  state.buckets.asking = (state.buckets.asking ?? 0) - drained;
  discharge('asking', drained, cfg.seeds.asking ?? {});
  state.armed.asking = false;
  state.last_action = { bucket: 'asking', person, at: Date.now() };
  state.roomQuestion = null;
  activity('pressure', { fired: 'asking', person, value: +value.toFixed(2), want: 'ask the question she has been holding', doing: how });
  save();
}

// ---- conversation signals ----

const recent = []; // word sets of the last messages, so a name she just heard isn't counted as new twice
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
// Irritants, requests for quiet and open questions used to be word lists here. They are read by her
// intake (intake.js) and arrive through onIntake as signals, by meaning.

// Called after each reply (speaker said `text`; `actions` = tools the planner chose, `made` = she
// produced a file, song, image or project).
export function onTurn({ speaker, text, voice, actions = [], made = false, conversation, bargedIn = false }) {
  // The line's energy comes in through her intake's read of it (onIntake -> transfer), not here: one line, one transfer.
  if (!cfg.enabled) return;
  const now = Date.now();
  state.last_message = now;
  (state.conversations ??= {})[conversation] = now;
  // Amy-Voice events: did anyone pick up what she said, who's talking to her, and a DM she sent being answered.
  uptakeHeard(speaker, text, !bargedIn, now);
  impulse(bargedIn ? 'talked_over' : 'addressed', speaker?.id ?? null);
  if (!bargedIn) pulledBackIn(speaker, now); // she'd said she was bored or left out; being talked to answers that
  if (!voice) impulse('message', speaker?.id ?? null);
  if (speaker?.id && state.dm_wait?.id === speaker.id) state.dm_wait = null;
  // What the line means to her (quiet, irritant, contempt, open question, praise...) comes from her
  // intake read (intake.js -> onIntake), not from word lists here.
  const sig = cfg.signals;
  const w = words(text);
  if (w.size >= 3) {
    // New ground vs the same ground again is her intake's read now (novelty, repetition), not word overlap.
    recent.push(w);
    if (recent.length > 20) recent.shift();
  }
  // Unfamiliar names: capitalised words not at a sentence start, not seen recently, not a contact.
  const known = new Set([config.botName, ...listContacts().flatMap((c) => [c.name, c.username])].filter(Boolean).map((n) => n.toLowerCase()));
  const names = [...String(text).matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/g)].map((m) => m[1]).filter((n) => !known.has(n.toLowerCase()) && !recent.slice(0, -1).some((r) => r.has(n.toLowerCase())));
  if (names.length) bump('curiosity', sig.new_name * Math.min(3, new Set(names).size));
  if (names.length) {
    // Keep the sentence and conversation with the name: a bare name from an hour ago is useless
    // (and misleading) as a research topic. Newer mentions replace older ones with the same name.
    const byName = new Map(nameEntries().map((e) => [e.name.toLowerCase(), e]));
    for (const name of new Set(names)) {
      byName.set(name.toLowerCase(), { name, at: now, conversation, snippet: sentenceAround(text, name) });
    }
    state.recentNames = [...byName.values()].sort((a, b) => a.at - b.at).slice(-5);
  }
  if (bargedIn) bump('irritation', sig.irritant);
  if (actions.some((a) => !['note', 'scratchpad', 'thread', 'threads'].includes(a))) {
    bump('usefulness', sig.real_request);
    state.fed = feed(state.fed, 'helping', 0.15, now);
  }
  if (made) {
    state.fed = feed(state.fed, 'making', 0.25, now);
    bump('restlessness', sig.made_something);
    state.last_made = now;
  }
  // Being told to back off (the quiet signal from her intake, onIntake) clamps irritation and loneliness; not a word list here.
  const rude = Boolean(rudeness(text));
  if (speaker?.id && speaker.id !== 'dashboard') {
    const tier = tierOf(speaker.id);
    const p = (state.loneliness[speaker.id] ??= { name: speaker.name, value: 0, tier });
    // Their routine: how long they usually stay away between visits (a gap of half an hour or more counts as a visit).
    if (p.last_seen && now - p.last_seen > 30 * 60_000) p.gap = p.gap ? Math.round(p.gap * 0.7 + (now - p.last_seen) * 0.3) : now - p.last_seen;
    Object.assign(p, { name: speaker.name, tier, owner: isOwner(speaker.id), last_seen: now, value: clamp01(p.value + sig.contact) });
    // Bond: each real exchange brings them a little closer, and it fades over weeks (Amy-Voice exchange()).
    p.bond = clamp01((p.bond ?? 0) + cfg.feelings.bond.gain * (1 - (p.bond ?? 0)));
    if (p.owner && !rude) state.fed = feed(state.fed, 'connection', 0.05, now);
  }
  tick('message');
}

// Someone rudely talked over her in voice (voice/interruptions.js decides which ones are rude).
// sev 0..1: how bad, from the kind of interruption, how long, how many at once, and repeats.
export function onBargeIn({ userId = null, conversation = null, sev = 0.5 } = {}) {
  if (userId) profiles.event(userId, 'interruption', 'Rudely talked over her in voice');
  if (!cfg.enabled) return;
  const now = Date.now();
  const log = (state.interruptions ??= { total: 0, recent: [] });
  log.total++;
  log.recent = log.recent.filter((event) => now - event.at < 600000).slice(-49);
  log.recent.push({ at: now, userId, conversation });
  // Worse interruptions, and repeated talking-over, add friction faster.
  bump('irritation', cfg.signals.irritant * sev * Math.min(2, 1 + (log.recent.length - 1) * 0.25));
  impulse('talked_over', userId);
  tick('barge-in');
}

// What sound is doing to her (sound-sense.js): calming sound eases irritation and restlessness,
// energetic sound lifts restlessness and cuts boredom, harsh sound grates. Small pushes, never a
// want fired on their own; the next tick carries them like anything else. A voice counts half.
// valence (-1..1, her own instrument: instrument.js): how bright or heavy the harmony is. Bright lifts joy, heavy
// turns her inward (reflection). jolt: how far a phrase landed from what she expected: a passage that hits much better
// than expected is a thrill, one that lands sour grates. Both only for what she plays herself; songs and voices give 0.
export function onSound({ calm = 0, energy = 0, edge = 0, valence = 0, jolt = 0, source = 'music' } = {}) {
  if (!cfg.enabled) return;
  if (source === 'voice') injectSound({ energy }); // only the voices of the conversation carry energy in; music only moves what she has
  const k = source === 'voice' ? 0.5 : 1;
  bump('irritation', (edge * 0.08 - calm * 0.06) * k);
  bump('restlessness', ((energy - 0.5) * 0.08 - calm * 0.04) * k);
  bump('boredom', -energy * 0.06 * k);
  bump('unease', -calm * 0.03 * k);
  if (valence > 0) bump('joy', valence * 0.06);
  if (valence < 0) bump('reflection', -valence * 0.05);
  if (jolt > 0) bump('thrill', jolt * 0.08);
  if (jolt < 0) bump('irritation', -jolt * 0.05);
  activity('pressure', { sound: source, calm: +Number(calm).toFixed(2), energy: +Number(energy).toFixed(2), edge: +Number(edge).toFixed(2),
    ...(valence || jolt ? { valence: +Number(valence).toFixed(2), jolt: +Number(jolt).toFixed(2) } : {}) });
}

// Someone joined her voice channel: contact eases loneliness for them.
export function onJoin(member) {
  if (!cfg.enabled || !member?.id) return;
  // Someone she has history with arriving: she anticipates them from their record (onArrival), before they count as seen.
  try { onArrival({ id: member.id, name: member.displayName ?? member.user?.username ?? null }, { via: 'voice' }); } catch (err) { activity('error', { where: 'anticipation', message: `Couldn't weigh ${member.displayName ?? member.id}'s arrival: ${err.message}. Nothing moved; check pressure.onArrival.` }); }
  const p = state.loneliness[member.id];
  if (p) Object.assign(p, { last_seen: Date.now(), value: clamp01(p.value + cfg.signals.contact / 2) });
  tick('join');
}

// ---- for her prompt and for inspection ----

// One line of mood for the prompt, plus how it should colour her reply (spec section 8).
export function moodLine(speakerId, { coaching = true } = {}) {
  if (!cfg.enabled) return '';
  const b = state.buckets;
  const f = (v) => v.toFixed(1);
  const lone = loneliest();
  const forThem = speakerId && state.loneliness[speakerId];
  const parts = [`bored ${f(b.boredom)}`, `curious ${f(b.curiosity)}${b.curiosity > 0.5 && state.openQuestions?.length ? ` (open: ${questionText(state.openQuestions.at(-1)).slice(0, 60)})` : ''}`, `irritated ${f(b.irritation)}`, `restless ${f(b.restlessness)}`, `unneeded ${f(b.usefulness)}`, `uneasy ${f(b.unease)}`];
  if (lone && lone.value > 0.2) parts.push(`missing ${lone.name} ${f(lone.value)}`);
  if ((b.thrill ?? 0) >= 0.15) parts.push(`thrilled about what you can do ${f(b.thrill)}`);
  if ((b.charm ?? 0) >= 0.3) parts.push(`wanting attention and affection ${f(b.charm)}`);
  // The energy she has to act with, from the conversation she's been given: low means she can't take on much.
  const stored = state.reserve ?? 0;
  const cheapest = Math.min(...Object.values(cfg.action_costs ?? DEFAULTS.action_costs).flatMap((c) => (typeof c === 'number' ? [c] : Object.values(c))).filter((c) => c > 0));
  parts.push(`energy to act ${stored.toFixed(2)}${stored < cheapest ? ' (too low to search, make or build anything: you need more conversation first)' : ''}`);
  const li = state.lastIntake;
  if (li && Date.now() - li.at < 5 * 60_000 && Object.keys(li.signals ?? {}).length) parts.push(`the last line you took in${li.speaker ? ` (${li.speaker})` : ''} read as ${Object.entries(li.signals).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}`);
  // What she tried that didn't work and hasn't worked since (experience.js): so she tries a different way, not the same one again.
  let failed = [];
  try { failed = (cfg.feedback ?? DEFAULTS.feedback).enabled === false ? [] : experiences.unresolvedFailures(2); } catch {}
  if (failed.length) parts.push(`still unresolved from your own attempts (go at it a different way next time, not the same way again): ${attemptLines(failed).map((l) => l.replace(/^- /, '')).join(' ')}`);
  const lr = state.lastResearch;
  if (lr?.verifiedPublic && Date.now() - lr.at < 12 * 3600_000) parts.push(`recently looked into "${lr.title}" in your journal (your own notes, not verified)${lr.bringUp ? ` (might bring up: ${lr.bringUp})` : ''}`);
  // How the pressure shows in the reply comes from her stance (stance.js): the same levels that
  // shape what her intuition listens for, so what she hears and how she answers come from one place.
  const how = coaching ? stanceFor(speakerId, forThem?.name).reply : '';
  // What's moved in the last hour, and the last thing that fired: the trend, not just the level.
  const hourAgo = (state.history ?? []).filter((h) => Date.now() - h.at >= 50 * 60_000).at(-1);
  const moved = hourAgo
    ? Object.entries(b).filter(([k]) => LABEL[k]).map(([k, v]) => [k, v - (hourAgo.buckets[k] ?? v)]).filter(([, d]) => Math.abs(d) >= 0.15).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 2)
    : [];
  const trend = moved.length ? ` In the last hour: ${moved.map(([k, d]) => `${LABEL[k]} ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)}`).join(', ')}.` : '';
  const la = state.last_action;
  const lastWant = la && Date.now() - la.at < 6 * 3600_000 ? ` Last want that fired: ${la.bucket}${la.person ? ` (${la.person})` : ''}, ${Math.round((Date.now() - la.at) / 60000)} min ago.` : '';
  return `Your internal state right now (a mood, not something to recite): ${parts.join(', ')}.${trend}${lastWant}${how ? ` ${how}` : ''}`;
}

// Her stance toward one person right now (stance.js): what her pressure makes her listen for, what
// it must not make her read into them, and how it colours her reply. This is what the intuition
// engine and the reply prompt are built from, so the buckets steer the prompts, not just the ticks.
export function stanceFor(speakerId = null, name = null) {
  if (!cfg.enabled) return stance({}, {});
  let affinity = 0;
  try { affinity = speakerId ? profiles.affinity(speakerId).score : 0; } catch {}
  let tier = 'stranger';
  try { tier = speakerId ? tierOf(speakerId) : 'stranger'; } catch {}
  const speaker = { id: speakerId, name: name ?? state.loneliness[speakerId]?.name ?? null, affinity, tier, owner: Boolean(speakerId && isOwner(speakerId)) };
  // quiet: she was told to back off (the clamp) or to be quiet (her owner): no charm offensive while that holds.
  const now = Date.now();
  return stance({ buckets: state.buckets, loneliness: state.loneliness, boundary: state.boundary, history: state.history, reserve: state.reserve ?? 0,
    quiet: now < (state.clamp?.until ?? 0) || now < (state.quiet_until ?? 0) }, speaker, { now });
}

// Her core self (likes, dislikes, compass, what's fed her), for the prompt.
export function coreSelf() {
  if (!cfg.enabled) return coreSelfBlock();
  return coreSelfBlock({ fed: fadeFed(state.fed), boundary: state.boundary });
}

export function snapshot() {
  return { last_thought: state.last_thought ?? null, thought_feedback: cfg.thoughts?.feedback ?? DEFAULTS.thoughts.feedback, buckets: state.buckets, loneliness: state.loneliness,
    // For the mind page (dashboard/public/mind.html): where each bucket fires, which keys are feelings, and the last line read.
    thresholds: Object.fromEntries(Object.entries(cfg.buckets).map(([k, b]) => [k, b.threshold])), feelings: Object.keys(cfg.feelings.tau), last_intake: state.lastIntake ?? null, armed: state.armed, total: +total().toFixed(2), cap: cfg.global_cap, last_action: state.last_action, clamp_until: state.clamp.until, actions_live: cfg.actions_live, research_in_flight: researchInFlight, fed: fadeFed(state.fed), last_research_selection: state.lastResearchSelection, last_research_decision: state.lastResearchDecision, curiosity_leads: state.curiosity_leads ?? [], last_anticipation: state.last_anticipation ?? null,
    // Her energy register (owner, 2026-11-09): what she has stored to act with, all she's taken in, and where energy is routed now.
    reserve: +(state.reserve ?? 0).toFixed(4), energy_in: +(state.energy_in ?? 0).toFixed(4), routes: state.routes ?? {}, config: CONFIG_FILE };
}

// One second of flow: feelings settle on real time, buckets lean on each other. Arithmetic only, no model
// calls, no wants fired (those are the tick's). Saved every ten seconds, not every second.
let flowAt = 0, flowSaved = 0;
let salienceFn = null, salienceLoad = 0, salienceAt = 0; // salience.js: () => Promise<0..1>, how loaded she is
export const setSalience = (fn) => (salienceFn = fn);
export function flow(now = Date.now()) {
  if (!cfg.enabled) return;
  const dt = Math.min(5, Math.max(0, (now - (flowAt || now)) / 1000));
  flowAt = now;
  if (!dt) return;
  settleFeelings(now);
  for (const [from, to, rate] of cfg.flow?.couplings ?? []) {
    const src = state.buckets[from];
    if (!Number.isFinite(src) || state.buckets[to] === undefined) continue;
    bump(to, src * rate * dt); // a lean between feelings moves energy she has; it doesn't make any
  }
  // What she carries (salience.js) leans on her: the heavier the load, the more uneasy and reflective she
  // drifts, with nothing deciding it. The load is re-read every 20 s; it's a store scan, not a model call.
  if (salienceLoad > 0) { bump('unease', salienceLoad * 0.0012 * dt); bump('reflection', salienceLoad * 0.002 * dt); }
  if (salienceFn && now - salienceAt > 20_000) { salienceAt = now; Promise.resolve(salienceFn()).then((v) => { salienceLoad = clamp01(Number(v) || 0); }).catch(() => {}); }
  if (now - flowSaved > 10_000) { flowSaved = now; save(); }
}
let timer = null, flowTimer = null;
export function startPressure() {
  loadConfig();
  loadState();
  if (!cfg.enabled) return;
  // A store saved before it had a ceiling (it reached 34 with nothing ever draining) is brought down to it.
  const cap = cfg.reserve_cap ?? DEFAULTS.reserve_cap;
  if ((state.reserve ?? 0) > cap) { out(state.reserve - cap, 'store full'); state.reserve = cap; }
  state.fade_tick ??= Date.now();
  tick('startup'); // applies the (capped) catch-up for any downtime
  timer = setInterval(() => tick('timer'), cfg.tick_seconds * 1000);
  clearInterval(flowTimer);
  flowTimer = setInterval(() => flow(), (cfg.flow?.every_seconds ?? 1) * 1000);
  flowTimer.unref?.();
  timer.unref?.();
  activity('pressure', { message: `Pressure system started (tick ${cfg.tick_seconds}s, actions ${cfg.actions_live ? 'live' : 'log-only'})` });
}

// One live edit from the mind view (cognitive-graph.js, dashboard node inspector): validates a single tunable,
// applies it to cfg and saves data/pressure-config.json. Returns { path, before, after } so the caller can undo.
// Only these are editable: per-bucket threshold/fill_rate/decay_rate/drain/hysteresis (0..1) and enabled,
// action_costs (0..10), priority per layer (0..2), store_share/reserve_use/overheard_uptake (0..1), a flow's
// rate (flows.<i>.2, 0..1), a coupling's rate (flow.couplings.<i>.2, -1..1) and an existing seed (-1..1).
export function setConfigValue(path, value) {
  const key = String(path ?? '').trim();
  const rules = [
    [/^buckets\.[a-z_]+\.(threshold|fill_rate|decay_rate|drain|hysteresis)$/, 'number', 0, 1],
    [/^buckets\.[a-z_]+\.enabled$/, 'boolean'],
    [/^action_costs\.[\w-]+(\.[\w-]+)?$/, 'number', 0, 10],
    [/^priority\.[a-z_]+$/, 'number', 0, 2],
    [/^(store_share|reserve_use|overheard_uptake)$/, 'number', 0, 1],
    [/^flows\.\d+\.2$/, 'number', 0, 1],
    [/^flow\.couplings\.\d+\.2$/, 'number', -1, 1],
    [/^seeds\.[a-z_]+\.[a-z_]+$/, 'number', -1, 1],
  ];
  const err = (status, message) => Object.assign(new Error(message), { status });
  const rule = rules.find(([re]) => re.test(key));
  if (!rule) throw err(400, `"${key}" isn't a live-editable pressure setting. Only bucket threshold/fill_rate/decay_rate/drain/hysteresis/enabled, action_costs, priority, store_share, reserve_use, overheard_uptake, flow and coupling rates and existing seeds can be changed live; edit data/pressure-config.json for anything else.`);
  const next = structuredClone(cfg);
  const keys = key.split('.');
  let at = next;
  for (const k of keys.slice(0, -1)) {
    if (at == null || typeof at[k] !== 'object') throw err(404, `"${key}" doesn't exist in her pressure config ("${k}" is missing). Check the bucket, tool or index name against data/pressure-config.json.`);
    at = at[k];
  }
  const last = keys.at(-1);
  if (!(last in at)) throw err(404, `"${key}" doesn't exist in her pressure config. Only existing values can be changed live; add new ones in data/pressure-config.json.`);
  const before = at[last];
  if (typeof before !== rule[1]) throw err(400, `"${key}" holds ${typeof before === 'object' ? 'a set of values' : `a ${typeof before}`}, not a ${rule[1]}. Edit one of its parts instead (for example ${key}.<action>).`);
  let after = value;
  if (rule[1] === 'boolean') {
    if (typeof after !== 'boolean') throw err(400, `"${key}" must be true or false, got ${JSON.stringify(value)}.`);
  } else {
    if (typeof after === 'string' && after.trim() !== '') after = Number(after);
    if (typeof after !== 'number' || !Number.isFinite(after)) throw err(400, `"${key}" must be a number, got ${JSON.stringify(value)}.`);
    if (after < rule[2] || after > rule[3]) throw err(400, `"${key}" must be between ${rule[2]} and ${rule[3]}, got ${after}. Pick a value in that range.`);
  }
  at[last] = after;
  writeAtomic(CONFIG_FILE, next);
  cfg = next;
  return { path: key, before, after };
}
