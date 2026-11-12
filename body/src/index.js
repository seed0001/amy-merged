import './instance-lock.js'; // first: a second copy of this bot exits here, before it touches anything
import { lastWipe } from './memory-wipe.js'; // first: a wipe from the dashboard runs before anything opens her memory
import './model-guard.js'; // before anything that calls a model: every model call is logged, and refused when no LLM is in use
import { once } from 'node:events';
import { brain } from './brain-client.js';
import { workGoal } from './goal-work.js';
import {startCloudPublisher} from './cloud-publisher.js';
import { startCalendar } from './calendar.js';
import { config } from './config.js';
import { checkOllama } from './llm.js';
import { activity } from './events.js';
import { bot } from './bot.js';
import { startDashboard } from './dashboard/server.js';
import { startPhoneLink } from './phone-link.js';
import { loadWhisper } from './voice/whisper.js';
import { ownerWorkRunning } from './agents.js';
import { setOwnerWork } from './pressure.js';
import { startPressure, setResearcher, setThinker, setGoalWorker, setSongwriter, setSongGate, setSeamstress, setInstrument, setWonderer, setTuner, setDirector, setSelfWork, setOnboarding, setBodyPlanner, snapshot as pressureSnapshot } from './pressure.js';
import { selfWork } from './self-work.js';
import { onboardingNeed, onboardingBriefing } from './onboarding.js';
import { tuner } from './intuition-tune.js';
import { direction } from './direction.js';
import { songwrite, canWrite } from './songbook.js';
import { designOwn, sewing, blenderPath, hasDressForm } from './seamstress.js';
import { play as playInstrument, playing, inCall } from './instrument-play.js';
import { body } from './body.js';
import { wonderer } from './curiosity.js';
import { sleep } from './sleep.js';
import { dreams } from './dreams.js';
import { sessions } from './voice/session.js';
import { research } from './journal.js';
import { think } from './thoughts.js';
import { startContinuity } from './continuity.js';
import { reflections, onGoalLeft } from './reflections.js';
import { interests as grownInterests } from './interests.js';
import { sleepOnIt } from './sleep-on-it.js';
import { doctorLocked } from './doctor.js';

// Bind the dashboard before starting Discord or any background writers. An occupied port is a
// startup failure rather than a second bot silently running with no dashboard.
try { await once(startDashboard(bot), 'listening'); }
catch (err) {
  console.error(`Dashboard startup failed: ${err.message}`);
  process.exit(1);
}
// The phone link (phone-link.js): its own server for the owner's phone app, this computer and Tailscale only.
// It never stops the companion starting: if it can't listen, the activity log says why and how to fix it.
startPhoneLink(bot).catch((err) => activity('error', { where: 'phone link', message: `The phone link couldn't start: ${err.message}. Everything else runs as normal.` }));

// A missing or otherwise broken Ollama model is a setup problem, not a fatal one: warn and keep
// going so the dashboard always comes up and can show what's wrong.
// With no language model in use there is no Ollama to check: her own brain is started now, so its word database is
// loaded before the first line is said to her. A brain that won't start is reported, and the dashboard still comes up.
if (config.brain === 'amy') {
  brain().start().catch((err) => {
    console.error(`Her brain didn't start: ${err.message}`);
    activity('error', { where: 'brain', message: err.message });
  });
} else checkOllama().catch((err) => {
  console.error(`Ollama check failed: ${err.message}`);
  activity('error', { where: 'startup', message: `Ollama check failed: ${err.message}` });
});

if (lastWipe) activity('memory-wiped', { moved: lastWipe.moved.length, backup: lastWipe.backup, failed: lastWipe.failed });
doctorLocked();

process.on('unhandledRejection',(err) => activity('error', { where: 'unhandled', message: String(err?.message ?? err) }));

startCloudPublisher();

// Her pressure buckets (boredom, curiosity, loneliness...): curiosity and boredom send her off to
// research and write in her journal; the rest speak up in voice calls (see pressure.js).
setResearcher(research);
setGoalWorker(workGoal);
setThinker(think);
setSongwriter(songwrite);
setSongGate(canWrite);
// Free only when sewing can actually run: no job on the table, Blender found, and a dress form to drape on.
setSeamstress({ free: () => !sewing() && Boolean(blenderPath()) && hasDressForm(), make: designOwn });
// Her instrument (instrument-play.js): composes from her mood and plays, out loud when she's in a call. The urge is
// settled when the piece is finished and recorded, however long she played.
// When the urge to play fires, a song that really moved her lately (and she hasn't answered yet) is what she reaches
// for: her own take on it. Otherwise she plays from how she feels.
// outLoud only when his pressure chose to play for the room in a lull: making something on his own while people are
// talking is composed and recorded privately (owner, 2026-11-11: "Nobody fucking asked him to play music in the middle
// of our fucking conversation").
setInstrument({ free: () => !playing(), inCall, play: async ({ outLoud = false } = {}) => {
  const { songSense } = await import('./song-sense.js');
  const inspiredBy = songSense.moving();
  return (await playInstrument(inspiredBy ? { inspiredBy } : {}, { outLoud })).done;
} });
startPressure();
// Her sleep: she won't turn in on her own while people are in a call with her.
sleep.setCompany(() => [...sessions.values()].some((s) => !s.destroyed && s.humans().length));
sleep.setDreamer(dreams);
// Falling asleep for the night, she goes back over the day (sleep-on-it.js): shared jokes, how people treat her, her opinions.
sleep.setOnAsleep((night) => sleepOnIt().then((mind) => mind.fellAsleep(night))
  .then((done) => activity('persona', { reason: `Went back over the day: ${done.lines} lines, kept ${done.shared} shared moments, ${done.treats} reads on people, ${done.opinions} opinions`, changedBy: 'sleep' }))
  .catch((e) => activity('error', { where: 'going back over the day', message: e.message })));
sleep.start();
// Her body engine: each pressure tick plans her idle fidgets and mood sequences from how she feels.
const bodyEngine = body({ moods: () => pressureSnapshot().buckets, tired: () => sleep.status().tired, sleeping: () => sleep.sleeping() });
setBodyPlanner((ms) => bodyEngine.plan(ms));
// Her curiosity: the wonder bucket in her pressure decides when she wonders about something she doesn't know.
wonderer().then(setWonderer).catch((err) => activity('error', { where: 'curiosity', message: err.message }));
// Her own upkeep and self-thought: the self_upkeep and self_ponder buckets (self-work.js).
setSelfWork(selfWork());
setOnboarding({ need: onboardingNeed, briefing: onboardingBriefing });
setTuner(tuner); // looking back at her intuition and retuning it (intuition-tune.js)
setDirector(direction()); // where she's heading with each person, rethought when the direction bucket fires (direction.js)
// Work the owner asked for has priority: his private local-model wants wait while it runs (agents.js, pressure.js).
setOwnerWork(() => ownerWorkRunning().length > 0);
startCalendar();

// Continuity: a heartbeat so downtime is known after a restart, plus her recent mistakes.
startContinuity();

// A goal she lets go takes the interests that grew out of it with it (reflections.js, interests.js); goals let go
// while nothing was listening are caught up once.
const releaseInterests = ({ goal, about, held }) => grownInterests.letGo(about, held)
  .then((released) => { reflections().markLeftHeard(goal.id); if (released.length) activity('interests', { message: `let go with goal #${goal.id}: ${released.join(', ')}` }); })
  .catch((err) => activity('error', { where: 'interests', message: `couldn't let go of goal #${goal.id}'s interests: ${err.message}` }));
onGoalLeft(releaseInterests);
for (const note of reflections().leftUnheard()) releaseInterests(note);

// Load local Whisper in the background: it's the main transcriber, or Groq's instant fallback.
if (config.stt !== 'fish') loadWhisper().catch((err) => activity('error', { where: 'whisper', message: err.message }));

if (!config.discordToken) {
  activity('error', { where: 'startup', message: 'DISCORD_TOKEN is empty in .env, so the bot stays offline' });
} else if (config.botEnabled) {
  bot.start().catch(() => {});
} else {
  activity('power', { message: 'Bot is switched off. Turn it on from the dashboard.' });
}
