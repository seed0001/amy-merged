"""Glue between the Discord sidecar and the engine.

utterance (PCM) -> transcribe -> wake-word gate -> Conversation.handle -> post transcript + reply
-> synthesize -> play. Speech not addressed to the bot is remembered (searchable history) but
not answered, and by default not learned as fact.
"""

import base64
import json
import re
import time
from collections import deque
from collections.abc import Callable

from app.conversation import Conversation
from voice.wake import WakeResult, WakeWord

STALE_SECONDS = 30
PEER_MAX_EXCHANGES = int(__import__("os").environ.get("HALMINI_PEER_MAX_EXCHANGES", "0"))  # drop speech we couldn't get to in time rather than answer it late


class VoiceService:
    def __init__(self, conversation: Conversation, send: Callable[[dict], None], transcriber,
                 speaker=None, wake: WakeWord | None = None, learn_overheard: bool = False,
                 log: Callable[[str], None] = print, avatar: Callable[[dict], None] | None = None) -> None:
        self.convo = conversation
        self._transport = send
        self.send = self._send
        self.transcriber = transcriber
        self.speaker = speaker
        self.wake = wake
        self.wake_enabled = wake is not None
        self.learn_overheard = learn_overheard
        self.log = log
        self.last_speaker: dict[str, str] = {}
        self.peer_runs: dict[str, int] = {}  # channel -> bot turns in a row since a person spoke  # guild -> who we last answered by voice
        self.last_voice_plan = None
        self.progress_targets = {}  # identified speaker -> their requesting Discord channel/guild
        self.last_voice_guild = None
        self.playing = set()
        self.avatar = avatar  # publishes mouth/feeling packets to the avatar page
        self.avatar_lines: dict[str, deque] = {}  # guild -> packets queued in the sidecar, in order
        self.avatar_speaking: dict[str, dict] = {}  # guild -> the packet Discord is playing now
        self.last_activity = time.time()
        self.life = None  # interfaces/life_actor.LifeActor: her inner life hears what's said
        self.wording=getattr(getattr(getattr(conversation,'social',None),'phrases',None),'history',None)

    def _fresh_spoken(self,text):
        # Repeated wording is fixed by varying it, never by going silent in voice.
        return text

    def _send(self, message):
        """Keep full findings when Discord's per-message text limit is exceeded."""
        content=message.get('content','')
        if message.get('type')!='say' or len(content)<=2000:
            return self._transport(message)
        while content:
            end=2000
            if len(content)>end:
                boundary=max(content.rfind('\n',0,end),content.rfind(' ',0,end))
                if boundary>1000:end=boundary+1
            self._transport({**message,'content':content[:end]})
            content=content[end:]

    def _voice_pcm(self, reply, heard, intent=None):
        directed = getattr(self.speaker, "discord_pcm_with_state", None)
        if not callable(directed):
            return self.speaker.discord_pcm(reply)
        trace = self.convo.state.last_trace or {}
        pcm = directed(reply, self.convo.self_model.snapshot(), context=heard, intent=intent or trace.get("intent"))
        plan = getattr(self.speaker, "last_plan", None)
        if plan is not None:
            self.last_voice_plan = plan.summary()
            self.log("voice expression: " + json.dumps(self.last_voice_plan))
        return pcm

    def _play(self, guild, pcm, text):
        self.send({'type': 'play', 'guild': guild, 'pcm': base64.b64encode(pcm).decode('ascii')})
        self.playing.add(guild)
        if self.avatar is None:
            return
        from interfaces.avatar import speech_feelings, speech_packet
        try:
            snapshot = self.convo.self_model.snapshot()
        except Exception:
            snapshot = {}
        feelings = speech_feelings(snapshot, (self.last_voice_plan or {}).get('emotions') or ())
        self.avatar_lines.setdefault(guild, deque()).append(speech_packet(pcm, text, guild, feelings))

    def _avatar_playback(self, guild, state):
        """The sidecar plays queued lines in order, so each `started` is the next queued packet."""
        if self.avatar is None:
            return
        current = self.avatar_speaking.pop(guild, None)
        if current:
            self.avatar({'type': 'stop', 'conversation': guild, 'id': current['id'],
                         'reason': 'interrupted' if state == 'interrupted' else 'ended'})
        if state == 'started':
            lines = self.avatar_lines.get(guild)
            if lines:
                packet = {**lines.popleft(), 'at': time.time() * 1000}
                self.avatar_speaking[guild] = packet
                self.avatar(packet)

    def _avatar_clear(self, guild):
        self.avatar_lines.pop(guild, None)
        if self.avatar is not None:
            self._avatar_playback(guild, 'interrupted')

    def vocabulary(self) -> list[str]:
        names = [r[0] for r in self.convo.repo.conn.execute(
            "SELECT name FROM entities WHERE proper = 1 ORDER BY id DESC LIMIT 50")]
        return [self.convo.self_name, *names]

    def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind in ('utterance','text','command'):
            self.last_activity=time.time()
        if kind == "utterance":
            self.on_utterance(msg)
        elif kind == "text":
            self.on_text(msg)
        elif kind == "command":
            self.on_command(msg)
        elif kind == "playback":
            if msg.get('state')=='started':self.playing.add(msg['guild'])
            elif msg.get('state') in ('finished','interrupted'):self.playing.discard(msg['guild'])
            self._avatar_playback(msg.get('guild'), msg.get('state'))
            self.log(f"sidecar: {msg}")
            if msg.get("state") == "finished" and self.wake:
                who = self.last_speaker.get(msg["guild"])
                if who:
                    self.wake.answered(who)  # the follow-up window starts when I stop talking
        elif kind == "ready":
            # Answer to the Discord account's name too ("MiniMe"), by text and by voice.
            name = msg["user"]["name"]
            self.convo.add_self_alias(name)
            if self.wake:
                self.wake.add_alias(name)
            self.log(f"sidecar: {msg}")
        elif kind in ("joined", "left", "error"):
            if kind=='left':
                guild=msg.get('guild')
                self.playing.discard(guild)
                self._avatar_clear(guild)
                self.progress_targets={k:v for k,v in self.progress_targets.items() if v.get('guild')!=guild}
                if self.last_voice_guild==guild:
                    self.last_voice_guild=None
            self.log(f"sidecar: {msg}")

    def progress(self, text, target):
        """Narrate only in a conversational pause, never over active bot playback."""
        guild=target.get('guild')
        channel=target.get('channel')
        if not channel or time.time()-self.last_activity<8 or guild in self.playing:
            return False
        fresh=self._fresh_spoken(text)
        if fresh is None:
            self.send({'type':'say','channel':channel,'content':text})
            return True
        text=fresh
        if guild and self.speaker is not None:
            pcm=self._voice_pcm(text,'investigation progress',intent='thinking-progress')
            self._play(guild,pcm,text)
        self.send({'type':'say','channel':channel,'content':text})
        if self.wording:self.wording.delivered(text)
        return True

    def _peer_request(self, text, msg, author):
        aliases = r"(new champ|newchamp|amy|alex|gramps|howard|grandpa|nova)"
        prefix = r"^(?:(?:hey|please|okay|ok)[,\s]+)*(?:(?:can|could|would|will) you\s+|go ahead and\s+)?"
        # Strip only this companion's own wake name, not a target companion's name.
        cleaned = re.sub(r"^" + re.escape(self.convo.self_name) + r"[,\s]+", "", text.strip(), flags=re.I)
        start = re.match(prefix + r"(?:bring(?: in)?|start|wake(?: up)?|invite|call(?: in)?|get)\s+" + aliases + r"(?:\s+(?:in|up|into (?:the )?(?:call|channel)|to (?:the )?call))?[.!?]*$", cleaned, re.I)
        tell = re.match(prefix + r"(?:tell|ask|talk to|say to|message)\s+" + aliases + r"[, :]+(.+)$", cleaned, re.I)
        if not start and not tell:
            return False
        match = start or tell
        self.send({'type': 'peer-request', 'action': 'bring' if start else 'tell', 'name': match.group(1),
                   'content': '' if start else match.group(2), 'guild': msg.get('guild'),
                   'channel': msg.get('textChannel') or msg.get('channel'), 'by': author})
        return True

    def announce(self, text: str) -> None:
        """A finished thought: spoken in the voice channel she's in (and on the avatar) as well as posted,
        so what she says on her own reaches people the same way her replies do."""
        guild = self.last_voice_guild
        if guild and self.speaker is not None and guild not in self.playing:
            self._play(guild, self._voice_pcm(text, 'own thought', intent='thinking-progress'), text)
        if self.last_text_channel:
            self.send({'type': 'say', 'channel': self.last_text_channel, 'content': text})
        if self.wording:
            self.wording.delivered(text)

    def on_utterance(self, msg: dict) -> None:
        if msg.get("textChannel"):
            self.last_text_channel = msg["textChannel"]
        if msg.get("guild"):
            self.last_voice_guild = msg["guild"]  # where her own thoughts get spoken
        if time.time() * 1000 - msg.get("startedAt", time.time() * 1000) > STALE_SECONDS * 1000:
            self.log("dropping stale utterance")
            return
        name = msg["user"]["name"]
        heard = self.transcriber.transcribe(base64.b64decode(msg["pcm"]), self.vocabulary()).text.strip()
        if not heard:
            return
        gate = self.wake.check(heard, name) if self.wake_enabled else WakeResult(True, heard)
        reason = ("follow-up" if gate.by_follow_up else "wake word") if gate.addressed else "not addressed"
        self.log(f"heard {name}: {heard!r} -> {reason}")
        if self.life is not None:
            self.life.heard(msg, heard, gate.addressed)
        if not gate.addressed:
            self.convo.overhear(heard, name, learn=self.learn_overheard, speaker_id=msg["user"].get("id"),
                                is_bot=bool(msg["user"].get("bot")), note_topics=not msg["user"].get("bot"))
            return
        if not msg['user'].get('bot') and self._peer_request(gate.text or heard, msg, msg['user']):
            return
        if gate.wake_only:
            reply = self.convo.social.phrases.pick("wake-only", (
                "Yes?", "I'm listening.", "You have my attention.", "What would you like to talk about?",
                "Hello there. What's on your mind?", "Go ahead.", "I'm here. What is it?",
                "What can I help you with?", "Tell me.", "What are you curious about?",
                "Yes, I'm here.", "What's the story?", "What would you like to ask?",
                "I'm all ears.", "What shall we explore?")) if self.convo.persona == "amy" else "Yes?"
        else:
            reply = self.convo.handle(gate.text, speaker=name, speaker_id=msg["user"].get("id"),
                                      is_bot=bool(msg["user"].get("bot"))).text
            self.progress_targets[self.convo.state.speaker]={'guild':msg['guild'],'channel':None if msg['user'].get('bot') else msg.get('textChannel')}
        if not reply:
            return
        if self.wake:
            self.wake.answered(name)
        self.last_speaker[msg["guild"]] = name
        if msg.get("textChannel") and not msg["user"].get("bot"):
            self.send({"type": "say", "channel": msg["textChannel"],
                       "content": f"\U0001f399️ **{name}:** {gate.text or heard}\n{reply}"})
        if self.speaker is not None:
            spoken=self._fresh_spoken(reply)
            if spoken:
                self._play(msg["guild"], self._voice_pcm(spoken, gate.text or heard), spoken)
                if self.wording:self.wording.delivered(spoken)

    def _peer_turn_allowed(self, msg: dict, is_bot: bool) -> bool:
        """Match the other companions: no default bot-turn cap; honor an explicit configured limit."""
        channel = msg.get("channel")
        if not is_bot:
            self.peer_runs[channel] = 0
            return True
        self.peer_runs[channel] = self.peer_runs.get(channel, 0) + 1
        return PEER_MAX_EXCHANGES <= 0 or self.peer_runs[channel] <= PEER_MAX_EXCHANGES

    def on_text(self, msg: dict) -> None:
        author = msg["author"]
        is_bot = bool(author.get("bot"))
        if is_bot or msg.get("webhookId"):
            return
        content = msg["content"]
        # A listed text channel is listened to, but only an @mention, a reply, a DM or a
        # proper wake-word address is spoken to. Everything else becomes a topic, not a fact.
        if not msg.get("direct", True) or not msg.get("addressed", True):
            if self.wake is not None:
                gate = self.wake.check(content, author["name"])
                if gate.addressed:
                    content = gate.text or content
                elif self.wake_enabled:
                    self.convo.overhear(content, author["name"], speaker_id=author.get("id"),
                                        is_bot=is_bot, note_topics=not is_bot)
                    return
                # !mode always: fall through and answer it
        if not is_bot and self._peer_request(content, msg, author):
            return
        if self.life is not None and not is_bot:
            answer = self.life.text(msg, content)  # an invite to voice is hers to weigh, not the parser's
            if answer:
                self.last_text_channel = msg["channel"]
                self.send({"type": "say", "channel": msg["channel"], "content": answer})
                return
        if not self._peer_turn_allowed(msg, is_bot):
            self.convo.overhear(content, author["name"], speaker_id=author.get("id"), is_bot=True)
            return
        reply = self.convo.handle(content, speaker=author["name"], speaker_id=author.get("id"),
                                  is_bot=is_bot)
        if not reply.text:
            return
        out = {"type": "say", "channel": msg["channel"], "content": reply.text}
        self.last_text_channel = msg["channel"]  # where finished thoughts get posted
        self.progress_targets[self.convo.state.speaker]={'guild':None,'channel':msg['channel']}
        if is_bot and msg.get("messageId"):
            out["replyTo"] = msg["messageId"]
        self.send(out)

    def on_command(self, msg: dict) -> None:
        if msg.get('author', {}).get('bot'):
            return
        if msg['command']=='stop':
            self.playing.discard(msg.get('guild'))
            self._avatar_clear(msg.get('guild'))
            self.progress_targets={k:v for k,v in self.progress_targets.items() if v.get('guild')!=msg.get('guild')}
            return
        if msg['command'] in ('thoughts','investigations','investigate'):
            content= ('Investigate '+msg.get('arg','')) if msg['command']=='investigate' else '!'+msg['command']+(' '+msg['arg'] if msg.get('arg') else '')
            self.on_text({'author':msg['author'],'channel':msg['channel'],'content':content})
            return
        if msg["command"] == "voice":
            self.send({"type": "say", "channel": msg["channel"], "content":
                       "No voice delivery plan yet." if self.last_voice_plan is None else
                       "```json\n" + json.dumps(self.last_voice_plan, indent=2) + "\n```"})
            return
        if msg["command"] == "state":
            snap = self.convo.self_model.snapshot()
            lines = [f"{k}: {v}" for k, v in snap.items() if k not in ("chemicals", "counts")]
            lines += [f"  {k}: {v}" for k, v in snap["chemicals"].items()]
            self.send({"type": "say", "channel": msg["channel"], "content": "```\n" + "\n".join(lines) + "\n```"})
            return
        if msg["command"] == "mode":
            if msg["arg"] in ("always", "wake"):
                self.wake_enabled = msg["arg"] == "wake" and self.wake is not None
            state = "only when someone says my name" if self.wake_enabled else "to everything I hear"
            self.send({"type": "say", "channel": msg["channel"], "content": f"I'm responding {state}."})
        elif msg["command"] == "learn":
            self.learn_overheard = msg["arg"] == "on"
            self.send({"type": "say", "channel": msg["channel"],
                       "content": "I'll learn facts from conversation I overhear." if self.learn_overheard
                       else "I'll only learn from things said to me."})
        else:
            self.send({"type": "say", "channel": msg["channel"],
                       "content": "Commands: !join, !leave, !listen on|off, !stop, !mode wake|always, !learn on|off, !state"})
