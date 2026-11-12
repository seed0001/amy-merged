import { handoffOnly } from './peers.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT } from './config.js';
import { isGroupStop, keepGoingMinutes } from './peer-clock.js';

export const BUDGET_FILE = process.env.CONVERSATION_BUDGET_FILE || path.join(ROOT, '..', '.companions-conversations.db');
const normalized = (text) => String(text ?? '').toLowerCase().replace(/<@!?\d+>/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
const tokens = (text) => new Set(normalized(text).split(' ').filter((w) => w.length>2 && !['the','and','that','this','with','you','your','have','what','does','would'].includes(w)));
const hash = (text) => createHash('sha256').update(normalized(text)).digest('hex');
const mentionsName = (text,name) => name && new RegExp('\\b'+String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(text);

export function replyReason(text, recent = [], names = []) {
  let clean = String(text ?? '').replace(/<@!?\d+>/g,' ');
  for (const name of names.filter(Boolean)) clean=clean.replace(new RegExp('\\b'+String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','ig'),' ');
  const history = recent.map((line) => {
    let prior=String(line).replace(/<@!?\d+>/g,' ');
    for (const name of names.filter(Boolean)) prior=prior.replace(new RegExp('\\b'+String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','ig'),' ');
    return prior;
  });
  const n=normalized(clean);
  if (!n || /^(?:(?:yes|yeah|yep|okay|ok|sure|right|exactly|agreed|indeed|thanks|thank you|you re welcome|no problem|sounds good|good point|well said|absolutely|i agree|bye|goodbye|see you|take care|good night)[ ,.!]*)+$/i.test(n)) return null;
  if (/^(?:thanks|thank you|bye|goodbye|take care|good night)\b/i.test(n) && !/[?]/.test(clean)) return null;
  const meaningful=tokens(clean);
  const repeated=history.some((line) => {
    if (normalized(line)===normalized(clean)) return true;
    const old=tokens(line);const intersection=[...meaningful].filter((w) => old.has(w)).length;
    return meaningful.size>2 && intersection/Math.max(1,new Set([...meaningful,...old]).size)>.78;
  });
  if (repeated) return null;
  if (clean.includes('?') || /^\s*(?:what|why|how|which|where|when|can you|could you|do you|does|is|are|will you)\b/i.test(clean)) return 'question';
  if (/\b(?:still need|not finished|next step|unfinished|please (?:check|compare|explain|research|write|test)|need to (?:check|test|finish|compare)|working on)\b/i.test(clean)) return 'unfinished-task';
  const known=tokens(history.join(' '));
  const novel=[...meaningful].filter((w) => !known.has(w)).length;
  if (meaningful.size>=4 && novel>=Math.max(2,Math.ceil(meaningful.size*.25)) && /\b(?:found|result|because|however|instead|shows|tested|measured|fails?|works?|evidence|suggest|difference|new|could|should|therefore)\b/i.test(clean)) return 'new-point';
  return null;
}

export function humanControl(text, owner = false) {
  const clean=String(text ?? '').trim();
  // Commands must be directed to the room, not quoted, hypothetical or negated.
  if (/["“”]/.test(clean) || /\b(?:she|he|they) (?:said|told)|\bif\b/i.test(clean)) return null;
  if (/^\s*(?:(?:okay|ok|please|guys|everyone|bots)[,\s]+)*wrap (?:it|this) up[.!\s]*$/i.test(clean)) return 'wrap';
  if (isGroupStop(clean)) return 'stop';
  if (owner && keepGoingMinutes(clean)) return 'extend';
  return null;
}

export function createConversationBudget(db, { now = Date.now, softTurns = 6, leaseMs = 120000 } = {}) {
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS conversation_exchanges(conversation TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_events(conversation TEXT NOT NULL,event_id TEXT NOT NULL,speaker TEXT NOT NULL,fingerprint TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(conversation,event_id));
    CREATE INDEX IF NOT EXISTS conversation_event_content ON conversation_events(conversation,speaker,fingerprint,at);
    CREATE TABLE IF NOT EXISTS conversation_bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,aliases TEXT NOT NULL,at INTEGER NOT NULL);`);
  const read=(conversation) => { const row=db.prepare('SELECT payload FROM conversation_exchanges WHERE conversation=?').get(conversation);return row?JSON.parse(row.payload):null; };
  const save=(c,s) => db.prepare('INSERT INTO conversation_exchanges VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET payload=excluded.payload').run(c,JSON.stringify(s));
  const atomic=(fn) => { db.exec('BEGIN IMMEDIATE');try {const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;} };
  const fresh=() => ({id:randomUUID(),epoch:0,turns:0,participants:{},addressed:[],mentions:{},lastHuman:null,recent:[],mode:'open',extendedUntil:0,pending:null,lastAt:now(),cancelVersion:0,answered:[]});
  function register(me) {
    if (!me?.id) throw new Error('A bot identity is required for a shared turn.');
    db.prepare('INSERT INTO conversation_bots VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases,at=excluded.at').run(me.id,me.name || me.id,JSON.stringify(me.aliases ?? []),now());
  }
  function record(conversation, { eventId, speaker, peer, text, owner=false, noReply=false, replyTo=null, candidates=[] }) {
      let s=read(conversation) || fresh();
      const fingerprint=hash(text);
      const prior=db.prepare('SELECT payload FROM conversation_events WHERE conversation=? AND (event_id=? OR (speaker=? AND fingerprint=? AND at>=?)) ORDER BY at DESC LIMIT 1').get(conversation,String(eventId || ''),speaker.id,fingerprint,now()-10000);
      if (prior) return { ...JSON.parse(prior.payload), state:s };
      if (peer && normalized(text)) {
        const sent=db.prepare("SELECT payload FROM conversation_events WHERE conversation=? AND speaker=? AND event_id LIKE 'reply:%' AND at>=? ORDER BY at DESC LIMIT 4").all(conversation,speaker.id,now()-30000);
        const whole=sent.map((row)=>JSON.parse(row.payload)).find((event)=>normalized(event.text).includes(normalized(text)));
        if (whole) return {...whole,state:s}; // Discord chunks/audio fragments belong to the same bot turn.
      }
      const control=!peer ? humanControl(text,owner) : null;
      if (!peer) {
        if (['stopped','closed'].includes(s.mode) && !control) s=fresh();
        if (!(control==='extend' && s.mode==='open' && s.pending)) {s.epoch++;s.pending=null;}
        s.turns=0;if(control!=='extend')s.recent=[];
        s.lastHuman={id:speaker.id,text,at:now()};
        if (control==='stop') {s.mode='stopped';s.extendedUntil=0;s.cancelVersion=(s.cancelVersion||0)+1;}
        else if (control==='wrap') {s.mode='closed';s.extendedUntil=0;s.cancelVersion=(s.cancelVersion||0)+1;}
        else {s.mode='open';s.extendedUntil=control==='extend'?now()+(keepGoingMinutes(text)||5)*60000:0;}
      }
      const bots=db.prepare('SELECT * FROM conversation_bots').all().map((b) => ({...b,aliases:JSON.parse(b.aliases)}));
      const targets=bots.filter((bot) => bot.id!==speaker.id && (String(text).includes('<@'+bot.id+'>') || String(text).includes('<@!'+bot.id+'>') || [bot.name,...bot.aliases].some((n) => mentionsName(text,n)))).map((b) => b.id);
      const names=bots.flatMap((bot) => [bot.name,...bot.aliases]);
      const reason=peer && !noReply ? replyReason(text,s.recent,names) : control==='extend' ? 'extended-discussion' : null;
      const event={eventId:String(eventId || randomUUID()),speaker:speaker.id,peer,text,control,targets,reason,noReply,replyTo,candidates,exchangeId:s.id,epoch:s.epoch,cancelVersion:s.cancelVersion||0};
      s.participants[speaker.id]={name:speaker.name,bot:peer};
      for (const target of targets) s.mentions[target]=(s.mentions[target]||0)+1;
      s.addressed.push({from:speaker.id,to:targets,at:now()});s.addressed=s.addressed.slice(-40);
      if (peer) {s.turns++;s.recent=[...s.recent,text].slice(-8);}
      s.lastAt=now();s.lastEvent=event;
      db.prepare('INSERT INTO conversation_events VALUES(?,?,?,?,?,?)').run(conversation,event.eventId,speaker.id,fingerprint,now(),JSON.stringify(event));
      save(conversation,s);return {...event,state:s};
  }
  const observe=(conversation,input) => atomic(() => record(conversation,input));
  function claim(conversation,event,me,{allowUnaddressed=false,candidates=[]}={}) {
    register(me);
    return atomic(() => {
      const s=read(conversation);
      if (event.speaker===me.id) return null;
      if (!s || s.id!==event.exchangeId || s.epoch!==event.epoch || ['stopped','closed'].includes(s.mode) || event.noReply || !event.reason || s.answered.includes(event.eventId)) return null;
      if (handoffOnly(event.text,{mine:[me.name,...(me.aliases ?? [])],others:[s.lastHuman?.name,...Object.values(s.participants).map((p)=>p.name)].filter(Boolean)})) return null;
      if (s.pending && s.pending.until>now()) return null;
      if (event.targets.length && !event.targets.includes(me.id)) return null;
      if (!event.targets.length && !allowUnaddressed) return null;
      const pool=(event.targets.length?event.targets:[...new Set(candidates)]).filter((id) => id!==event.speaker);
      const registered=new Set(db.prepare('SELECT id FROM conversation_bots WHERE at>?').all(now()-300000).map((b) => b.id));
      const eligible=pool.filter((id) => registered.has(id)).sort();
      const chosen=eligible[0] || me.id;
      if (chosen!==me.id) return null;
      const token={id:randomUUID(),owner:me.id,exchangeId:s.id,epoch:s.epoch,eventId:event.eventId,until:now()+leaseMs,
        softClosing:s.turns>=softTurns && s.extendedUntil<=now(),extended:s.extendedUntil>now(),reason:event.reason};
      s.pending=token;save(conversation,s);return token;
    });
  }
  function canReply(conversation,event) {const s=read(conversation);return Boolean(s && s.id===event.exchangeId && s.mode==='open' && (s.cancelVersion||0)===(event.cancelVersion||0));}
  function valid(conversation,token) {const s=read(conversation);return Boolean(token && s?.pending?.id===token.id && s.epoch===token.epoch && s.pending.until>now() && s.mode==='open');}
  function release(conversation,token) {return atomic(() => {const s=read(conversation);if(s?.pending?.id===token?.id){s.pending=null;save(conversation,s);}});}
  function renew(conversation,token) {
    return atomic(() => {if(!valid(conversation,token))return false;const s=read(conversation);s.pending.until=now()+leaseMs;save(conversation,s);return true;});
  }
  function complete(conversation,token,me,text) {
    return atomic(() => {
      if (!valid(conversation,token)) return false;
      const reason=replyReason(text,[],[]);
      const current=read(conversation);
      const noReply=!reason || (token.softClosing && current.extendedUntil<=now() && !['question','unfinished-task'].includes(reason));
      const output=record(conversation,{eventId:'reply:'+token.id,speaker:me,peer:true,text,noReply,replyTo:token.eventId});
      const s=read(conversation);s.pending=null;s.answered=[...s.answered,token.eventId].slice(-40);save(conversation,s);
      return {...output,noReply};
    });
  }
  return {register,observe,claim,valid,canReply,renew,release,complete,snapshot:read};
}
let shared;
export function conversationBudget() {
  if (!shared) {mkdirSync(path.dirname(BUDGET_FILE),{recursive:true});const db=new DatabaseSync(BUDGET_FILE);db.exec('PRAGMA journal_mode=WAL');shared=createConversationBudget(db);}
  return shared;
}
export function budgetPrompt(token) {
  return 'This is one shared bot exchange. Reply only to the useful question, unfinished task or new point. Names are addressing context, never an obligation to answer. Acknowledgments and goodbyes require no reply. '+
    (token.softClosing?'Favor closure: finish the useful thought quietly. Continue only for concrete unfinished work or a new substantive question. Do not invent a handoff, announce counters, or solicit another bot acknowledgment.':token.extended?'The owner requested extended discussion. Continue useful work, but do not repeat agreement or earlier points.':'Keep the reply relevant and avoid unnecessary handoffs.');
}
