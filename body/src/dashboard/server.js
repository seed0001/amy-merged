import { avatarState } from '../avatar-state.js';
import {speechPhones} from '../speech-phonemes.js';
import { avatarPerformance } from '../avatar-performance.js';
import { avatarViewerJoined, avatarViewerLeft, avatarOnline } from '../avatar-cues.js';
import { danceFor, currentDance } from '../dance.js';
import { sleep } from '../sleep.js';
import { feedExpression, expressionState } from '../microexpression.js';
import { activeDiscordSpeech } from '../discord-avatar.js';
import { relayPeerAvatar, peerRequestProblem, activePeerSpeech, peerExpressions } from '../peer-avatar.js';
import { backgroundState, backgroundImage, backgroundShader, backgroundScene, changeBackground, reportBackground } from '../avatar-background.js';
import { moodWeather } from '../mood-weather.js';
import { outfitList,wearOutfit,outfitColors,setOutfitColors } from '../avatar-outfits.js';
import { avatarView } from '../avatar-view.js';
import { bubbleStyle } from '../bubble-style.js';
import { listPrompts, editPrompt, getPrompt } from '../prompts.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, ChannelType } from 'discord.js';
import { config, getSettings, updateSettings } from '../config.js';
import { bus, recentActivity, activity } from '../events.js';
import * as songbook from '../songbook.js';
import { listModels, openRouterModels } from '../llm.js';
import { openCodeModels, doctorConfig } from '../doctor.js';
import { respond } from '../companion.js';
import { setPersona } from '../persona.js';
import * as memory from '../memory.js';
import { scheduleWipe } from '../memory-wipe.js';
import { canRestart, requestRestart } from '../restart.js';
import { sessions, leaveChannel, joinChannel } from '../voice/session.js';
import { sttEngine, transcribeSpeech } from '../voice/stt.js';
import { synthesize } from '../voice/fishAudio.js';
import * as emotion from '../emotion.js';
import * as characters from '../characters.js';
import { activeAvatarPath, avatarLibrary, reportAvatar } from '../avatar-library.js';
import * as music from '../music.js';
import * as video from '../avatarVideo.js';
import * as pressure from '../pressure.js';
import * as conflicts from '../conflicts.js';
import * as looks from '../looks.js';
import * as contextMeter from '../context.js';
import { ttsReady } from '../voice/provider.js';
import { recentResearchDecisions } from '../journal.js';
import { chatgptAuth } from '../chatgpt-auth.js';
import { verifyChatGPTModel } from '../chatgpt-provider.js';
import { xttsAvailability, xttsSamples, loadXTTS } from '../voice/xtts.js';
import { providerRouter, activeReplyModel } from '../provider-router.js';
import { generationDestination, generationDeliveries, generationDeliveryMedia } from '../generation-deliveries.js';
import { liveMind, mindRoutes } from '../cognitive-graph.js';
import * as entityCopies from '../entity-copies.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const startedAt = Date.now();

export function startDashboard(bot) {
  const routes = buildRoutes(bot);

  const server = http.createServer(async (req, res) => {
    try {
      // A peer bot on this computer (Nova, Alex) posting its own avatar events needs no dashboard
      // password: peerRequestProblem() only lets straight-from-this-computer requests through.
      const peerPost = req.method === 'POST' && req.url.split('?')[0] === '/api/avatar/peer' && !peerRequestProblem(req);
      if (!peerPost && !authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Companion dashboard"' });
        return res.end('Password required');
      }
      // Block other websites from driving the API through your browser.
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: 'Cross-origin request blocked' });
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/chatgpt/')) {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, { error: 'Manage ChatGPT sign-in from this computer' });
        // Also reject DNS-rebinding hosts before exposing account details or auth actions.
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname)) return send(res, 403, { error: 'Use a localhost dashboard address to manage ChatGPT' });
      }
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      // Decode so IDs like "voice:123" match even when the browser sends "voice%3A123".
      const pathname = decodeURIComponent(url.pathname);
      for (const [method, pattern, handler] of routes) {
        const match = method === req.method && pathname.match(pattern);
        if (match) {
          // Binary uploads (mic audio) are read by their own handler.
          const binary = req.headers['content-type'] === 'application/octet-stream';
          const body = ['POST', 'PUT'].includes(req.method) && !binary ? await readJson(req) : {};
          const result = await handler({ req, res, url, params: match.groups ?? {}, body });
          if (result !== undefined) send(res, 200, result);
          return;
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.requestId ? { requestId: err.requestId } : {}) });
    }
  });

  server.listen(config.dashboard.port, config.dashboard.host, () => {
    const shown = config.dashboard.host === '0.0.0.0' ? 'localhost' : config.dashboard.host;
    activity('ready', { message: `Dashboard at http://${shown}:${config.dashboard.port}` });
  });
  server.on('error', (err) => activity('error', { where: 'dashboard', message: err.message }));
  // Her cognitive graph (cognitive-graph.js): made once at start so her seed exists and the first
  // structure is recorded; after that it's rebuilt only when the mind view asks.
  liveMind().then((mind) => mind.build()).catch((err) => activity('error', { where: 'mind view', message: `Her cognitive graph couldn't be built: ${err.message}. The mind page will show the reason when it loads.` }));
  return server;
}

function buildRoutes(bot) {
  const r = (method, pattern, handler) => [method, new RegExp(`^${pattern}$`), handler];
  // The Discord client while the bot is online, else null.
  const online = () => (bot.client?.isReady() ? bot.client : null);
  const need = () => {
    const client = online();
    if (!client) throw Object.assign(new Error('The bot is offline. Turn it on first.'), { status: 503 });
    return client;
  };

  return [
    r('GET', '/api/status', () => {
      const client = online();
      return {
        power: { status: bot.status, since: bot.since, error: bot.error, hasToken: Boolean(config.discordToken) },
        bot: client && { tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) },
        ping: client?.ws.ping ?? null,
        uptime: Date.now() - startedAt,
        guilds: client
          ? client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, icon: g.iconURL({ size: 64 }) }))
          : [],
        voice: [...sessions.values()].map((s) => s.summary()),
        look: looks.statusForApi(),
        model: activeReplyModel(),
        providers: providerRouter.status(),
        embedModel: config.ollama.embedModel,
        fishReady: Boolean(config.fish.apiKey),
        fishVoiceId: config.fish.voiceId || null,
        searchReady: Boolean(config.tavily.apiKey),
        stt: sttEngine(),
        stats: memory.stats(),
        context: contextMeter.brief(),
      };
    }),

    r('POST', '/api/power/(?<action>on|off)', async ({ params }) => {
      if (params.action === 'on') {
        if (!config.discordToken) throw Object.assign(new Error('DISCORD_TOKEN is empty in .env'), { status: 400 });
        await bot.start();
      } else {
        await bot.stop();
      }
      return { status: bot.status };
    }),

    // Every voice channel the bot can see, with who's in it and whether it's allowed for /join.
    r('GET', '/api/voice-channels', () => {
      const client = online();
      if (!client) return [];
      const allowed = config.voice.channelIds;
      return [...client.guilds.cache.values()].flatMap((g) =>
        g.channels.cache
          .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .map((c) => ({
            id: c.id,
            name: c.name,
            guildId: g.id,
            guild: g.name,
            members: c.members.filter((m) => !m.user.bot).map((m) => m.displayName),
            allowed: !allowed.length || allowed.includes(c.id),
            joined: sessions.get(g.id)?.channelId === c.id,
          })),
      );
    }),

    r('POST', '/api/voice/join', async ({ body }) => {
      const client = need();
      const channel = client.channels.cache.get(String(body.channelId ?? ''));
      if (!channel?.isVoiceBased()) throw Object.assign(new Error('Unknown voice channel'), { status: 404 });
      if (!ttsReady(config)) throw Object.assign(new Error(config.tts === 'xtts' ? xttsAvailability().reason : 'Fish Audio needs its API key, or select a configured local speech provider'), { status: 400 });
      // Transcripts go to the voice channel's built-in text chat.
      await joinChannel(channel, channel);
      return { ok: true };
    }),

    r('GET', '/api/book/songbook', () => songbook.list({ all: true }).filter((s) => s.status !== 'dropped')),
    r('GET', '/api/book/journal', async () => (await import('../journal.js')).journalEntries()),
    r('GET', '/api/book/events', ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const onInk = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      bus.on('book', onInk);
      req.on('close', () => { clearInterval(keepAlive); bus.off('book', onInk); });
      return undefined;
    }),

    // Live activity feed (Server-Sent Events).
    r('GET', '/api/events', ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const e of recentActivity) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const onContext = (e) => res.write(`data: ${JSON.stringify({ type: 'context', at: e.at, tokens: e.totalTokens, cap: e.capTokens, percent: e.percent, actual: e.actual?.prompt ?? null })}\n\n`);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      bus.on('activity', onEvent);
      bus.on('context', onContext);
      req.on('close', () => {
        clearInterval(keepAlive);
        bus.off('activity', onEvent);
        bus.off('context', onContext);
      });
      return undefined;
    }),

    // Where he was torn (conflicts.js): close calls in his replies and his wants, and the branches he didn't take.
    r('GET', '/api/conflicts', ({ url }) => ({
      items: conflicts.recent({ kind: url.searchParams.get('kind') || null, limit: Number(url.searchParams.get('limit')) || 60 })
        .map((c) => ({ ...c, canBranch: c.kind === 'fork' && conflicts.canBranch(c.id) })),
    })),
    r('POST', '/api/conflicts/(?<id>\\d+)/branch', async ({ params, body }) => {
      try { return await conflicts.branchWithBrain(params.id, body?.fork ?? null); }
      catch (err) { throw Object.assign(err, { status: 400 }); }
    }),
    r('GET', '/api/settings', () => getSettings()),
    r('GET', '/api/entity-copies', () => entityCopies.overview()),
    r('POST', '/api/entity-copies', ({ body }) => entityCopies.createCopy(body.name)),
    r('PUT', '/api/entity-copies/(?<id>[a-z0-9-]+)/keys', ({ params, body }) => entityCopies.setCopyKeys(params.id, body.values)),
    r('POST', '/api/entity-copies/(?<id>[a-z0-9-]+)/start', ({ params }) => entityCopies.startCopy(params.id)),
    r('GET', '/api/prompts', () => listPrompts()),
    r('GET', '/api/prompts/(?<id>[a-z_]+)', ({ params }) => getPrompt(params.id)),
    r('PUT', '/api/prompts', ({ body }) => editPrompt(body.id, body.text ?? '', body.reset === true)),
    r('PUT', '/api/pressure/thought-feedback', ({ body }) => pressure.setThoughtFeedback(body)),
    r('GET', '/api/generation-deliveries', ({ url }) => generationDeliveries(url.searchParams.get('conversation'), url.searchParams.get('after'))),
    r('GET', '/api/generation-deliveries/(?<id>\\d+)/media', ({ params, res }) => {
      const { metadata, bytes } = generationDeliveryMedia(params.id);
      const safeMime = /^(image\/(png|jpeg|webp|gif)|audio\/mpeg)$/.test(metadata.mime || '') ? metadata.mime : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': safeMime, 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
      return undefined;
    }),
    r('PUT', '/api/settings', async ({ body }) => {
      const { persona, botName, ...rest } = body;
      if (rest.brain === 'chatgpt' && (config.brain !== 'chatgpt' || (rest.chatgptModel && rest.chatgptModel !== config.chatgpt.model))) throw Object.assign(new Error('Use the ChatGPT connection’s Use ChatGPT button to verify and activate this model first'), { status: 400 });
      if (rest.ttsProvider === 'xtts') await loadXTTS({ ...config.xtts, reference: rest.xttsReference ?? config.xtts.reference, language: rest.xttsLanguage ?? config.xtts.language, speed: rest.xttsSpeed ?? config.xtts.speed });
      if (botName !== undefined || persona !== undefined) setPersona({ name: botName, persona, reason: 'Edited in dashboard', changedBy: 'dashboard' });
      if (Object.keys(rest).length) {
        const oldBrain = config.brain;
        const before = getSettings();
        updateSettings(rest);
        if (rest.brain && rest.brain !== oldBrain) providerRouter.reset();
        // Only what actually changed, from what to what (the form sends every field, so "Updated <every field>"
        // said nothing about what moved). Voice changes also go in her voice trail with who and why.
        const after = getSettings();
        const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const changed = Object.keys(rest).filter((k) => !same(before[k], after[k]));
        const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, 80);
        if (changed.length) activity('settings', { by: 'dashboard', message: `Changed ${changed.map((k) => `${k}: ${show(before[k])} -> ${show(after[k])}`).join('; ')}`, changed });
        else activity('settings', { by: 'dashboard', message: 'Saved, nothing changed' });
        try { (await import('../voice/library.js')).noteSettings(before, after, { by: 'dashboard', reason: 'changed in the dashboard settings' }); } catch {}
      }
      return getSettings();
    }),
    r('GET', '/api/persona/history', () => memory.personaHistory()),
    r('POST', '/api/persona/history/(?<id>\\d+)/restore', ({ params }) => {
      const version = memory.personaVersion(Number(params.id));
      if (!version) throw Object.assign(new Error('No such version'), { status: 404 });
      setPersona({
        name: version.name,
        persona: version.persona,
        reason: `Restored version from ${new Date(version.created_at).toLocaleString()}`,
        changedBy: 'dashboard',
      });
      return getSettings();
    }),
    r('GET', '/api/models', () => listModels()),
    r('GET', '/api/providers/status', () => providerRouter.status()),
    r('POST', '/api/providers/retry', () => providerRouter.reset()),
    r('GET', '/api/xtts/status', () => ({ ...xttsAvailability(), samples: xttsSamples() })),
    r('GET', '/api/chatgpt/status', () => chatgptAuth.status()),
    r('POST', '/api/chatgpt/login', ({ body }) => chatgptAuth.beginLogin({ accountId: body.accountId, newAccount: body.newAccount === true })),
    r('POST', '/api/chatgpt/cancel', () => { chatgptAuth.cancel(); return chatgptAuth.status(); }),
    r('POST', '/api/chatgpt/account', ({ body }) => {
      if (config.brain === 'chatgpt') throw Object.assign(new Error('Select another brain before switching ChatGPT accounts, then reconnect and activate the desired account'), { status: 409 });
      return chatgptAuth.selectAccount(body.accountId);
    }),
    r('GET', '/api/chatgpt/models', () => chatgptAuth.models()),
    r('POST', '/api/chatgpt/activate', async ({ body }) => {
      const accountId = chatgptAuth.status().account?.id;
      const models = await chatgptAuth.models();
      const model = models.find((m) => m.id === body.model);
      if (!model) throw Object.assign(new Error('Select a model from this ChatGPT account’s catalog'), { status: 400 });
      await verifyChatGPTModel(model.id);
      if (chatgptAuth.status().account?.id !== accountId) throw new Error('ChatGPT account changed during verification; try activation again');
      updateSettings({ chatgptModel: model.id, brain: 'chatgpt' });
      providerRouter.reset();
      activity('settings', { message: 'ChatGPT subscription connected and verified for replies' });
      return { ...chatgptAuth.status(), verified: true, model: model.id };
    }),
    r('POST', '/api/chatgpt/disconnect', async () => {
      if (config.brain === 'chatgpt') updateSettings({ brain: 'ollama' });
      return chatgptAuth.disconnect();
    }),
    r('GET', '/api/openrouter/models', () => openRouterModels()),
    r('GET', '/api/doctors/models', async () => {
      const [list, cfg] = await Promise.all([openCodeModels(), doctorConfig()]);
      return { models: list.models, available: list.available, error: list.error, config: cfg.openCode };
    }),
    r('GET', '/api/channels', () =>
      [...(online()?.guilds.cache.values() ?? [])]
        .flatMap((g) =>
          g.channels.cache
            .filter((c) => c.type === ChannelType.GuildText)
            .map((c) => ({ id: c.id, name: c.name, guild: g.name, position: c.rawPosition })),
        )
        .sort((a, b) => a.guild.localeCompare(b.guild) || a.position - b.position),
    ),

    // ---- Her look: reference sheet, saved outfits and profile picture ----

    r('GET', '/api/looks', () => looks.stateForApi()),
    r('GET', '/api/looks/reference', async ({ res }) => {
      const ref = looks.reference();
      const image = looks.referenceImage();
      if (!ref || !image) return send(res, 404, { error: 'No reference sheet yet' });
      res.writeHead(200, { 'Content-Type': ref.mime || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(image.bytes);
      return undefined;
    }),
    r('GET', '/api/looks/image/(?<id>[\\w-]+)', async ({ res, params }) => {
      const image = looks.lookImage(params.id);
      if (!image) return send(res, 404, { error: 'No such look' });
      res.writeHead(200, { 'Content-Type': image.mime || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(image.bytes);
      return undefined;
    }),
    r('POST', '/api/looks/(?<id>[\\w-]+)/active', ({ params }) => {
      const look = looks.setActive(params.id);
      if (!look) throw Object.assign(new Error('No such look'), { status: 404 });
      return looks.stateForApi();
    }),
    r('POST', '/api/looks/send', async ({ body }) => {
      const client = need();
      const look = looks.findLook(body.id);
      if (!look) throw Object.assign(new Error('No look to send'), { status: 404 });
      const image = looks.lookImage(look.id);
      if (!image) throw Object.assign(new Error('That look image is missing'), { status: 404 });
      const channel = await client.channels.fetch(String(body.channelId ?? '')).catch(() => null);
      if (!channel?.isTextBased?.()) throw Object.assign(new Error('Pick a text channel first'), { status: 400 });
      await channel.send({ files: [new AttachmentBuilder(image.bytes, { name: image.file })] });
      activity('file', { filename: image.file, bytes: image.bytes.length, to: `#${channel.name}` });
      return { sent: true, channel: channel.name, look: look.name };
    }),

    // ---- Context: how much of her context window each reply uses ----

    r('GET', '/api/context', () => contextMeter.stateForApi()),
    r('GET', '/api/context/turns', ({ url }) => contextMeter.recentTurns(url.searchParams.get('limit') ?? 10)),
    r('GET', '/api/context/turn', () => contextMeter.lastTurn()),

    // Her life in one read: who she knows and how they make her feel, her subjects, wants, goals and self (life-view.js).
    r('GET', '/api/life', async () => (await import('../life-view.js')).lifeView()),
    r('GET', '/api/memories/users', () => memory.memoryUsers()),
    r('GET', '/api/profiles/(?<userId>\\w+)', ({ params }) => memory.profiles.read(params.userId)),
    r('DELETE', '/api/profiles/(?<userId>\\w+)', ({ params }) => ({ removed: memory.profiles.clear(params.userId) })),
    r('GET', '/api/memories/(?<userId>\\w+)', ({ params }) => memory.listMemories(params.userId)),
    r('POST', '/api/memories/(?<userId>\\w+)', async ({ params, body }) => {
      if (!body.content?.trim()) throw Object.assign(new Error('content is required'), { status: 400 });
      await memory.addMemoryManually(params.userId, body.content.trim());
      return memory.listMemories(params.userId);
    }),
    r('DELETE', '/api/memories/(?<userId>\\w+)/(?<id>\\d+)', ({ params }) => ({
      removed: memory.forget(params.userId, Number(params.id)),
    })),
    r('DELETE', '/api/memories/(?<userId>\\w+)', ({ params }) => ({ removed: memory.forget(params.userId) })),
    // Restart her (to load new code): she notes where she was, exits, and her launcher brings her back. Nothing is wiped.
    r('POST', '/api/restart', async () => {
      if (!canRestart()) throw Object.assign(new Error("She wasn't started by a launcher that brings her back (start.bat or start-merged.bat), so a restart would just stop her. Fix: close her and start her with the launcher."), { status: 400 });
      const said = await requestRestart({ reason: 'your owner restarted you from the dashboard to load new code', by: { name: 'dashboard' } });
      if (typeof said === 'string' && said.startsWith('Error:')) throw Object.assign(new Error(said.replace(/^Error:\s*/, '')), { status: 409 });
      return { restarting: true };
    }),
    // Wipe everything she remembers: she restarts and the wipe runs before her memory opens (memory-wipe.js).
    r('POST', '/api/memory/wipe', async () => {
      if (!canRestart()) throw Object.assign(new Error("She wasn't started by start.bat, so nothing would bring her back after the wipe. Start her with start.bat first."), { status: 400 });
      scheduleWipe({ by: 'dashboard' });
      await requestRestart({ reason: 'your owner wiped your memory from the dashboard, so you are starting fresh', by: { name: 'dashboard' } });
      return { restarting: true };
    }),

    // A full reset: the memory wipe, plus the owner rules, prompt edits and settings. She comes back as a new install.
    r('POST', '/api/system/fresh', async () => {
      if (!canRestart()) throw Object.assign(new Error("She wasn't started by start.bat, so nothing would bring her back after the reset. Start her with start.bat first."), { status: 400 });
      scheduleWipe({ by: 'dashboard', full: true });
      await requestRestart({ reason: 'your owner reset you to a fresh install from the dashboard: no memory, no owner rules, no settings', by: { name: 'dashboard' } });
      return { restarting: true };
    }),

    r('GET', '/api/conversations', () =>
      memory.conversations().map((c) => ({ ...c, label: conversationLabel(online(), c.conversation) })),
    ),
    r('GET', '/api/conversations/(?<id>[\\w:]+)', ({ params }) => memory.recentMessages(params.id, 200)),
    r('DELETE', '/api/conversations/(?<id>[\\w:]+)', ({ params }) => {
      memory.clearConversation(params.id);
      return { ok: true };
    }),

    r('POST', '/api/voice/(?<guildId>\\d+)/leave', ({ params }) => ({ left: leaveChannel(params.guildId) })),
    r('POST', '/api/voice/(?<guildId>\\d+)/say', ({ params, body }) => {
      const session = sessions.get(params.guildId);
      if (!session) throw Object.assign(new Error('Not in voice in that server'), { status: 404 });
      if (!body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      session.say(body.text.trim());
      activity('replied', { conversation: session.conversation, voice: true, text: body.text.trim(), manual: true });
      return { ok: true };
    }),

    // Claude Code finished work Owner gave it on her: she tells him herself (work-done.js). This computer only.
    r('POST', '/api/work-done', async ({ req, body }) => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw Object.assign(new Error('Work notes come from this computer only'), { status: 403 });
      const { noteFrom, workDone } = await import('../work-done.js');
      return workDone(noteFrom(body));
    }),

    // Talk to the companion straight from the dashboard (uses the same brain and memory).
    // Pictures she makes (generate_image, look) come back with the reply; other files are
    // returned as downloads.
    r('POST', '/api/chat', async ({ body }) => {
      if (!body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      const images = [];
      const files = [];
      const reply = await respond({
        conversation: 'dashboard',
        speaker: { id: 'dashboard', name: body.name?.trim() || 'Dashboard' },
        text: body.text.trim(),
        discord: {
          client: online(),
          ...generationDestination('dashboard', config.botName),
          sendHere: (file) =>
            files.push({
              name: file.name,
              base64: Buffer.from(file.attachment).toString('base64'),
              mime: mimeForName(file.name),
            }),
        },
      });
      return { reply, images, files };
    }),

    // ---- Avatar studio (/avatar.html) ----

    // The cast: everyone who can appear in the studio, with their name, persona, voice and mood.
    r('GET','/api/avatar/outfits',()=>outfitList()),
    r('PUT','/api/avatar/outfits',({body})=>wearOutfit(body.id)),
    r('GET','/api/avatar/outfit-colors',()=>outfitColors()),
    r('PUT','/api/avatar/outfit-colors',({body})=>setOutfitColors(body.id,{fabric:body.fabric,sheen:body.sheen})),
    r('GET', '/api/avatar/library', () => avatarLibrary()),
    r('POST', '/api/avatar/library/report', ({ body }) => reportAvatar(body)),
    r('GET', '/api/avatar/characters', () =>
      characters.list().map(({ modelPath, ...c }) => ({ ...c, appearance:avatarState.get(c.id), feelings: emotion.current(characters.emotionKey(c.id)) })),
    ),
    r('PUT', '/api/avatar/characters/(?<id>[\\w-]+)', ({ params, body }) => {
      const updated = characters.update(params.id, body);
      if (!updated) throw Object.assign(new Error('No such character'), { status: 404 });
      return updated;
    }),

    r('GET', '/api/avatar/model(?:/(?<id>[\\w-]+))?', async ({ res, params }) => {
      const c = characters.get(params.id ?? 'main');
      if (!c) return send(res, 404, { error: 'No such character' });
      try {
        const data = await readFile(c.main ? activeAvatarPath() : c.modelPath);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch {
        send(res, 404, { error: `No model for ${c.name} at ${c.modelPath}` });
      }
    }),

    // Songs from the music library, for the studio's player. Only plain file names in data/music.
    // A song's beats, loudness and vocal line, for her avatar to dance and sing along (dance.js).
    r('GET', '/api/dance/(?<file>[^/]+)', ({ params }) => danceFor(params.file)),
    r('GET', '/api/music/(?<file>[^/]+)', async ({ res, params }) => {
      const file = decodeURIComponent(params.file);
      if (file.includes('..') || /[\\/]/.test(file) || !music.tracks().some((t) => t.file === file)) return send(res, 404, { error: 'No such song' });
      const type = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
      res.writeHead(200, { 'Content-Type': type[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream' });
      res.end(await readFile(path.join(music.MUSIC_DIR, file)));
    }),
    r('GET', '/api/music', () => ({ tracks: music.tracks(), playlists: music.playlists() })),
    r('GET', '/api/pressure', () => pressure.snapshot()),
    // Her mind view: the cognitive graph, node inspector, change history, live edits with undo, and events mapped to nodes.
    ...mindRoutes(liveMind),
    r('GET', '/api/research', () => ({ selection: pressure.researchSelection(), decisions: recentResearchDecisions(20) })),

    // Video replies: the recorder page's event stream, its "recording started", and the clip itself.
    r('GET', '/api/avatar/recorder', ({ req, res }) => {
      video.attachRecorder(req, res);
      return undefined;
    }),
    // Records a test line through the recorder page (the hidden one if none is open) and returns the clip.
    r('POST', '/api/avatar/recorder/test', async ({ res, body }) => {
      const clip = await video.requestClip(String(body.text || "Hey, it's me. This is a test of my video replies."));
      if (!clip) throw Object.assign(new Error('No clip came back; see the activity feed for why'), { status: 502 });
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': clip.length });
      res.end(clip);
      return undefined;
    }),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)/ack', ({ params }) => ({ ok: video.ack(params.id) })),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)/failed', ({ params, body }) => ({ ok: video.finish(params.id, null, String(body.reason ?? 'the page reported a failure').slice(0, 200)) })),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)', async ({ req, params }) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > video.MAX_CLIP_BYTES + 1) break; // finish() turns oversized clips into text-only
        chunks.push(chunk);
      }
      return { ok: video.finish(params.id, Buffer.concat(chunks)) };
    }),

    r('GET', '/api/avatar/appearance(?:/(?<id>[\\w-]+))?', ({params}) => avatarState.get(params.id || 'main')),
    r('PUT', '/api/avatar/appearance(?:/(?<id>[\\w-]+))?', ({params,body}) => {
      const id=params.id || 'main';if(!characters.get(id))throw new Error('No such avatar character.');
      return avatarState.set(id,body,body.reset===true);
    }),
    // The Studio page's small motions (blinks, glances), batched: relayed to every live listener (her mind page).
    r('POST', '/api/avatar/beat', ({ body }) => {
      const beats = Array.isArray(body?.beats) ? body.beats.filter((b) => b && typeof b.kind === 'string').slice(0, 20).map((b) => ({ kind: String(b.kind).slice(0, 20), character: String(b.character ?? 'main').slice(0, 40), n: Math.max(1, Math.min(50, Number(b.n) || 1)) })) : [];
      if (beats.length) bus.emit('avatar-beat', { beats, at: Date.now() });
      return { ok: true, beats: beats.length };
    }),
    // Peer avatars (src/peer-avatar.js, knowledge/systems/peer-avatars.md): another companion bot on
    // this computer moves ITS OWN avatar on her stage.
    //   POST /api/avatar/peer  { character: '<cast id with peer: true>', event }
    //   event: { type:'discord-speech', speech:{type:'start', id, text, at?, audio?(base64 Ogg Opus)|articulation?|frames?, frameMs?, durationMs?} }
    //          { type:'discord-speech', speech:{type:'stop', id, reason?} }
    //          { type:'expression', feelings:{...} }  { type:'play', name, ms? }  { type:'cue', kind, strength? }
    // The character is forced to the posted one, audio is never relayed (the peer's voice is already in
    // the call), and it goes out on /api/avatar/live like her own events. Local callers only.
    r('POST', '/api/avatar/peer', async ({ req, body }) => {
      const problem = peerRequestProblem(req);
      if (problem) throw Object.assign(new Error(problem), { status: 403 });
      return relayPeerAvatar(body);
    }),
    r('GET', '/api/avatar/live', ({req,res}) => {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
      const send=(type,data)=>res.write(`data: ${JSON.stringify({type,...data})}\n\n`);
      const power=(data)=>send('power',data);bus.on('avatar-power',power);
      const resting=(data)=>send('sleep',{sleep:data});bus.on('avatar-sleep',resting);
      power({online:avatarOnline()});
      resting(sleep.status());
      send('background',{background:backgroundState()});
      send('view',{view:avatarView.get()});
      send('bubble-style',bubbleStyle.get());
      const bubbleSize=(data)=>send('bubble-style',data);bus.on('avatar-bubble-style',bubbleSize);
      send('outfit-colors',{palettes:outfitColors()});
      send('performance',{performance:avatarPerformance.state()});
      send('expression',{expression:feedExprState()});
      for(const c of characters.list())send('appearance',{appearance:avatarState.get(c.id)});
      for(const packet of activeDiscordSpeech())send('discord-speech',{speech:packet});
      for(const packet of activePeerSpeech())send('discord-speech',{speech:packet}); // a peer mid-sentence (peer-avatar.js)
      for(const feel of peerExpressions())send('expression',feel);
      const appearance=(data)=>send('appearance',{appearance:data});
      const speech=(data)=>send('discord-speech',{speech:data});
      const expression=(data)=>send('expression',expressionPayload(data));
      bus.on('avatar-appearance',appearance);bus.on('discord-avatar',speech);
      bus.on('avatar-expression',expression);
      const background=(data)=>send('background',{background:data});bus.on('avatar-background',background);
      const view=(data)=>send('view',{view:data});bus.on('avatar-view',view);
      const beat=(data)=>send('beat',data);bus.on('avatar-beat',beat); // her blinks and glances, reported by the Studio page (POST /api/avatar/beat)
      const colors=(data)=>send('outfit-colors',{palettes:data});bus.on('avatar-outfit-colors',colors);
      const performance=(data)=>send('performance',{performance:data});bus.on('avatar-performance',performance);
      const cue=(data)=>send('cue',data);bus.on('avatar-cue',cue);
      const toolBubble=(data)=>send('tool',data);bus.on('avatar-tool',toolBubble);
      const play=(data)=>send('play',data);bus.on('avatar-play',play);
      // Dancing to her music (dance.js): what's playing now, then every change.
      send('dance',currentDance());
      const dancing=(data)=>send('dance',data);bus.on('avatar-dance',dancing);
      // Her fidgets for the next stretch, planned each pressure tick (body.js); the page plays them on time.
      const fidgets=(data)=>send('fidgets',data);bus.on('avatar-fidgets',fidgets);
      res.once('close',()=>bus.off('avatar-power',power));
      avatarViewerJoined();
      // Her mood as weather for her scenes (mood-weather.js): now, on every change of feeling, and with the 15-second read.
      const weather=()=>{try{const f=feedExprState();send('mood',moodWeather(f?.feelings??f??{},pressure.snapshot().buckets));}catch{}};
      weather();
      const moodChange=()=>weather();bus.on('avatar-expression',moodChange);
      // A phrase of her instrument landing (instrument.js): her weather as it is now that it has, plus how hard it hit.
      const phrase=(p)=>{try{const f=feedExprState();send('phrase',{...moodWeather(f?.feelings??f??{},pressure.snapshot().buckets),...p});}catch{}};bus.on('instrument-phrase',phrase);
      res.once('close',()=>bus.off('instrument-phrase',phrase));
      // Her mood drifts between conversations too, so an open page gets a fresh read every 15 seconds.
      const mood=setInterval(()=>{send('expression',{expression:feedExprState()});weather();},15000);
      res.once('close',()=>{clearInterval(mood);bus.off('avatar-expression',moodChange);bus.off('avatar-cue',cue);bus.off('avatar-tool',toolBubble);bus.off('avatar-bubble-style',bubbleSize);bus.off('avatar-play',play);bus.off('avatar-dance',dancing);bus.off('avatar-fidgets',fidgets);bus.off('avatar-sleep',resting);avatarViewerLeft();});
      const keep=setInterval(()=>res.write(': ping\n\n'),20000);
      res.once('close',()=>{clearInterval(keep);bus.off('avatar-appearance',appearance);bus.off('discord-avatar',speech);bus.off('avatar-expression',expression);bus.off('avatar-background',background);bus.off('avatar-view',view);bus.off('avatar-beat',beat);bus.off('avatar-outfit-colors',colors);bus.off('avatar-performance',performance);});
      return undefined;
    }),
    r('POST','/api/avatar/phones',async({body})=>({phones:await speechPhones(body.text)})),
    r('GET','/api/avatar/performance',()=>avatarPerformance.command({action:'get'})),
    r('PUT','/api/avatar/performance',({body})=>avatarPerformance.command(body)),
    r('GET','/api/avatar/view',()=>avatarView.get()),
    r('PUT','/api/avatar/view',({body})=>avatarView.set(body,body.reset===true)),
    r('GET','/api/avatar/background',()=>backgroundState()),
    r('PUT','/api/avatar/background',({body})=>changeBackground(body)),
    r('POST','/api/avatar/background/report',({body})=>reportBackground(body)),
    r('GET','/api/avatar/background/image/(?<id>[a-f0-9-]{36})',({res,params})=>{
      let image;try{image=backgroundImage(params.id);}catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('No such background image');return;}
      const {bytes,mime}=image;res.writeHead(200,{'Content-Type':mime,'Cache-Control':'private, max-age=31536000','X-Content-Type-Options':'nosniff'});res.end(bytes);
    }),
    r('GET','/api/avatar/background/shader/(?<id>[a-f0-9-]{36})',({res,params})=>{
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'private, max-age=31536000','X-Content-Type-Options':'nosniff'});res.end(backgroundShader(params.id));
    }),
    r('GET','/api/avatar/background/scene/(?<id>[a-f0-9-]{36})',({res,params})=>{
      let json;try{json=backgroundScene(params.id);}catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('No such background scene');return;}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, max-age=31536000','X-Content-Type-Options':'nosniff'});res.end(json);
    }),
    r('GET', '/api/avatar/status', () => ({
      ttsProvider: config.tts,
      ttsReady: ttsReady(config),
      botName: config.botName,
      model: activeReplyModel(),
      fishReady: Boolean(config.fish.apiKey),
      fishVoiceId: config.fish.voiceId || null,
      stt: sttEngine(),
    })),

    // A character's current feelings (?character=id, default the main one).
    // POST { character, feelings: { name: 0..1 } } nudges them, { character, reset: true } calms them.
    r('GET', '/api/avatar/emotion', ({ url }) => ({
      feelings: emotion.current(characters.emotionKey(url.searchParams.get('character') || 'main')),
      emotions: emotion.EMOTIONS,
      gestures: emotion.GESTURES,
    })),
    r('POST', '/api/avatar/emotion', ({ body }) => {
      const key = characters.emotionKey(characters.get(body.character)?.id ?? 'main');
      if (body.reset) return { feelings: emotion.reset(key) };
      const feelings = {};
      for (const [name, v] of Object.entries(body.feelings ?? {})) {
        if (emotion.EMOTIONS[name]) feelings[name] = Math.max(0, Math.min(1, Number(v) || 0));
      }
      return { feelings: emotion.nudge(key, feelings) };
    }),

    // Push-to-talk: raw 48kHz mono 16-bit PCM in, transcript out.
    r('POST', '/api/avatar/listen', async ({ req }) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12e6) throw Object.assign(new Error('Recording too long'), { status: 413 });
        chunks.push(chunk);
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 9600) return { text: '' }; // under 0.1s
      return { text: (await transcribeSpeech(pcm)) || '' };
    }),

    // Streams the reply as NDJSON, one line per sentence with its Fish Audio clip (base64 mp3),
    // so the avatar starts talking while the rest is still being generated.
    r('POST', '/api/avatar/chat', async ({ req, res, body }) => {
      // auto: banter mode. Nobody spoke; body.character takes the next turn in the cast's conversation.
      const auto = Boolean(body.auto);
      if (!auto && !body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      if (auto && !characters.get(body.character)) throw Object.assign(new Error('Unknown character'), { status: 400 });
      // A peer (Nova, Alex) is another bot's avatar: that bot answers for itself in Discord and moves its
      // avatar through /api/avatar/peer. Her brain never writes or voices a peer's lines.
      const asked = characters.get(auto ? body.character : characters.addressee(String(body.text ?? ''), body.character));
      if (asked?.peer) throw Object.assign(new Error(`${asked.name} is another companion's avatar (her own bot), so ${config.botName} can't speak as ${asked.name} here. Why: a peer answers for itself in Discord and moves its own avatar on this stage. Fix: talk to ${asked.name} in the Discord call or chat, or pick ${config.botName} or another cast member here.`), { status: 400 });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      let closed = false;
      res.on('close', () => (closed = true));
      const write = (obj) => !closed && res.write(JSON.stringify(obj) + '\n');

      const text = auto ? '' : body.text.trim();
      const person = body.name?.trim() || 'Dashboard';

      // Whoever is named answers ("Leo, ..."); otherwise whoever the person was talking to.
      const character = characters.get(auto ? body.character : characters.addressee(text, body.character));
      const key = characters.emotionKey(character.id);
      const others = characters.list().filter((c) => c.id !== character.id).map((c) => c.name);
      write({ type: 'speaker', character: character.id });

      // Only the main character may fall back to Fish's default voice; without a voice of their
      // own, the others would get a random voice for every sentence, so they stay silent instead.
      const voiceId = character.voiceId || (character.main ? undefined : null);
      const canSpeak = () => body.speak !== false && ttsReady(config) && (config.tts !== 'fish' || voiceId !== null);
      if (body.speak !== false && config.tts === 'fish' && voiceId === null) {
        write({ type: 'notice', message: `${character.name} has no voice yet. Set a Fish voice ID for them in Settings.` });
      }

      // In banter, the cue says whose line to answer; nobody's words are invented for the person.
      let cue;
      if (auto) {
        const last = memory.recentMessages('avatar', 1)[0];
        const lastName = last ? (last.role === 'assistant' ? last.name ?? config.botName : last.name) : null;
        cue =
          lastName && lastName !== character.name
            ? `${person} is listening quietly. It's your turn: reply to what ${lastName} just said, in character, talking with ${others.join(' and ')}. ` +
              `Keep it to one to three sentences. Don't repeat yourself or restate what was said; push the conversation forward, and now and then change the subject.`
            : `${person} is listening quietly. Start a conversation with ${others.join(' and ')} about anything that interests you, in character, in one to three sentences.`;
      }

      // Their first reaction, shown on their face while they think.
      const first = auto ? null : emotion.guessFromUser(text);
      write({ type: 'state', feelings: first ? emotion.nudge(key, first) : emotion.current(key) });

      // Each sentence: strip its feeling tag, fold it into her state, then fetch the clip.
      // Clips are fetched in parallel but sent in sentence order.
      let queue = Promise.resolve();
      const onSentence = (raw) => {
        const parsed = emotion.parseSentence(raw);
        const named = parsed.feelings ?? (parsed.text && emotion.guessFromReply(parsed.text));
        const feelings = parsed.feelings
          ? emotion.feel(key, named)
          : named ? emotion.nudge(key, named) : emotion.current(key);
        const clip = canSpeak() && !closed && parsed.text
          ? synthesize(parsed.text, { format: 'mp3', voiceId }).catch((err) => {
              write({ type: 'error', message: err.message });
              return null;
            })
          : null;
        const phonesJob=parsed.text?speechPhones(parsed.text).catch(()=>[]):Promise.resolve([]);
        queue = queue.then(async () => {
          const [audio,phones] = await Promise.all([clip,phonesJob]);
          write({ type: 'sentence', text: parsed.text, audio: audio ? audio.toString('base64') : null, phones, feelings, gestures: parsed.gestures });
        });
      };

      try {
        const reply = await respond({
          conversation: 'avatar',
          speaker: { id: 'dashboard', name: person },
          text,
          voice: true,
          onSentence,
          character,
          cue,
          // The studio is "here": files and pictures appear in the chat. With the bot online,
          // she can also send files to Discord channels or DMs, since the dashboard is the owner.
          discord: {
            client: online(),
            ...generationDestination('avatar', character.name),
            studioMusic: (command) => write({ type: 'music', ...command }),
            sendHere: (file) => write({ type: 'file', name: file.name, base64: Buffer.from(file.attachment).toString('base64') }),
          },
          systemExtra: [
            others.length &&
              `${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} here too, in the same conversation. Their lines appear as "[Name]: ...". ` +
                `You can talk to them, react to them or tease them, but speak only as yourself, ${character.name}: never write their lines.`,
            emotion.emotionPrompt(key),
          ].filter(Boolean).join('\n\n'),
        });
        await queue;
        write({ type: 'done', reply });
      } catch (err) {
        await queue;
        write({ type: 'error', message: err.message });
      }
      res.end();
      return undefined;
    }),
  ];
}

// The microexpression event's shape for live avatar viewers: the per-character feeling blend.
const expressionPayload = (data) => ({
  character: data?.character ?? 'main',
  feelings: data?.feelings ?? expressionState(data?.character ?? 'main'),
  at: data?.at ?? Date.now(),
});
// Initial expression read for a fresh viewer.
const feedExprState = (character = 'main') => expressionState(character);

function conversationLabel(client, id) {
  if (id === 'dashboard') return 'Dashboard playground';
  if (id === 'avatar') return 'Avatar studio';
  const [kind, ref] = id.split(':');
  if (kind === 'voice') return `🔊 ${client?.guilds.cache.get(ref)?.name ?? ref}`;
  if (kind === 'phone') return `📱 Phone app · ${client?.users?.cache.get(ref)?.displayName ?? 'owner'}`; // phone-link.js
  const channel = client?.channels.cache.get(ref);
  if (!channel) return `# ${ref}`;
  if (channel.type === ChannelType.DM) return `DM · ${channel.recipient?.displayName ?? 'user'}`;
  return `#${channel.name} · ${channel.guild?.name ?? ''}`;
}

function authorized(req) {
  const password = config.dashboard.password;
  // No password: only serve local visits, never ones relayed by a Cloudflare tunnel.
  if (!password) return !req.headers['cf-connecting-ip'];
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};
const mimeForName = (name) => MIME_BY_EXT[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream';

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
