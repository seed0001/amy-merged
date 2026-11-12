"""Short progress reports drawn exclusively from committed investigation events.

Progress narration reports only facts that have not already been told. The one
terminal report is deliberately different: it is a single prose summary of the
whole investigation, so the listener gets a conclusion rather than the same
milestones once more.
"""

import hashlib
import json
import re

from reasoning.investigation_results import final_summary


def _normal(text):
    return re.sub(r'\s+',' ',str(text)).strip()


def _key(text):
    return re.sub(r'[^a-z0-9]+',' ',str(text).casefold()).strip()


def _facts(state,event,pick=None):
    """Facts carried by one milestone, in the order worth saying them."""
    topic=state['objective'].rstrip('?.')[:100]
    detail=event.get('detail') or {}
    action=event.get('action')
    facts=[]
    def add(kind,identity,text):
        if text:
            facts.append(dict(key=kind+':'+_key(identity),text=_normal(text)))
    if action=='missing-objective':
        add('gap',detail['gaps'][0]['question'],detail['gaps'][0]['question'])
    elif action=='compare-definitions':
        checks=state.get('definition_checks',[])
        if checks:
            add('definition-check',checks[0]['text'],checks[0]['text'])
        else:
            meanings=list(dict.fromkeys(d['definition'] for d in state.get('definitions',[])))
            if detail.get('ambiguities') and len(meanings)>1:
                first,second=sorted(meanings[:2])
                add('ambiguity',topic+' '+first+' '+second,
                    'There are competing meanings for '+topic+': '+first+'; or '+second+
                    '. Neither interpretation is yet established for the subject.')
    elif action=='test-established-rules':
        if detail['gaps']:
            add('gap',detail['gaps'][0]['question'],'I found a specific gap: '+detail['gaps'][0]['question'])
        if detail['conclusions']:
            status=detail['conclusions'][0]['status']
            if status in ('yes','no'):
                conclusion=detail['conclusions'][0].get('text',f"{'yes' if status=='yes' else 'no'} to {topic}")
                add('conclusion',conclusion,
                    f"The evidence supports this: {conclusion}. I'm checking possible generalizations before I summarize.")
        if detail.get('connections'):
            add('connection',detail['connections'][0]['text'],
                "I've established a connection: "+detail['connections'][0]['text']+". I'm checking the remaining implications.")
    elif action=='counterexample-tests':
        for hypothesis in detail['hypotheses']:
            status=hypothesis.get('status')
            if status=='rejected':
                counter=hypothesis.get('counterexamples',[])
                why=counter[0].get('explanation') if counter else None
                add('hypothesis',hypothesis['label']+' rejected',
                    'I rejected the proposal that '+hypothesis['label'][:1].lower()+hypothesis['label'][1:]
                    +((' because '+why.rstrip('.')) if why else ' because its evidence checks did not hold')+'.')
            elif status=='provisional-supported':
                add('hypothesis',hypothesis['label']+' provisional',
                    'The proposal that '+hypothesis['label'][:1].lower()+hypothesis['label'][1:]
                    +' survived the checked cases, but it remains provisional rather than a general fact.')
    return facts


def progress(state,event,pick=None,seen=None):
    """Return (text, keys) for facts not in ``seen``; text is None when nothing is new."""
    fresh=[item for item in _facts(state,event,pick) if item['key'] not in set(seen or ())]
    if not fresh:return None,[]
    shown=fresh[:3]
    return ' '.join(item['text'] for item in shown),[item['key'] for item in fresh]


def blip(state,event,pick=None,seen=None):
    action=event.get('action')
    if action in ('synthesize','budget-limit'):
        return final_summary(state,pick=pick)
    return progress(state,event,pick,seen)[0]


def _final_key(state):
    return str(state.get('revision') or '')


def pending(store,owner,now,cooldown=25,pick=None):
    if store.get('narration:muted:'+owner,False):return None
    worker=store.get('worker')
    if worker and (worker.get('error') or now-worker.get('last_cycle',0)>30
                   or store.get('worker_stopped',0)>=worker.get('last_cycle',0)):
        return None
    if now-store.get('narration:last:'+owner,0)<cooldown:
        return None
    rows=store.conn.execute('SELECT id,payload FROM investigations WHERE owner=? '
                            'AND json_extract(payload,"$.parent") IS NULL ORDER BY updated DESC', (owner,)).fetchall()
    for row in rows:
        state=json.loads(row['payload'])
        if state.get('phase') == 'cancelled': continue
        after=store.get('narration:cursor:'+str(row['id']),0)
        spoken=set(store.get('narration:spoken:'+str(row['id']),[]))
        seen=set(store.get('narration:facts:'+str(row['id']),[]))
        final_done=store.get('narration:final:'+str(row['id']))
        # Coalesce progress when the worker advances faster than spoken updates.
        events=store.conn.execute('SELECT id,payload FROM investigation_events WHERE investigation_id=? AND id>? '
                                  'ORDER BY id DESC LIMIT 20', (row['id'],after)).fetchall()
        for event_row in events:
            event=json.loads(event_row['payload'])
            action=event.get('action')
            if action in ('synthesize','budget-limit'):
                revision=_final_key(state)
                if final_done==revision:continue
                text=final_summary(state,pick=pick)
                if text:
                    return {'text':text,'event':event_row['id'],'investigation':row['id'],'owner':owner,
                            'revision':state['revision'],'facts':[],'final':revision}
                continue
            text,facts=progress(state,event,pick,seen)
            if text and hashlib.sha256(text.encode()).hexdigest() not in spoken:
                return {'text':text,'event':event_row['id'],'investigation':row['id'],'owner':owner,
                        'revision':state['revision'],'facts':facts}
    return None


def delivered(store,notice,now):
    store.set('narration:cursor:'+str(notice['investigation']),notice['event'])
    store.set('narration:last:'+notice['owner'],now)
    key='narration:spoken:'+str(notice['investigation'])
    spoken=store.get(key,[])
    spoken.append(hashlib.sha256(notice['text'].encode()).hexdigest())
    store.set(key,spoken)
    facts=notice.get('facts') or []
    if facts:
        key='narration:facts:'+str(notice['investigation'])
        store.set(key,list(dict.fromkeys(store.get(key,[])+facts))[-200:])
    if notice.get('final') is not None:
        store.set('narration:final:'+str(notice['investigation']),notice['final'])
