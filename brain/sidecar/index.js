import { peerConfiguration, findPeer, peerMention, bringPeer } from './peers.js';
// HalMini Discord sidecar.
// Owns the Discord connection: gateway, text commands, joining voice (DAVE E2EE handled by
// @discordjs/voice + @snazzah/davey), per-speaker receive, Opus decode, and playback.
// It does no language work: utterances go to the Python engine as PCM; replies come back as text + PCM.

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import {
  AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
} from "@discordjs/voice";
import prism from "prism-media";
import readline from "node:readline";
import { Readable } from "node:stream";
import { chunkMessage, downsampleForStt, log, send } from "./protocol.js";

const env = process.env;
const peerConfig = peerConfiguration();
const PREFIX = env.HALMINI_PREFIX ?? "!";
const SILENCE_MS = Number(env.HALMINI_SILENCE_MS ?? 900);        // end of utterance
const MIN_UTTERANCE_MS = Number(env.HALMINI_MIN_UTTERANCE_MS ?? 400);
const MAX_UTTERANCE_MS = Number(env.HALMINI_MAX_UTTERANCE_MS ?? 15000);
const BARGE_IN = (env.HALMINI_BARGE_IN ?? "false") === "true";   // talking over the bot stops it (off by default)
const TEXT_CHANNELS = new Set((env.HALMINI_TEXT_CHANNELS ?? "").split(",").filter(Boolean));
// Voice channels she may join on her own (empty = any she can join).
const VOICE_CHANNELS = new Set((env.HALMINI_VOICE_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const BYTES_PER_MS = (48000 * 2 * 2) / 1000;                     // 48 kHz, stereo, 16-bit

const NOTICE =
  "🎙️ I'm in the voice channel and **transcribing speech locally** so I can answer. " +
  "Audio is not stored; transcripts are kept in my memory like typed messages. " +
  `Say \`${PREFIX}leave\` to make me go, or \`${PREFIX}listen off\` to stop listening.`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

/** guildId -> { connection, player, textChannelId, voiceChannelId, listening, capturing:Set, queue:[] } */
const sessions = new Map();

// Play replies one after another. Nothing replaces a reply that is already being spoken, so every
// reply is heard in full; see BARGE_IN above for the opt-in exception.
function playNext(session) {
  const next = session.queue.shift();
  if (!next) return;
  session.player.play(next.resource);
  send({ type: "playback", guild: next.guild, state: "started" });
}

// Playback sends a 20ms Opus packet on a timer; a busy event loop makes it late and the audio choppy.
// Log any stall long enough to be heard, so a glitch can be traced to what the sidecar was doing.
let loopCheck = performance.now();
setInterval(() => {
  const now = performance.now(), late = now - loopCheck - 20;
  loopCheck = now;
  if (late > 40 && [...sessions.values()].some((s) => s.player.state.status === AudioPlayerStatus.Playing))
    log(`event loop stalled ${Math.round(late)}ms during playback`);
}, 20).unref();

function enqueue(session, guild, pcm) {
  const resource = createAudioResource(Readable.from([pcm]), {
    inputType: StreamType.Raw,  // 48 kHz stereo s16le, encoded to Opus by @discordjs/voice
  });
  session.queue.push({ guild, resource });
  if (session.player.state.status === AudioPlayerStatus.Idle) playNext(session);
}

async function displayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return { name: member.displayName, bot: member.user.bot };
  } catch {
    return { name: `user-${userId}`, bot: false };
  }
}

function capture(session, guild, userId) {
  if (session.capturing.has(userId)) return;
  session.capturing.add(userId);
  const opus = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  const maxBytes = MAX_UTTERANCE_MS * BYTES_PER_MS;
  const started = Date.now();
  let finished = false;

  const finish = async () => {
    if (finished) return;
    finished = true;
    session.capturing.delete(userId);
    const durationMs = Math.round(bytes / BYTES_PER_MS);
    if (durationMs < MIN_UTTERANCE_MS || !session.listening) return;
    const who = await displayName(guild, userId);
    const pcm = downsampleForStt(Buffer.concat(chunks));
    send({
      type: "utterance", guild: guild.id, textChannel: session.textChannelId,
      user: { id: userId, name: who.name, bot: who.bot },
      durationMs, startedAt: started, pcm: pcm.toString("base64"),
    });
  };

  opus.pipe(decoder);
  decoder.on("data", (chunk) => {
    const remaining = Math.max(0, maxBytes - bytes);
    const bounded = chunk.subarray(0, remaining);
    chunks.push(bounded);
    bytes += bounded.length;
    if (bytes >= maxBytes) {
      finish();
      opus.destroy();
      decoder.destroy();
    }
  });
  decoder.on("end", finish);
  decoder.on("close", finish);
  opus.on("error", (err) => { log("receive error", err.message); finish(); });
  decoder.on("error", (err) => { log("decode error", err.message); finish(); });
}

async function join(guild, voiceChannel, textChannel) {
  leave(guild.id, false);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  const session = {
    connection, player, textChannelId: textChannel?.id ?? null, voiceChannelId: voiceChannel.id,
    listening: true, capturing: new Set(), queue: [],
  };
  sessions.set(guild.id, session);

  player.on("stateChange", (before, after) => {
    if (after.status !== AudioPlayerStatus.Idle) return;
    if (session.queue.length) return playNext(session);  // keep speaking, uninterrupted
    if (before.status !== AudioPlayerStatus.Idle) {
      send({ type: "playback", guild: guild.id, state: "finished" });
    }
  });
  player.on("error", (err) => log("player error", err.message));

  connection.receiver.speaking.on("start", (userId) => {
    if (userId === client.user.id) return;  // never transcribe our own voice
    if (BARGE_IN && session.player.state.status === AudioPlayerStatus.Playing) {
      session.queue.length = 0;
      session.player.stop(true);
      send({ type: "playback", guild: guild.id, state: "interrupted", by: userId });
    }
    if (session.listening) capture(session, guild, userId);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {  // a brief disconnect while Discord moves us between servers is normal
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      leave(guild.id);
    }
  });

  if (textChannel) await textChannel.send(NOTICE);
  send({ type: "joined", guild: guild.id, voiceChannel: voiceChannel.id, textChannel: session.textChannelId });
  reportRooms();
}

// Who is in which voice channel, for her inner life: which calls her people are in, and who is in hers.
let roomsTimer = null;
function reportRooms() {
  clearTimeout(roomsTimer);
  roomsTimer = setTimeout(() => voiceRooms().catch((err) => log("voice rooms failed", err.message)), 400);
}
async function voiceRooms() {
  const rooms = [];
  for (const guild of client.guilds.cache.values()) {
    const byChannel = new Map();
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.id === client.user.id) continue;
      const member = state.member ?? await guild.members.fetch(state.id).catch(() => null);
      if (!member || member.user.bot) continue;
      if (!byChannel.has(state.channelId)) byChannel.set(state.channelId, []);
      byChannel.get(state.channelId).push({ id: state.id, name: member.displayName });
    }
    const mine = sessions.get(guild.id)?.voiceChannelId;
    for (const [channelId, people] of byChannel) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) continue;
      if (VOICE_CHANNELS.size && !VOICE_CHANNELS.has(channelId) && channelId !== mine) continue;
      rooms.push({ guild_id: guild.id, channel_id: channelId, name: channel.name, joinable: Boolean(channel.joinable),
                   mine: channelId === mine, people });
    }
  }
  const mine = Object.fromEntries([...sessions].map(([guildId, s]) => [guildId, { voice: s.voiceChannelId, text: s.textChannelId }]));
  send({ type: "voice-rooms", rooms, mine });
}
client.on(Events.VoiceStateUpdate, () => reportRooms());

function leave(guildId, announce = true) {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.queue.length = 0;
  session.player.stop(true);
  session.connection.destroy();
  sessions.delete(guildId);
  if (announce) send({ type: "left", guild: guildId });
  reportRooms();
  return true;
}

async function handleCommand(message, command, arg) {
  const guild = message.guild;
  if (['bring','start','wake','invite'].includes(command)) {
    const result = await handlePeerRequest({ action: 'bring', name: arg, guild: guild?.id, channel: message.channel.id,
      by: { id: message.author.id, name: message.member?.displayName ?? message.author.username, bot: message.author.bot } });
    return message.reply(result);
  }
  if (command === "join") {
    const voice = message.member?.voice?.channel;
    if (!guild || !voice) return message.reply("Join a voice channel first, then ask me again.");
    try {
      await join(guild, voice, message.channel);
    } catch (err) {
      log("join failed", err);
      await message.reply("I couldn't connect to that voice channel.");
    }
    return;
  }
  if (command === "leave") {
    return message.reply(guild && leave(guild.id) ? "Left the voice channel." : "I'm not in a voice channel.");
  }
  if (command === "listen") {
    const session = guild && sessions.get(guild.id);
    if (!session) return message.reply("I'm not in a voice channel.");
    session.listening = arg !== "off";
    return message.reply(session.listening ? "Listening." : "Not listening; I'll still speak replies.");
  }
  if (command === "stop") {
    const session = guild && sessions.get(guild.id);
    if (session) {
      session.queue.length = 0;
      session.player.stop(true);
    }
    send({ type: "command", guild: guild?.id ?? null, channel: message.channel.id,
           author: { id: message.author.id, name: message.member?.displayName ?? message.author.username },
           command, arg });
    return;
  }
  // Anything else (e.g. !mode) is the engine's business.
  send({ type: "command", guild: guild?.id ?? null, channel: message.channel.id,
         author: { id: message.author.id, name: message.member?.displayName ?? message.author.username },
         command, arg });
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.webhookId || message.author.id === client.user.id) return;
  const content = message.content.trim();
  if (content.startsWith(PREFIX)) {
    const [command, ...rest] = content.slice(PREFIX.length).trim().split(/\s+/);
    return handleCommand(message, command.toLowerCase(), rest.join(" ").toLowerCase());
  }
  const mentioned = message.mentions.users.has(client.user.id);
  const myNames = [env.HALMINI_NAME ?? "Adam", client.user.username, message.guild?.members.me?.displayName]
    .filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const named = new RegExp(`\\b(?:${myNames.join("|")})\\b`, "i").test(content);
  const replied = message.reference?.messageId
    ? await message.channel.messages.fetch(message.reference.messageId).then(original => original.author.id === client.user.id).catch(() => false)
    : false;
  const addressed = mentioned || replied || named || !message.guild || TEXT_CHANNELS.has(message.channel.id);
  if (!addressed) return;
  const text = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  if (!text) return;
  send({
    type: "text", guild: message.guild?.id ?? null, channel: message.channel.id, messageId: message.id,
    author: { id: message.author.id, name: message.member?.displayName ?? message.author.username, bot: message.author.bot },
    content: text,
    // An @mention, a reply or a DM is explicitly for him. A listed channel is listened to,
    // but its ordinary chatter is not addressed and must not be learned as fact.
    direct: mentioned || replied || !message.guild || TEXT_CHANNELS.has(message.channel.id),
    addressed: mentioned || replied || !message.guild,
  });
});

async function handlePeerRequest(msg) {
  if (msg.by?.bot || !peerConfig.ownerIds.includes(msg.by?.id)) return 'Only the owner can ask me to start or message a companion.';
  const app = findPeer(peerConfig.apps, msg.name);
  if (!app) return 'Unknown companion. Available: ' + peerConfig.apps.map(peer => peer.name).join(', ');
  const channel = msg.channel ? await client.channels.fetch(msg.channel).catch(() => null) : null;
  if (msg.action === 'tell') {
    if (!channel?.isTextBased()) return 'No Discord text channel is available for that message.';
    await channel.send(peerMention(peerConfig.apps, msg.name, msg.content));
    return `Sent your message to ${app.name}.`;
  }
  if (msg.action !== 'bring') return 'Unknown companion request.';
  const guild = msg.guild ? client.guilds.cache.get(msg.guild) : null;
  const ownSession = msg.guild && sessions.get(msg.guild);
  const requester = guild && (guild.members.cache.get(msg.by.id) ?? await guild.members.fetch(msg.by.id).catch(() => null));
  const voiceChannelId = ownSession?.voiceChannelId || requester?.voice?.channelId || null;
  return bringPeer(app, { guildId: msg.guild || null, voiceChannelId, textChannelId: msg.channel || null,
    by: { id: msg.by.id, name: msg.by.name }, startedBy: env.HALMINI_NAME || 'Amy' });
}

async function onEngineMessage(msg) {
  if (msg.type === 'peer-request') {
    let result;
    try { result = await handlePeerRequest(msg); } catch (error) { result = `Could not contact the companion: ${error.message}`; }
    if (msg.channel) {
      const channel = await client.channels.fetch(msg.channel).catch(() => null);
      if (channel?.isTextBased()) await channel.send(result);
    }
    return;
  }
  if (msg.type === "say") {
    const channel = await client.channels.fetch(msg.channel).catch(() => null);
    if (!channel) return log("unknown channel", msg.channel);
    const parts = chunkMessage(msg.content);
    const original = msg.replyTo ? await channel.messages.fetch(msg.replyTo).catch(() => null) : null;
    for (const [i, part] of parts.entries()) {
      if (i === 0 && original) await original.reply(part);  // a reply pings the author (e.g. Amy) so she answers
      else await channel.send(part);
    }
  } else if (msg.type === "play") {
    const session = sessions.get(msg.guild);
    if (!session) return;
    enqueue(session, msg.guild, Buffer.from(msg.pcm, "base64"));
  } else if (msg.type === "stop") {
    const session = sessions.get(msg.guild);
    if (session) {
      session.queue.length = 0;
      session.player.stop(true);
    }
  } else if (msg.type === "leave") {
    leave(msg.guild);
  } else if (msg.type === "join-voice") {
    // She decided to join a call on her own (or said yes to an invite).
    const guild = client.guilds.cache.get(msg.guild);
    const voice = guild?.channels.cache.get(msg.channel);
    if (!guild || !voice) return send({ type: "join-failed", guild: msg.guild ?? null, reason: "unknown channel" });
    const text = msg.textChannel ? await client.channels.fetch(msg.textChannel).catch(() => null) : null;
    try {
      await join(guild, voice, text?.isTextBased() ? text : null);
    } catch (err) {
      log("join failed", err.message);
      send({ type: "join-failed", guild: msg.guild, reason: err.message });
    }
  } else if (msg.type === "dm") {
    // A direct message she decided to send.
    const user = await client.users.fetch(msg.user).catch(() => null);
    if (!user) return send({ type: "dm-failed", user: msg.user, reason: "unknown user" });
    try {
      const channel = await user.createDM();
      for (const part of chunkMessage(msg.content)) await channel.send(part);
      send({ type: "dm-sent", user: msg.user, channel: channel.id });
    } catch (err) {
      send({ type: "dm-failed", user: msg.user, reason: err.message });
    }
  } else if (msg.type === "rooms") {
    reportRooms();
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log("bad line from engine", line.slice(0, 80)); }
  onEngineMessage(msg).catch((err) => log("engine message failed", err));
}).on("close", shutdown);

function shutdown() {
  for (const guildId of [...sessions.keys()]) leave(guildId, false);
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.once(Events.ClientReady, (c) => {
  log(`logged in as ${c.user.tag}`);
  send({ type: "ready", user: { id: c.user.id, name: c.user.username } });
  reportRooms();
});

if (!env.DISCORD_TOKEN) {
  send({ type: "error", message: "DISCORD_TOKEN is not set" });
  process.exit(1);
}
client.login(env.DISCORD_TOKEN);
