"""Maintain an evidence-backed view shared by learning, thought imports and conversation.

Conclusions retain their proofs instead of becoming independent, self-supporting facts.
"""
import hashlib
import json
import re
from dataclasses import asdict
from dialogue import realizer
from reasoning.engine import Engine
from reasoning.proofs import Query, YES, NO, CONFLICTING


def frozen(value):
    return tuple(frozen(v) for v in value) if isinstance(value, list) else value


def load_query(data):
    data = dict(data)
    for key in ('subject', 'obj', 'properties', 'args'):
        if key in data:
            data[key] = frozen(data[key])
    return Query(**data)


class ReasoningCoordinator:
    def __init__(self, convo):
        self.convo, self.repo = convo, convo.repo
        self.engine = Engine(self.repo, convo.engine.max_depth, convo.engine.budget,
                             semantics=getattr(convo, "semantics", None))
        self.repo.conn.executescript('''
            CREATE TABLE IF NOT EXISTS reasoning_conclusions(
                key TEXT PRIMARY KEY, query_json TEXT NOT NULL, conclusion TEXT NOT NULL,
                proof_json TEXT NOT NULL, status TEXT NOT NULL, revision TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'learning');
            CREATE TABLE IF NOT EXISTS reasoning_gaps(
                key TEXT PRIMARY KEY, subject_id INTEGER NOT NULL, resource TEXT NOT NULL,
                question TEXT NOT NULL, status TEXT NOT NULL, evidence_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reasoning_reflections(
                key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'own-reasoning');
            CREATE TABLE IF NOT EXISTS reasoning_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        ''')

    def revision(self):
        facts = [tuple(r) for r in self.repo.conn.execute('SELECT id,status,confidence FROM assertions ORDER BY id')]
        rules = [tuple(r) for r in self.repo.conn.execute('SELECT id,status,confidence FROM learned_rules ORDER BY id')]
        return hashlib.sha256(json.dumps(['proofs-v2', facts, rules]).encode()).hexdigest()

    def _save(self, query, proof, status, revision, origin='learning'):
        if not proof.steps or (not proof.derived and len(proof.steps) < 2):
            return
        conclusion = realizer.derived_text(self.repo, proof)
        if not conclusion and query.relation == 'is_a' and query.subject and query.obj:
            conclusion = realizer.term_text(self.repo, *query.subject, definite=True) + ' is ' + realizer.term_text(self.repo, *query.obj)
        if not conclusion:
            return
        payload = json.dumps(asdict(query), sort_keys=True)
        self.repo.conn.execute('INSERT INTO reasoning_conclusions VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET '
                               'conclusion=excluded.conclusion,proof_json=excluded.proof_json,status=excluded.status,revision=excluded.revision,origin=excluded.origin',
                               (payload+':'+status, payload, conclusion, json.dumps(asdict(proof)), status, revision, origin))

    def _remember(self):
        # Derived knowledge is a proof cache, not a new self-supporting premise.
        from reasoning.proofs import Proof
        target = self.convo.engine
        target.remembered.clear()
        for row in self.repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported' LIMIT 128"):
            query = load_query(json.loads(row['query_json']))
            answer = self.engine.ask(query)
            if answer.status not in (YES,NO) or answer.budget_exhausted: continue
            proofs = answer.support if answer.status == YES else answer.against
            if not proofs: continue
            proof = proofs[0]
            if proof.derived is None:
                pattern = dict(relation=query.relation,subject=list(query.subject),obj=query.obj,
                               props=list(query.properties),args=list(query.args),verb=query.verb,polarity=answer.status==YES)
                proof.derived = (pattern,query.subject)
            target.remembered[repr(query)] = proof

    def refresh(self):
        semantics = getattr(self.convo, "semantics", None)
        semantic_changes = semantics.sync() if semantics is not None else {}
        revision = self.revision()
        row = self.repo.conn.execute("SELECT value FROM reasoning_state WHERE key='revision'").fetchone()
        if row and row[0] == revision:
            self._remember()
            return
        rules, entities = self.repo.active_rules(), self.repo.subject_entities()
        with self.repo.conn:
            self.repo.conn.execute("UPDATE reasoning_conclusions SET status='withdrawn'")
            self.repo.conn.execute("UPDATE reasoning_gaps SET status='withdrawn'")
            for entity in entities:
                for rule in rules:
                    for pattern in rule['conclusions']:
                        query = self.engine._instantiate(pattern, entity)
                        answer = self.engine.ask(query)
                        if answer.budget_exhausted:
                            continue
                        if answer.status == CONFLICTING:
                            for proof in answer.support + answer.against:
                                self._save(query, proof, 'conflicting', revision)
                        elif answer.status in (YES, NO):
                            proofs = answer.support if answer.status == YES else answer.against
                            for proof in proofs[:1]:
                                self._save(query, proof, 'supported', revision)
            for entity in entities:
                for inst in self.repo.assertions('instance_of', subj=entity, polarity=True):
                    for kind, path in self.engine.ancestors(inst['obj_id']).items():
                        if not path: continue
                        query = Query('is_a', entity, ('c', kind))
                        answer = self.engine.ask(query)
                        if answer.status == YES and not answer.budget_exhausted \
                                and not self._wordnet_only(answer.support[0]):
                            self._save(query, answer.support[0], 'supported', revision)
            self._gaps()
            if semantics is not None:
                # Explore the graph a little on every settled revision.  Inferences stay
                # provisional records with their path; gaps feed curiosity and pressure.
                semantics.infer(limit=24)
                semantics.gaps()
            from reasoning.thoughts import ThoughtChain, valid_chain
            for reflection in self.repo.conn.execute("SELECT * FROM reasoning_reflections").fetchall():
                chain = ThoughtChain(**json.loads(reflection['payload']))
                # Unrelated new facts do not erase her earlier reasoning.
                from reasoning.thoughts import revision as thought_revision
                chain.knowledge_revision = thought_revision(self.repo)
                valid = valid_chain(chain, self.repo) and (chain.kind != "concept-reflection" or bool(chain.steps))
                if valid and chain.query:
                    answer = self.engine.ask(load_query(chain.query))
                    valid = answer.status in (YES, NO) and not answer.budget_exhausted
                if valid:
                    from reasoning.engine import query_from_row
                    valid = all(self.engine.ask(query_from_row(self.repo, self.repo.assertion(aid))).status != CONFLICTING
                                for aid in chain.premises)
                self.repo.conn.execute("UPDATE reasoning_reflections SET status=?,payload=? WHERE key=?",
                                       ('supported' if valid else 'withdrawn', json.dumps(asdict(chain)), chain.key))
            self.repo.conn.execute("INSERT INTO reasoning_state VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (revision,))

        self._remember()

    def _wordnet_only(self, proof) -> bool:
        """A dictionary category link is evidence, not a conclusion Amy discovered.

        If any taxonomic step came from WordNet, the conclusion is just following the
        dictionary's hypernym chain, even when the entity's own category came from a
        person.  Categories taught and related by people still produce conclusions.
        """
        for aid in proof.steps:
            row = self.repo.assertion(aid)
            if row is None or row['predicate'] not in ('subclass_of', 'instance_of'):
                continue
            prov = self.repo.conn.execute(
                "SELECT origin FROM assertion_provenance WHERE assertion_id=?", (aid,)).fetchone()
            if prov is not None and prov[0] == 'wordnet':
                return True
        return False

    def _gaps(self):
        roles = {'replacement': 'replace', 'inspection': 'inspect', 'repair': 'repair', 'delivery': 'deliver'}
        for row in self.repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status='supported'").fetchall():
            query = load_query(json.loads(row['query_json']))
            if query.relation != 'rel' or query.verb not in ('need', 'require') or not query.subject or query.subject[0] != 'e' or not query.obj:
                continue
            resource = self.repo.concept_lemma(query.obj[1]) if query.obj[0] in ('c', 'kind') else None
            if not resource:
                continue
            subject = query.subject[1]
            providers = self.repo.assertions('rel:'+roles[resource], obj=('e', subject), polarity=True) if resource in roles else []
            valid = [r for r in providers if self.engine.ask(Query('rel', ('e', r['subj_id']), ('e', subject), verb=roles[resource])).status == YES]
            name = self.repo.entity_row(subject)['name']
            self.repo.conn.execute('INSERT INTO reasoning_gaps VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,evidence_json=excluded.evidence_json',
                                   (row['key'], subject, resource, f'Who or what will provide the {resource} for {name}?', 'resolved' if valid else 'open',
                                    json.dumps({'conclusion': row['key'], 'providers': [r['id'] for r in valid]})))

    def import_thoughts(self, bridge):
        path = getattr(bridge, 'queue_path', None)
        if not path or not path.is_file():
            return
        from reasoning.thoughts import ThoughtStore, valid_chain
        bound_store = ThoughtStore(path)
        try:
            bound_store.bind_memory(self.repo)
        finally:
            bound_store.close()
        if hasattr(self.convo, 'research') and self.convo.research.drain(bridge,self.convo.lexicon()):
            self.refresh()
        store = ThoughtStore(path)
        try:
            for chain in store.recent():
                if not valid_chain(chain, self.repo) or (chain.kind == 'concept-reflection' and not chain.steps):
                    continue
                with self.repo.conn:
                    self.repo.conn.execute("INSERT INTO reasoning_reflections VALUES(?,?,'supported','own-reasoning') "
                                           "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,status='supported'",
                                           (chain.key, json.dumps(asdict(chain))))
                query_data = getattr(chain, 'query', None)
                if not query_data:
                    continue
                query = load_query(query_data)
                answer = self.engine.ask(query)
                if answer.status not in (YES, NO) or answer.budget_exhausted:
                    continue
                proofs = answer.support if answer.status == YES else answer.against
                with self.repo.conn:
                    for proof in proofs[:1]:
                        self._save(query, proof, 'supported', self.revision(), 'background')
                    self._gaps()
        finally:
            store.close()
        self._remember()

    def reflection(self, text, explicit=False):
        from reasoning.thoughts import ThoughtChain, explain_chain
        words = set(re.findall(r"\w+", text.lower()))
        for row in self.repo.conn.execute("SELECT payload FROM reasoning_reflections WHERE status='supported' ORDER BY rowid DESC"):
            chain = ThoughtChain(**json.loads(row[0]))
            if explicit or words & set(re.findall(r"\w+", chain.topic.lower())):
                if not explicit and (self.convo.state.speaker, chain.key) in getattr(self.convo, '_offered_reflections', set()):
                    continue
                if chain.kind == 'concept-reflection' and not chain.steps: continue
                self._expect(chain)
                from reasoning.thoughts import ThoughtStore
                bridge = getattr(self.convo, 'thinking', None)
                if bridge and bridge.queue_path.is_file():
                    delivery = ThoughtStore(bridge.queue_path)
                    try: delivery.mark_delivered(self.convo.state.speaker, chain)
                    finally: delivery.close()
                return explain_chain(chain, self.repo, self.convo.social.phrases.pick), {'key': chain.key, 'status': 'ready', 'origin': 'own-reasoning', 'premises': chain.premises}
        if explicit:
            rows = self.repo.conn.execute("SELECT conclusion FROM reasoning_conclusions WHERE status='supported'").fetchall()
            if rows:
                return "I've worked out that " + realizer.join_clauses([r[0] for r in rows]) + '.', {'origin': 'own-reasoning'}
        return None

    def _expect(self, chain):
        from dialogue.inquiry import Pending
        from nlp.parser import parse_sentence, ParseError
        import time
        if chain.ask.get('kind') == 'rule':
            self.convo.inquiry.pending[self.convo.state.speaker] = Pending('exceptions', time.time(), term=chain.ask.get('rule'))
            return
        try:
            frame = parse_sentence(chain.question, self.convo.lexicon())[0]
        except ParseError:
            return
        if frame.act == 'ask' and not frame.slot:
            self.convo.inquiry.pending[self.convo.state.speaker] = Pending('yes_no', time.time(), frame=frame)

    def answer(self, text):
        if not re.search(r'\b(?:why|explain|sort out|need to|worked out|conclusions|discoveries|tell me about|know about)\b', text, re.I):
            return None
        self.refresh()
        words = set(re.findall(r'[a-z0-9-]+', text.lower()))
        chosen = []
        named_targets = set()
        for entity in self.repo.subject_entities():
            if entity[0] == 'e':
                name_words = set(re.findall(r'[a-z0-9-]+', self.repo.entity_row(entity[1])['name'].lower()))
                from nlp.lexicon import DAYS
                if name_words and not name_words & set(DAYS) and self.repo.entity_row(entity[1])['proper'] and name_words <= words:
                    named_targets.add(entity[1])
        for row in self.repo.conn.execute("SELECT * FROM reasoning_conclusions WHERE status IN ('supported','conflicting')"):
            query = load_query(json.loads(row['query_json']))
            if not query.subject or query.subject[0] != 'e':
                continue
            if named_targets and query.subject[1] not in named_targets:
                continue
            context = [self.repo.entity_row(query.subject[1])['name']]
            for fact in self.repo.conn.execute("SELECT id FROM assertions WHERE status='active' AND subj_type='e' AND subj_id=?", (query.subject[1],)):
                for arg in self.repo.arg_records(fact['id']):
                    if arg[1] == 'lit':
                        context.append(arg[3] or '')
                    elif arg[1] == 'e':
                        context.append(realizer.term_text(self.repo, 'e', arg[2], definite=True))
            relevant = set(re.findall(r'[a-z0-9-]+', ' '.join(context).lower())) - {'the', 'a', 'an', 'for', 'on', 'at', 'in'}
            from nlp.lexicon import DAYS
            days = words & set(DAYS)
            if words & relevant and (not days or days <= relevant):
                chosen.append(row)
        if not chosen:
            return None
        evidence, conclusions, rules, subjects = [], [], [], set()
        intermediate = []
        for row in chosen:
            query = load_query(json.loads(row['query_json']))
            subjects.add(query.subject[1])
            proof = json.loads(row['proof_json'])
            conclusions.append(row['conclusion'])
            intermediate += [step['conclusion'] for step in proof.get('derivation_steps', []) if step.get('conclusion')]
            for aid in proof['steps']:
                fact = realizer.realize_assertion(self.repo, self.repo.assertion(aid))
                if fact and fact not in evidence:
                    evidence.append(fact)
            for rid in proof['learned_rules']:
                rule = realizer.rule_text(self.repo, self.repo.rule(rid))
                if rule not in rules:
                    rules.append(rule)
        body = 'I was told that '+realizer.join_clauses(evidence)+'. '
        body += ('Using '+realizer.join_clauses(rules)+', I infer that ' if rules else 'Following those category relationships, I infer that ') + realizer.join_clauses(list(dict.fromkeys(conclusions)))+'.'
        if intermediate:
            body += '\n\nThe reasoning steps are: ' + ' Then '.join(realizer.sentence(t) for t in dict.fromkeys(intermediate))
        if any(row['status'] == 'conflicting' for row in chosen):
            body += ' There is conflicting evidence, so those disputed conclusions are not settled.'
        for gap in self.repo.conn.execute("SELECT * FROM reasoning_gaps WHERE status IN ('open','resolved')"):
            if gap['subject_id'] not in subjects:
                continue
            if gap['status'] == 'open':
                body += ' '+gap['question']+' I have not been given that information.'
            else:
                ids = json.loads(gap['evidence_json'])['providers']
                body += ' The assignment is recorded: '+realizer.join_clauses([realizer.realize_assertion(self.repo, self.repo.assertion(aid)) for aid in ids])+'.'
        return body, {'conclusions': [row['key'] for row in chosen], 'revision': self.revision()}
