import { conversationBudget, budgetPrompt } from './conversation-budget.js';
import { intuition } from './intuition.js';
import { listen } from './listen.js';
import { avatarPower } from './avatar-cues.js';
import { mapHome } from './home.js';
import { sleep } from './sleep.js';
import { heardLine } from './reactions.js';
import { clearLead, waitForAnswer, followUpCue } from './conversation-lead.js';
import * as away from './away.js';
import { isIgnored } from './ignoring.js';
import * as openQuestion from './open-question.js';
import { setCalendarDelivery, setCalendarActivityContext, tickCalendar } from './calendar.js';
import { noteReceived, readAttachments } from './attachments.js';
import * as presence from './presence.js';
import { spamGuard } from './moderation.js';
import { resumeAfterRestart } from './restart.js';
import { watchMessage } from './protect.js';
import { setSelf, isPeer, calledByName } from './peers.js';
import { peerMayTalk } from './bot-registry.js';
import { addMessage, recentMessages } from './memory.js';
import { intake } from './intake.js';
import { isOwner } from './contacts.js';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, ChannelType } from 'discord.js';
import { config, updateSettings, selfHis } from './config.js';
import { loadCommands } from './loadCommands.js';
import { respond, SEARCH_ANNOUNCEMENT, taskCue } from './companion.js';
import { sessions } from './voice/session.js';
import { requestClip } from './avatarVideo.js';
import { activity } from './events.js';
import { shortText } from './short-text.js';
import { setWorkDoneDelivery, cueFor } from './work-done.js';
import { replyInFlight } from './busy.js';
import { setPoster, noteChannelActivity } from './thoughts.js';
import { setMessenger, onArrival } from './pressure.js';
import { mirrorToPhone } from './phone-link.js';

const commands = await loadCommands();

// Owns the Discord connection so the dashboard can turn the bot on and off without restarting the app.
export const bot = {
  client: null,
  status: 'offline', // offline | starting | online | stopping
  since: Date.now(),
  error: null,

  async start() {
    if (this.client) return;
    this.setStatus('starting');
    const client = createClient();
    this.client = client;
    try {
      await client.login(config.discordToken);
      updateSettings({ botEnabled: true });
    } catch (err) {
      this.client = null;
      client.destroy().catch(() => {});
      this.error = err.message;
      this.setStatus('offline');
      activity('error', { where: 'discord login', message: err.message });
      throw err;
    }
  },

  async stop() {
    if (!this.client) return;
    this.setStatus('stopping');
    setCalendarDelivery(null);
    setCalendarActivityContext(null);
    for (const session of [...sessions.values()]) session.destroy();
    const client = this.client;
    this.client = null;
    await client.destroy();
    updateSettings({ botEnabled: false });
    this.setStatus('offline');
    activity('power', { message: 'Bot turned off' });
    avatarPower(false); // her avatar falls asleep
  },

  setStatus(status) {
    this.status = status;
    this.since = Date.now();
    if (status !== 'offline') this.error = null;
  },
};

// Solo thoughts post through this, resolving the configured channel at post time (never at
// startup, and never falling back to a chat channel). The busy check covers text replies and a
// voice session that is speaking or has a reply queued.
setPoster({
  busy: () => replyInFlight() || [...sessions.values()].some((s) => s.speaking || s.pending > 0),
  post: async ({ channelId, content }) => {
    const client = bot.client;
    if (!client) return { posted: false, reason: 'bot_offline' };
    let channel = client.channels.cache.get(channelId);
    if (!channel) channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { posted: false, reason: 'channel_missing' };
    if (channel.type !== ChannelType.GuildText) return { posted: false, reason: 'not_text_channel' };
    const perms = channel.permissionsFor(client.user);
    if (!perms?.has('SendMessages')) return { posted: false, reason: 'no_send_permission' };
    await channel.send({ content, allowedMentions: { parse: [] } });
    return { posted: true, channel: channel.id };
  },
});

function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers, // privileged: needed for speaker names in voice
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.once(Events.ClientReady, (c) => {
    setSelf(c.user.id);
    setCalendarActivityContext(async(event)=>{
      if(bot.client!==client||!client.isReady()||!isOwner(event.owner))throw new Error('Scheduled owner or bot is unavailable.');
      const user=await client.users.fetch(event.owner),dm=await user.createDM();
      const guild=event.guildId?await client.guilds.fetch(event.guildId):undefined;
      const channel=event.channelId?await client.channels.fetch(event.channelId):dm;
      const notify=async(text)=>{for(const chunk of splitMessage(text))await dm.send({content:chunk,allowedMentions:{parse:[]}});};
      return {client,guild,channel,sendHere:(attachment)=>dm.send({files:[attachment],allowedMentions:{parse:[]}}),
        sendBackground:(attachment)=>dm.send({files:[attachment],allowedMentions:{parse:[]}}),notify};
    });
    setCalendarDelivery(async (event, content) => {
      if (bot.client !== client || !client.isReady()) throw new Error('Bot is offline.');
      if (!isOwner(event.owner) || event.owner === 'dashboard') throw new Error('Scheduled recipient is no longer a Discord owner.');
      const user = await client.users.fetch(event.owner);
      const channel = await user.createDM();
      for (const chunk of splitMessage(content)) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      addMessage(`text:${channel.id}`, { role: 'assistant', content });
      if (String(event.owner) === String(config.ownerIds[0])) mirrorToPhone(content, `${config.botName}, a scheduled message from ${selfHis()} calendar, also sent as a Discord DM`);
    });
    tickCalendar().catch((err) => activity('error', { where: 'calendar startup', message: err.message }));
    bot.setStatus('online');
    activity('power', { message: `Online as ${c.user.tag} in ${c.guilds.cache.size} server(s)` });
    avatarPower(true); // her avatar wakes up
    mapHome(client); // where she lives, as she can see it (home.js)
    const resumed = resumeAfterRestart(c).catch((err) => activity('error', { where: 'resume after restart', message: err.message }));
    // Her pressure system reaches out by DM when the person isn't in a call with her.
    setMessenger({
      // Whether this person is sitting in a voice channel on a server she's on (with her or not): then a DM asking
      // them into voice is pointless (owner, 2026-11-09: she left a call and DMed him to join one two seconds later).
      inVoice(id) {
        return client.guilds.cache.some((g) => Boolean(g.voiceStates.cache.get(String(id))?.channelId));
      },
      async dm(want) {
        const user = await client.users.fetch(want.id);
        const channel = await user.createDM();
        const name = want.person ?? user.displayName ?? user.username;
        // Owner, 2026-11-09: a DM is a short, personal text. What she wants to explain or go over (her onboarding
        // included: it used to send the whole lesson, 1,000 to 2,000 characters) waits for voice; the DM only asks him in.
        const cues = {
          loneliness: `You've been missing ${name}. DM them first, unprompted, warmly and in your own way: check in, ask about their thing, use what you remember about them.`,
          onboarding: `There's something about yourself you want to walk ${name} through (${String(want.onboardingTitle ?? 'part of how you work').slice(0, 120)}), and that's for voice. DM them one short, friendly line asking them to hop into voice with you when they're free. Don't explain any of it here.`,
          usefulness: `Nobody's needed you for a while. DM ${name} first, unprompted and casually, offering to help with something you know they've been working on, or show them something you made.`,
        };
        const cue = `${cues[want.bucket] ?? `DM ${name} something, unprompted, that fits what you know about them.`} One to three short sentences, like a real text from a friend. Anything to explain or go over is for voice, not this message. Don't explain why you're messaging or mention any system.`;
        let line = await respond({ conversation: `text:${channel.id}`, speaker: { id: user.id, name, username: user.username, dm: true }, text: '', cue, discord: { client, channel } });
        if (!line) return;
        // A DM she starts is never a wall of text, whatever the model wrote: it ends at the last full sentence
        // within a short text's length, and the cut is logged so it shows.
        const short = shortText(line);
        if (short.trimmed) activity('dm-trimmed', { to: name, bucket: want.bucket, written: line.length, sent: short.text.length });
        line = short.text;
        for (const chunk of splitMessage(line)) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
        // To the owner, it reaches his phone app too (phone-link.js).
        if (String(user.id) === String(config.ownerIds[0])) mirrorToPhone(line, `${config.botName}, on ${selfHis()} own (from ${selfHis()} ${want.bucket} pressure), also sent as a Discord DM`);
        activity('pressure', { dm: want.bucket, to: name });
      },
    });
    // Work Owner gave Claude Code on her, finished: she tells him herself, in the call if he's in one with her,
    // else in a short DM (work-done.js). Notes that waited while she was offline go out once she's back in the
    // call she was in (2026-11-10: sent the moment she came online, it went by DM 3 seconds before she rejoined
    // the call he was sitting in).
    resumed.finally(() => setWorkDoneDelivery(async (note) => {
      const owner = config.ownerIds[0];
      if (!owner) throw new Error('no owner is set in OWNER_IDS in .env, so there is nobody to tell');
      const evidence = `${note.from} "${note.title}": done. ${note.summary}`;
      const call = [...sessions.values()].find((s) => !s.destroyed && s.humans().some((m) => m.id === owner));
      // Just back from a restart, with the comeback line still to come: the note goes in it (restart.js), not before it.
      if (call?.comeback) { call.comeback.extras.push(cueFor(note)); call.comeback.evidence.push(evidence); return 'voice'; }
      if (call) { call.announce(cueFor(note), evidence); return 'voice'; }
      const user = await client.users.fetch(owner);
      const channel = await user.createDM();
      const name = user.displayName ?? user.username;
      const line = await respond({ conversation: `text:${channel.id}`, speaker: { id: user.id, name, username: user.username, dm: true }, text: '', cue: cueFor(note, { dm: true }), evidence, discord: { client, channel } });
      if (!line?.trim()) throw new Error('her reply came back empty, so there was nothing to send');
      for (const chunk of splitMessage(shortText(line).text)) await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      mirrorToPhone(shortText(line).text, `${config.botName}, telling ${name} about finished work (${note.from}), also sent as a Discord DM`);
      return 'dm';
    }).catch((err) => activity('error', { where: 'work done', message: `Notes waiting for Owner couldn't be sent: ${err.message}.` })));
  });

  // Her home changed (a channel, a member, the server itself): she looks again (home.js).
  for (const e of [Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate, Events.GuildMemberAdd, Events.GuildMemberRemove, Events.GuildUpdate]) {
    client.on(e, () => mapHome(client));
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      activity('error', { where: `/${interaction.commandName}`, message: err.message });
      const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    const peer = isPeer(message.author, message.member);
    if (message.author.bot && !peer) return;
    // Another bot she hasn't been cleared to talk with (bot-registry.js): she doesn't respond to it at all.
    if (peer && !peerMayTalk(message.author, message.member)) return;
    const budget = conversationBudget();
    const conversation = `text:${message.channelId}`;
    if (!peer) {
      clearLead(conversation);
      // The person she has a question out to has spoken (open-question.js): it's theirs to have answered or not.
      openQuestion.heard(conversation, { id: message.author.id, name: message.member?.displayName ?? message.author.username }, message.content || '');
      away.heard(conversation, { id: message.author.id, name: message.member?.displayName ?? message.author.username }, message.content || ''); // speaking in text brings someone marked away back
      // Their first message after a gap is an arrival: someone she has history with is anticipated from their record (pressure.js onArrival).
      try { onArrival({ id: message.author.id, name: message.member?.displayName ?? message.author.username }, { via: 'text' }); } catch (err) { activity('error', { where: 'anticipation', message: `Couldn't weigh ${message.author.username}'s arrival: ${err.message}. Nothing moved; check pressure.onArrival.` }); }
      // Her intake (intake.js): what the line means to her, into her pressure. In text, mentions, DMs and her open channels count as said to her.
      if (message.content) intake().hear({ conversation, speaker: { id: message.author.id, name: message.member?.displayName ?? message.author.username }, text: message.content, owner: isOwner(message.author.id),
        addressed: message.channel.type === ChannelType.DM || message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }) || config.chatChannelIds.includes(message.channelId),
        recent: recentMessages(conversation, 6).map((m) => ({ name: m.role === 'assistant' ? config.botName : m.name ?? 'someone', text: m.content })) });
    }
    const me = { id: client.user.id, name: config.botName, aliases: [client.user.username,message.guild?.members.me?.displayName].filter(Boolean) };
    budget.register(me);
    const exchange = budget.observe(conversation,{eventId:message.id,speaker:{id:message.author.id,name:message.member?.displayName ?? message.author.username},peer,text:message.content || '',owner:!peer && isOwner(message.author.id)});
    if (!peer && ['stop','wrap'].includes(exchange.control)) {
      if (message.guild) sessions.get(message.guild.id)?.interrupt({quiet:true});
      addMessage(conversation,{role:'user',userId:message.author.id,name:message.author.username,content:message.content});
      return;
    }
    let peerTurn = null;
    if (peer) {
      // Another companion talking: always heard, answered in text only when it @mentions him (his
      // name in passing isn't enough; the companions don't chat with each other in text on their own).
      const call = message.guild && sessions.get(message.guild.id);
      // A voice transcript another companion posts (🔊 its own line, 🎙️ what it heard) is a record of
      // the call, never a message to answer: answering it is how two bots end up chatting in text about
      // the call they're both in.
      const transcript = /^\s*(🔊|🎙️|🎙)/u.test(message.content ?? '');
      // While she's in a voice call in this server, the companions talk in voice, not in text: another
      // bot's text is only heard. The owner said so (2026-11-08): no side chat once they're in the call.
      const inCallHere = Boolean(call && !call.destroyed);
      if (inCallHere && message.content && !transcript) call.noteChat(message);
      const mentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
      const names = [config.botName, client.user.username, message.guild?.members.me?.displayName];
      const addressed = !transcript && !inCallHere && calledByName(message.content,{mentioned,names});
      // Another bot never wakes her: only people do.
      if (message.content && addressed && !sleep.sleeping()) peerTurn = budget.claim(conversation,exchange,me);
      if (!message.content || !peerTurn) {
        if (message.content) addMessage(`text:${message.channelId}`, { role: 'user', userId: message.author.id, name: message.member?.displayName ?? message.author.username, content: message.content });
        return;
      }
    }
    noteChannelActivity(message.channelId); // any human message, not just in reply channels
    spamGuard(message, isOwner).catch((err) => activity('error', { where: 'spam guard', message: err.message }));
    if (!message.content && !message.attachments.size) return;
    // Someone she's chosen to ignore (ignoring.js): kept as context, never answered.
    if (!peer && !isOwner(message.author.id) && isIgnored(message.author.id)) {
      if (message.content) addMessage(conversation, { role: 'user', userId: message.author.id, name: message.member?.displayName ?? message.author.username, content: message.content });
      activity('heard', { conversation, speaker: message.member?.displayName ?? message.author.username, userId: message.author.id, text: message.content, ignored: true, why: 'ignoring them' });
      return;
    }

    const isDM = message.channel.type === ChannelType.DM;
    const mentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
    const openChannel = config.chatChannelIds.includes(message.channelId);
    // In an open channel, a message aimed at another companion by name ("amy read this") is theirs:
    // kept as context, not answered, unless it names or @mentions this one too.
    if (openChannel && !isDM && !mentioned && !peer && message.content) {
      const others = [...config.peerApps.flatMap((a) => a.names), ...config.peerBots.filter((p) => !/^\d+$/.test(p))];
      const mine = [config.botName, client.user.username, message.guild?.members.me?.displayName];
      if (calledByName(message.content, { names: others }) && !calledByName(message.content, { names: mine })) {
        addMessage(`text:${message.channelId}`, { role: 'user', userId: message.author.id, name: message.member?.displayName ?? message.author.username, content: message.content });
        return;
      }
    }
    // During a live call she keeps an ear on the server's text chat, so in voice she can say what's
    // going on there. That's all: typed messages still get typed replies, never spoken ones.
    const call = message.guild && sessions.get(message.guild.id);
    if (call && !call.destroyed && (message.content || message.attachments.size)) call.noteChat(message);
    // Her intuition reads every channel on the server, aimed at her or not. DMs stay private.
    if (!isDM && message.content) {
      const who = { id: message.author.id, name: message.member?.displayName ?? message.author.username, username: message.author.username };
      listen.hear({ speaker: who.name, text: message.content });
      intuition.notice({ conversation, place: `#${message.channel.name}`, speaker: who, text: message.content, answering: mentioned || openChannel })
        .then(async (cue) => {
          if (!cue) return;
          const line = await respond({ conversation, speaker: who, text: '', cue, discord: { client, guild: message.guild, channel: message.channel, voice: call } });
          if (line) await message.channel.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } });
        }).catch((err) => activity('error', { where: 'intuition (text)', message: err.message }));
    }
    // Messages not aimed at her are still read for how people treat each other (and her).
    if (!isDM && !mentioned && !openChannel && !peer) {
      if (message.guild && message.content) {
        const recent = [...(await message.channel.messages.fetch({ limit: 6, before: message.id }).catch(() => new Map())).values()].reverse()
          .map((m) => `${m.author.id === client.user.id ? 'you' : m.member?.displayName ?? m.author.username}: ${m.content.slice(0, 200)}`);
        const speaker = { id: message.author.id, name: message.member?.displayName ?? message.author.displayName, username: message.author.username };
        const present = [...new Set(recent.map((l) => l.split(':')[0]))].map((n) => message.guild.members.cache.find((m) => m.displayName === n)).filter(Boolean)
          .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username }));
        heardLine({ id: speaker.id, name: speaker.name, text: message.content, recent, addressed: false }); // it can still get to her (reactions.js)
        watchMessage({ overheard: true, speaker, text: message.content, recent, present, discord: { guild: message.guild, channel: message.channel, voice: call },
          speak: async (cue) => {
            const line = await respond({ conversation: `text:${message.channelId}`, speaker, text: '', cue, discord: { client, guild: message.guild, channel: message.channel } });
            if (line) await message.channel.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } });
          } }).catch((err) => activity('error', { where: 'protect (text)', message: err.message }));
      }
      return;
    }

    let text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text && !message.attachments.size) return;

    if (!peer && exchange.control==='extend') {
      const candidates=[...message.guild?.members.cache.values() ?? []].filter((member)=>member.user.bot).map((member)=>member.id);
      peerTurn=budget.claim(conversation,exchange,me,{allowUnaddressed:true,candidates:candidates.length?candidates:[me.id]});
      if (!peerTurn) return;
    }
    const speaker = {
      id: message.author.id,
      name: message.member?.displayName ?? message.author.displayName,
      username: message.author.username,
      dm: isDM,
    };
    const turnAllowed = () => peerTurn ? budget.valid(conversation,peerTurn) : budget.canReply(conversation,exchange);
    const files = []; // attachments the bot makes this turn ride along with its reply
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    message.channel.sendTyping().catch(() => {});

    const keepLease = peerTurn ? setInterval(() => budget.renew(conversation,peerTurn),20000) : null;
    try {
      // Pictures and documents they sent: saved, read, and handed to her with the message.
      const attachments = message.attachments.size ? await readAttachments(message.attachments) : undefined;
      if (attachments) noteReceived({ attachments, from: speaker.id, fromName: speaker.name, dm: isDM, guild: message.guild?.id ?? null, where: isDM ? 'a DM' : `#${message.channel.name}` });
      if (!text) text = '(sent this without saying anything)';
      const reply = await respond({
        conversation: `text:${message.channelId}`,
        speaker,
        text,
        systemExtra: peerTurn ? budgetPrompt(peerTurn) : undefined,
        attachments,
        onSearching: () => turnAllowed() &&
          message.reply({ content: `🔎 ${SEARCH_ANNOUNCEMENT}`, allowedMentions: { repliedUser: false } }).catch(() => {}),
        // voice: if she's in a voice channel in this server, typed music requests play there.
        discord: {
          client,
          guild: message.guild,
          sendHere: async (file) => files.push(file),
          sendBackground: (file) => message.channel.send({ files: [file], allowedMentions: { parse: [] } }),
          channel: message.channel,
          messageId: message.id,
          voice: message.guild && sessions.get(message.guild.id),
          // Background helpers report back here when they finish, long after this reply. The
          // doctor's report is posted as is; anything else she tells them about in her own words.
          notify: async (text) => {
            const say = (content) => { for (const chunk of splitMessage(content)) message.channel.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {}); };
            if (/^Doctor visit /.test(text)) return say(text);
            const line = await respond({ conversation: `text:${message.channelId}`, speaker, text: '', cue: taskCue(text), evidence: text, discord: { client, guild: message.guild, channel: message.channel } })
              .catch((err) => { activity('error', { where: 'task report reply', message: err.message }); return ''; });
            say(line || text);
          },
          // A short line now and then while a helper works, so it's never silent for long.
          progress: (text) => message.channel.send({ content: `⏳ ${text}`, allowedMentions: { parse: [] } }).catch(() => {}),
        },
      });
      clearInterval(typing);
      if (!turnAllowed()) return;
      const outgoing = peerTurn ? budget.complete(conversation,peerTurn,me,reply || '') : budget.observe(conversation,{speaker:me,peer:true,text:reply || '',noReply:!reply});
      if (!outgoing) return;
      const chunks = splitMessage(reply || '…');
      const last = chunks.length - 1;
      // A clip of her saying it, if the recorder page is open. The text goes out now regardless;
      // the clip is added to the same message when (and if) it arrives.
      const clip = reply ? requestClip(reply,{relay:Boolean(message.guild)}) : Promise.resolve(null);
      if (call && !call.destroyed && reply) call.noteChat({ channel: message.channel, author: { displayName: 'you' }, content: reply });
      const first = await message.reply({ content: chunks[0], files: last === 0 ? files : [], allowedMentions: { repliedUser: false, parse: [] } });
      clip.then((video) => video && first.edit({ files: [{ attachment: video, name: 'reply.webm' }] })).catch((err) => activity('error', { where: 'video reply', message: err.message }));
      for (const [i, chunk] of chunks.slice(1).entries()) {
        await message.channel.send({ content: chunk, files: i + 1 === last ? files : [], allowedMentions: { parse: [] } });
      }
      if (!peer && reply) openQuestion.asked(conversation, { text: reply, to: { id: speaker.id, name: speaker.name, owner: isOwner(speaker.id) }, kind: 'reply' });
      if (!peer && isOwner(speaker.id)) waitForAnswer(conversation, reply, {
        ready: () => client.isReady() ? 'ready' : 'closed',
        followUp: async (valid) => {
          const open = openQuestion.current(conversation);
          if (!open || open.to.id !== speaker.id) return; // answered, or a newer question is in the air
          const line = await respond({ conversation, speaker, text: '', cue: followUpCue(open.text), noMonologue: true });
          if (valid() && line) await message.channel.send({ content: line.slice(0, 2000), allowedMentions: { parse: [] } });
        },
      });
    } catch (err) {
      clearInterval(typing);
      activity('error', { where: 'text reply', message: err.message });
      if (turnAllowed()) await message.reply('My brain glitched for a sec, try again?').catch(() => {});
    } finally {
      if (keepLease) clearInterval(keepLease);
      if (peerTurn) budget.release(conversation,peerTurn);
    }
  });

  // Leave voice when everyone else has left.
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const session = sessions.get(oldState.guild.id);
    if (!session) return;
    // Someone joined her channel: an intro if they've never met her, plus anything she owes them.
    if (newState.channelId === session.channelId && oldState.channelId !== session.channelId && newState.member) session.arrived([newState.member]);
    // Deafening in her call is the only way to be away (away.js): they can't hear her. Undeafening is coming back.
    // Muted people are still listening, and nobody is away because of something they said (owner, 2026-11-11: "I am
    // sick and tired of him always saying I'm going to mark you away. I didn't say I was leaving the call").
    if (newState.channelId === session.channelId && newState.member && !newState.member.user.bot) {
      const wasOff = oldState.channelId === session.channelId && Boolean(oldState.selfDeaf || oldState.serverDeaf);
      const isOff = Boolean(newState.selfDeaf || newState.serverDeaf);
      const who = { id: newState.id, name: newState.member.displayName };
      if (isOff && !wasOff) away.markAway(session.conversation, who, 'deafened');
      else if (!isOff && wasOff) away.markBack(session.conversation, who.id);
    }
    if (oldState.channelId !== session.channelId) return;
    if (newState.channelId !== session.channelId) { presence.left(session.conversation, oldState.id); away.left(session.conversation, oldState.id); }
    const channel = oldState.guild.channels.cache.get(session.channelId);
    if (channel && !channel.members.some((m) => !m.user.bot && !config.ownerAltIds.includes(m.id))) session.destroy(); // the stream account alone is nobody
  });

  return client;
}

function splitMessage(text, max = 2000) {
  const chunks = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max / 2) cut = text.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  chunks.push(text);
  return chunks;
}
