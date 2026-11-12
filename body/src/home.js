import { ChannelType } from 'discord.js';
import { activity } from './events.js';
import { remember } from './memory.js';

// Where she lives, learned by looking (ported from Amy-Voice's mapHome): her Discord server, its owner,
// how many people are on it, its channels and what they're for, and its roles. Kept as memories under
// "home", each tagged as something she saw herself, so her curiosity knows what she already knows
// about her home. Refreshed when Discord says something changed (a channel, a member, the server),
// never on a timer.

let snapshot = null; // the short version, for her prompt
let mapping = false, again = false;

export function look(client) {
  const date = new Date().toDateString();
  const lines = [], summary = [];
  for (const guild of client.guilds.cache.values()) {
    const said = (text) => lines.push(`What ${client.user?.username ?? 'she'} saw on the server herself (${date}): ${text}`);
    said(`${guild.name} is a Discord server she lives on.`);
    said(`${guild.name} has about ${guild.memberCount} members.`);
    said(`${guild.name} was created on ${guild.createdAt.toDateString()}.`);
    if (guild.description) said(`${guild.name}'s description: ${guild.description}`);
    const owner = guild.members.cache.get(guild.ownerId);
    if (owner) said(`${owner.displayName} owns ${guild.name}.`);
    const text = [], voice = [];
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildText) { text.push(`#${ch.name}`); if (ch.topic) said(`#${ch.name} on ${guild.name} is described as: ${ch.topic.slice(0, 200)}`); }
      else if (ch.type === ChannelType.GuildVoice) voice.push(ch.name);
    }
    if (text.length) said(`${guild.name}'s text channels: ${text.join(', ')}.`);
    if (voice.length) said(`${guild.name}'s voice channels: ${voice.join(', ')}.`);
    const roles = guild.roles.cache.filter((r) => !r.managed && r.name !== '@everyone').map((r) => r.name).slice(0, 20);
    if (roles.length) said(`${guild.name} has these roles: ${roles.join(', ')}.`);
    const people = guild.members.cache.filter((m) => !m.user.bot).size;
    summary.push(`${guild.name}${owner ? ` (owned by ${owner.displayName})` : ''}: about ${guild.memberCount} members (${people} people she can see), text channels ${text.slice(0, 15).join(', ') || 'none'}; voice channels ${voice.slice(0, 8).join(', ') || 'none'}.`);
  }
  return { lines, summary };
}

// Looks at her server(s) and keeps what she sees. Called on startup and when Discord reports a change.
export async function mapHome(client) {
  if (!client?.isReady?.()) return null;
  if (mapping) { again = true; return null; }
  mapping = true;
  try {
    const { lines, summary } = look(client);
    snapshot = summary;
    const saved = await remember('home', lines);
    if (saved.length) activity('home', { learned: saved.length });
    return saved;
  } catch (err) {
    activity('error', { where: 'home', message: err.message });
    return null;
  } finally {
    mapping = false;
    if (again) { again = false; mapHome(client); }
  }
}

export function homeSection() {
  return snapshot?.length ? `Where you live (what you've seen of it yourself): ${snapshot.join(' ')}` : '';
}
