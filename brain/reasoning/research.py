"""Bounded public-gap research. Remote text is evidence data, never instructions."""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import asdict, replace

from app.learning import Learner, Resolver, Unsupported, Unresolved
from dialogue.state import DialogueState
from dialogue import realizer
from dialogue.validator import frame_signature
from nlp.discourse import split_sentences
from nlp.parser import parse_sentence, ParseError
from nlp.semantic_frames import Frame, NounPhrase
from nlp.morphology import pluralize, lemmatize_noun


class PublicSources:
    """Only fixed HTTPS APIs. No URL, shell command, or tool suggested by a page is followed."""
    def search(self, term, query, get):
        documents=[]
        hits=get('https://en.wikipedia.org/w/api.php?'+urllib.parse.urlencode(
            dict(action='opensearch',search=query,limit=2,format='json')))
        titles=hits[1] if hits and len(hits)>1 else []
        exact=[title for title in titles if title.casefold()==term.casefold()]
        if not exact and query!=term:
            hits=get('https://en.wikipedia.org/w/api.php?'+urllib.parse.urlencode(dict(action='opensearch',search=term,limit=2,format='json')))
            exact=[title for title in (hits[1] if hits and len(hits)>1 else []) if title.casefold()==term.casefold()]
        if exact:
            for title in exact[:1]:
                # Avoid guessing among namesakes or sending a private context to a page.
                if term.casefold() not in title.casefold(): continue
                page=get('https://en.wikipedia.org/api/rest_v1/page/summary/'+urllib.parse.quote(title.replace(' ','_')))
                if page and page.get('type')!='disambiguation' and page.get('extract'):
                    url=page.get('content_urls',{}).get('desktop',{}).get('page','')
                    if url.startswith('https://en.wikipedia.org/'):
                        documents.append(dict(url=url,family='wikimedia',reliability=.8,text=page['extract'][:6000]))
        hits=get('https://www.wikidata.org/w/api.php?'+urllib.parse.urlencode(
            dict(action='wbsearchentities',search=term,language='en',limit=2,format='json')))
        candidates=[x for x in (hits or {}).get('search',[]) if x.get('label','').casefold()==term.casefold()]
        if len(candidates)==1:
            ident=candidates[0]['id']
            if re.fullmatch(r'Q\d+',ident):
                data=get('https://www.wikidata.org/wiki/Special:EntityData/'+ident+'.json') or {}
                entity=data.get('entities',{}).get(ident,{})
                parents=[]
                for prop in ('P279','P171'):
                    for claim in entity.get('claims',{}).get(prop,[])[:4]:
                        if claim.get('rank')=='deprecated': continue
                        value=claim.get('mainsnak',{}).get('datavalue',{}).get('value',{})
                        if isinstance(value,dict) and re.fullmatch(r'Q\d+',value.get('id','')): parents.append(value['id'])
                if parents:
                    labels=get('https://www.wikidata.org/w/api.php?'+urllib.parse.urlencode(
                        dict(action='wbgetentities',ids='|'.join(parents),props='labels',languages='en',format='json'))) or {}
                    facts=[]
                    for parent in labels.get('entities',{}).values():
                        label=parent.get('labels',{}).get('en',{}).get('value','')
                        if re.fullmatch(r'[A-Za-z -]{2,60}',label): facts.append(pluralize(term)+' are '+pluralize(label)+'.')
                    documents.append(dict(url='https://www.wikidata.org/wiki/'+ident,family='wikimedia',reliability=.8,text=' '.join(facts)))
        return documents


class Researcher:
    def __init__(self, repo, provider=None, enabled=None, wordnet=None, ledger=None):
        self.repo,self.provider,self.wordnet=repo,provider or PublicSources(),wordnet
        self.enabled = enabled if enabled is not None else (os.environ.get('AMY_RESEARCH_ENABLED','true').lower()=='true' and os.environ.get('HALMINI_WEB','1')!='0' and 'pytest' not in sys.modules)
        self.rounds=max(0,min(3,int(os.environ.get('AMY_RESEARCH_ROUNDS','2'))))
        self.request_limit=max(0,min(12,int(os.environ.get('AMY_RESEARCH_REQUESTS','8'))))
        self.daily_limit=max(0,int(os.environ.get('AMY_RESEARCH_DAILY_REQUESTS','40')))
        self.deadline_seconds=max(1,min(30,float(os.environ.get('AMY_RESEARCH_SECONDS','10'))))
        self.repo.conn.executescript('''
            CREATE TABLE IF NOT EXISTS research_queries(
                query TEXT PRIMARY KEY, attempted REAL NOT NULL, status TEXT NOT NULL, detail TEXT);
            CREATE TABLE IF NOT EXISTS research_requests(
                id INTEGER PRIMARY KEY, at REAL NOT NULL, url TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS research_evidence(
                id INTEGER PRIMARY KEY, query TEXT NOT NULL, claim TEXT NOT NULL, url TEXT NOT NULL,
                family TEXT NOT NULL, retrieved REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS research_claims(key TEXT PRIMARY KEY, assertion_ids TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assertion_sources(
                assertion_id INTEGER NOT NULL, url TEXT NOT NULL, retrieved REAL NOT NULL,
                confidence REAL NOT NULL, status TEXT NOT NULL, PRIMARY KEY(assertion_id,url));
        ''')
        self.audit = ledger or self.repo.conn
        if self.audit is not self.repo.conn:
            for name in ('research_queries','research_requests','research_evidence'):
                sql=self.repo.conn.execute("SELECT sql FROM sqlite_master WHERE name=?",(name,)).fetchone()[0]
                self.audit.execute(sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ',1))
            self.audit.commit()
        self.last_documents=[]

    def gap(self, frame, convo=None, query=None):
        if convo and query:
            gaps=convo.gaps._rule_gaps(query)
            if gaps:
                text=gaps[0]['missing'][0]
                try: frame=parse_sentence(text,convo.lexicon())[0]
                except ParseError: return None,'Which exact missing condition should I check?'
        subject=frame.subject
        if subject is None or subject.proper or subject.pronoun or subject.possessor or subject.quantifier:
            return None,"I don't know whether "+realizer.realize_frame(frame).rstrip('.?')+", and it isn't something I can look up. Do you know?"
        term=lemmatize_noun(subject.head)[0]
        if not re.fullmatch(r'[a-z][a-z -]{1,60}',term): return None,'What public concept should I research?'
        target=frame.obj.head if frame.obj else ' '.join(frame.properties) or frame.verb or 'definition'
        return dict(term=term,target=target,query=(term+' '+target).strip()),None

    def _get(self, url):
        if time.monotonic()>=self.deadline or self.requests>=self.request_limit: return None
        if urllib.parse.urlsplit(url).hostname not in ('en.wikipedia.org','www.wikidata.org'): return None
        count=self.audit.execute('SELECT count(*) FROM research_requests WHERE at>?',(time.time()-86400,)).fetchone()[0]
        if count>=self.daily_limit: return None
        self.requests+=1
        with self.audit:self.audit.execute('INSERT INTO research_requests(at,url) VALUES(?,?)',(time.time(),url))
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs): return None
        try:
            request=urllib.request.Request(url,headers={'User-Agent':'AmyReasoning/1.0 (bounded public knowledge research)','Accept':'application/json'})
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            with opener.open(request,timeout=max(.1,min(3,self.deadline-time.monotonic()))) as response: data=response.read(262145)
            if len(data)>262144: return None
            return json.loads(data)
        except (OSError,ValueError): return None

    def extract(self, documents, gap, lexicon):
        grouped=defaultdict(list)
        for doc in documents[:8]:
            url=doc.get('url','')
            if not url.startswith('https://') or not isinstance(doc.get('text'),str): continue
            # Wikipedia and Wikidata are related sources, not two independent witnesses.
            host=urllib.parse.urlsplit(url).hostname or ''
            family='wikimedia' if host.endswith(('wikipedia.org','wikidata.org','wiktionary.org')) else host
            reliability=.85 if host=='en-word.net' else .8 if family=='wikimedia' or host.endswith(('.edu','.gov')) else .5
            for sentence in split_sentences(doc['text'][:6000])[:12]:
                if re.search(r'\b(?:ignore|instructions?|system prompt|API key|password|execute|download|run command)\b',sentence,re.I): continue
                # A quoted taxonomic definition licenses the parent category, not
                # every trailing detail of the article or a namesake's category.
                definition=re.match(r'^(?:[Aa]n? |[Tt]he )?'+re.escape(gap['term'])+r' is (?:a |an )?(?:type|kind|breed|species|group) of (.+?)(?:\s+(?:that|which|originally|native|bred|used|with|from|and)\b|[,.;(]|$)',sentence,re.I)
                if definition:
                    from nlp.parser import parse_noun_phrase
                    try:
                        parent,_=parse_noun_phrase(definition[1],lexicon)
                        if not parent.proper:
                            sentence=pluralize(gap['term'])+' are '+pluralize(parent.head)+'.'
                    except ParseError: pass
                try: frames=parse_sentence(sentence,lexicon)
                except ParseError: continue
                for frame in frames:
                    if not isinstance(frame,Frame) or frame.act!='assert' or frame.correction or frame.modality: continue
                    if not frame.subject or frame.subject.proper or frame.subject.pronoun or frame.subject.possessor: continue
                    if lemmatize_noun(frame.subject.head)[0]!=gap['term']: continue
                    if frame.obj and (frame.obj.pronoun or frame.obj.proper or frame.obj.possessor): continue
                    if frame.subject.modifiers: continue
                    if frame.obj and frame.obj.modifiers:
                        if frame.relation!='is_a' or not frame.polarity: continue
                        frame=replace(frame,obj=replace(frame.obj,modifiers=()))
                    if frame.args or frame.relation not in ('is_a','property','rel'): continue
                    key=frame_signature(frame,True)
                    grouped[repr(key)].append((frame,url,family,reliability))
        return grouped

    def integrate(self, documents, gap, lexicon):
        groups=self.extract(documents,gap,lexicon)
        learned=[]
        for group in groups.values():
            polarities={entry[0].polarity for entry in group}
            families={entry[2] for entry in group}
            status='contradictory' if len(polarities)>1 else 'corroborated' if len(families)>=2 and min(x[3] for x in group)>=.75 else 'unconfirmed'
            now=time.time()
            frame=group[0][0]
            claim=realizer.realize_frame(frame)
            with self.repo.conn:
                for candidate,url,family,reliability in group:
                    self.repo.conn.execute('INSERT INTO research_evidence(query,claim,url,family,retrieved,confidence,status) VALUES(?,?,?,?,?,?,?)',
                        (gap['query'],realizer.realize_frame(candidate),url,family,now,reliability,status))
            if status!='corroborated': continue
            confidence=min(.9,min(x[3] for x in group))
            key=repr(frame_signature(frame,frame.polarity))
            prior=self.repo.conn.execute('SELECT assertion_ids FROM research_claims WHERE key=?',(key,)).fetchone()
            if prior:
                aids=json.loads(prior[0])
                # A person's correction must not be undone by a cached web claim.
                if any(self.repo.assertion(aid)['status']!='active' for aid in aids): continue
            else:
                uid=self.repo.log_utterance('research',claim)
                resolver=Resolver(self.repo,DialogueState(speaker='research'),'Amy');resolver.begin(uid)
                try: aids=Learner(self.repo,resolver).learn(replace(frame,confidence=confidence),uid)
                except (Unsupported,Unresolved): continue
                with self.repo.conn:self.repo.conn.execute('INSERT INTO research_claims VALUES(?,?)',(key,json.dumps(aids)))
            with self.repo.conn:
                for aid in aids:
                    for _,url,_,_ in group:
                        self.repo.conn.execute('INSERT OR REPLACE INTO assertion_sources VALUES(?,?,?,?,?)',(aid,url,now,confidence,status))
            learned+=aids
        return learned

    def drain(self, bridge, lexicon):
        import sqlite3
        if not bridge.queue_path.is_file(): return []
        queue=sqlite3.connect(bridge.queue_path)
        learned=[]
        try:
            if not queue.execute("SELECT 1 FROM sqlite_master WHERE name='research_inbox'").fetchone(): return []
            for ident,payload in queue.execute("SELECT id,payload FROM research_inbox WHERE status='pending' LIMIT 4").fetchall():
                try:
                    data=json.loads(payload)
                    aids=self.integrate(data['documents'],data['gap'],lexicon)
                    learned+=aids
                    with queue:queue.execute('UPDATE research_inbox SET status=? WHERE id=?',('applied' if aids else 'unconfirmed',ident))
                except (ValueError,KeyError,TypeError):
                    with queue:queue.execute("UPDATE research_inbox SET status='rejected' WHERE id=?",(ident,))
        finally:queue.close()
        return learned

    def run(self, frame, lexicon, convo=None, query=None):
        gap,clarification=self.gap(frame,convo,query)
        if gap is None: return dict(status='clarification',question=clarification,learned=[])
        if not self.enabled: return dict(status='offline',learned=[])
        self.deadline=time.monotonic()+self.deadline_seconds;self.requests=0
        documents=[];learned=[];queries=[]
        if self.wordnet:
            selection=self.wordnet.select(gap['term'],gap['target'])
            if selection.sense:
                facts=[]
                for ident,path in self.wordnet.ancestors(selection.sense.id,depth=6,budget=60).items():
                    parent=self.wordnet.sense(ident)
                    if len(path)>1 and parent and self.wordnet.verify_path(path):
                        facts.append(pluralize(gap['term'])+' are '+pluralize(parent.lemma)+'.')
                if facts: documents.append(dict(url='https://en-word.net/',text=' '.join(facts),sense=selection.sense.id))
        for round_number in range(self.rounds):
            search=gap['query'] if round_number==0 else gap['term']+' '+gap['target']+' definition classification'
            key=search.casefold()
            prior=self.audit.execute('SELECT attempted FROM research_queries WHERE query=?',(key,)).fetchone()
            if prior and time.time()-prior[0]<max(0,float(os.environ.get('AMY_RESEARCH_QUERY_COOLDOWN_SECONDS','86400'))): continue
            if time.monotonic()>=self.deadline: break
            with self.audit:self.audit.execute('INSERT OR REPLACE INTO research_queries VALUES(?,?,?,?)',(key,time.time(),'started',None))
            queries.append(search)
            try: documents+=self.provider.search(gap['term'],search,self._get)
            except (OSError,ValueError,TypeError): pass
            added=self.integrate(documents,gap,lexicon)
            learned=list(dict.fromkeys(learned+added))
            if added and convo is not None:
                digester=getattr(convo,'digester',None)
                if digester is not None:
                    texts=[t for aid in added if (t:=realizer.realize_assertion(self.repo,self.repo.assertion(aid)))]
                    try:
                        digester.record(gap['term'],f"research:{gap['query']}",' '.join(texts),
                                        facts=added,confidence=.8,kind='research')
                    except Exception:
                        pass
            with self.audit:self.audit.execute('UPDATE research_queries SET status=? WHERE query=?',('learned' if learned else 'unresolved',key))
            if added:
                if not convo: break
                from reasoning.proofs import YES,NO
                convo.resolver.begin(convo.resolver.uid)
                original,_,_=convo._build_query(frame)
                if original is not None and convo.engine.ask(original,frame).status in (YES,NO): break
                next_gap,_=self.gap(frame,convo,original)
                if next_gap and next_gap['term']!=gap['term']:
                    gap=next_gap
        self.last_documents=documents
        return dict(status='learned' if learned else 'unresolved',learned=learned,queries=queries,
                    sources=list(dict.fromkeys(d.get('url','') for d in documents)),cost_usd=0.,requests=self.requests,
                    question='I could not corroborate the missing fact. Can you supply a reliable source or clarify the exact meaning?')
