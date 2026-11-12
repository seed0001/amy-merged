"""Preserve reported causes as evidence-linked claims, never universal rules."""
import json
import re
from dataclasses import asdict, replace
from nlp.parser import parse_sentence, ParseError
from nlp.semantic_frames import Frame
from dialogue import realizer


class Meaning:
    def __init__(self, convo):
        self.c = convo
        self.repo = convo.repo
        self.repo.conn.executescript('''
            CREATE TABLE IF NOT EXISTS meaning_events(
                id INTEGER PRIMARY KEY, utterance_id INTEGER NOT NULL,
                payload TEXT NOT NULL, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS causal_claims(
                id INTEGER PRIMARY KEY, utterance_id INTEGER NOT NULL,
                effect_ids TEXT NOT NULL, cause_ids TEXT NOT NULL,
                confidence REAL NOT NULL, status TEXT NOT NULL DEFAULT 'claimed');
            CREATE TABLE IF NOT EXISTS assertion_provenance(
                assertion_id INTEGER PRIMARY KEY, origin TEXT NOT NULL,
                source_utterance_id INTEGER, context TEXT);
        ''')

    def sync(self):
        with self.repo.conn:
            self.repo.conn.execute('''INSERT OR IGNORE INTO assertion_provenance
                SELECT a.id,CASE WHEN u.speaker='research' THEN 'researched' ELSE 'claimed' END,a.source_utterance_id,u.text FROM assertions a
                JOIN utterances u ON u.id=a.source_utterance_id''')
            for row in self.repo.conn.execute("SELECT * FROM causal_claims WHERE status='claimed'").fetchall():
                ids = json.loads(row['effect_ids']) + json.loads(row['cause_ids'])
                if any(self.repo.assertion(i) is None or self.repo.assertion(i)['status'] != 'active' for i in ids):
                    self.repo.conn.execute("UPDATE causal_claims SET status='withdrawn' WHERE id=?", (row['id'],))

    def learn(self, sentence, uid, item, learned, conflicts):
        if not re.search(r'\bbecause\b', sentence, re.I):
            return False
        if re.match(r'\s*(?:if|whenever|why|does|is|can)\b', sentence, re.I):
            return False
        parts = re.split(r'\bbecause\b', sentence, maxsplit=1, flags=re.I)
        graph = {'relation': 'reported-cause', 'source_utterance_id': uid,
                 'effect': [], 'cause': [], 'unknown': []}
        try:
            left, right = [parse_sentence(part.strip(), self.c.lexicon()) for part in parts]
            if not all(isinstance(f, Frame) and f.act == 'assert' for f in left + right):
                raise ParseError('A cause must connect two factual clauses.')
            # No gender guessing or session-recency binding. A cross-clause object can
            # refer to the single explicit experiencer, provided it is not reflexive.
            subjects = {f.subject.surface: f.subject for f in left if f.subject and f.subject.proper}
            resolved = []
            for frame in right:
                def bind(np):
                    if np is None or isinstance(np, str):
                        return np
                    if np.possessor:
                        return replace(np, possessor=bind(np.possessor))
                    if np.pronoun not in (None, 'i', 'you'):
                        if len(subjects) != 1 or not frame.subject or not frame.subject.proper:
                            raise ParseError("The recipient is unknown. Use the person's name.")
                        target = next(iter(subjects.values()))
                        if target.surface.casefold() == frame.subject.surface.casefold():
                            raise ParseError('The recipient is ambiguous. Use an explicit name.')
                        return target
                    return np
                if frame.subject is None or frame.subject.pronoun not in (None, 'i', 'you'):
                    raise ParseError('The actor is unknown. Use an explicit name.')
                frame = replace(frame, obj=bind(frame.obj), args=tuple((role,bind(value)) for role,value in frame.args))
                resolved.append(frame)
            right = resolved
            for frame in left:
                if frame.subject is None or frame.subject.pronoun not in (None, 'i', 'you'):
                    raise ParseError('The experiencer is unknown. Use an explicit name.')
            for frames, key in ((left, 'effect'), (right, 'cause')):
                for frame in frames:
                    reason = self.c._unlearnable(frame, parts[0 if key == 'effect' else 1].strip())
                    if reason:
                        raise ParseError(reason)
                    graph[key].append(asdict(frame))
        except ParseError as exc:
            graph['unknown'].append(str(exc))
            item['meaning'] = graph
            item['errors'] = [str(exc)]
            self.c.questions.append(str(exc))
            self.repo.conn.execute('INSERT INTO meaning_events(utterance_id,payload,status) VALUES(?,?,?)',
                                   (uid, json.dumps(graph), 'unknown'))
            self.repo.conn.commit()
            return True
        ids = {}
        for key, frames in (('effect', left), ('cause', right)):
            ids[key] = []
            for frame in frames:
                ids[key] += self.c._learn(frame, uid, item, learned, conflicts)
        graph['assertions'] = ids
        item['meaning'] = graph
        with self.repo.conn:
            self.repo.conn.execute('INSERT INTO meaning_events(utterance_id,payload,status) VALUES(?,?,?)',
                                   (uid, json.dumps(graph), 'claimed'))
            if ids['effect'] and ids['cause']:
                confidence = min(f.confidence for f in left + right)
                self.repo.conn.execute('INSERT INTO causal_claims(utterance_id,effect_ids,cause_ids,confidence) VALUES(?,?,?,?)',
                                       (uid, json.dumps(ids['effect']), json.dumps(ids['cause']), confidence))
        return True

    def explain(self, text):
        match = re.fullmatch(r'\s*(?:why (?:is|was)|explain why (?:is|was)) (.+?) (upset|angry|sad|happy|worried)[?.!]*\s*', text, re.I)
        if not match:
            return None
        entity = self.repo.find_entity(match[1])
        prop = self.repo.find_concept(match[2].lower())
        if entity is None or prop is None:
            return None
        self.sync()
        evidence = []
        for row in self.repo.conn.execute("SELECT c.*,u.speaker FROM causal_claims c JOIN utterances u ON u.id=c.utterance_id WHERE c.status='claimed'"):
            effects = [self.repo.assertion(i) for i in json.loads(row['effect_ids'])]
            if not any(r['subj_type']=='e' and r['subj_id']==entity and r['predicate']=='has_property' and r['obj_id']==prop and r['polarity'] for r in effects):
                continue
            cause = [realizer.realize_assertion(self.repo, self.repo.assertion(i)) for i in json.loads(row['cause_ids'])]
            evidence.append((row, cause))
        if not evidence:
            return 'I have no active reported cause for that emotion. What happened?', {'status':'unknown'}
        paragraphs = [row['speaker'] + ' told me that ' + match[1] + ' is ' + match[2].lower() + ' because ' + realizer.join_clauses(cause) + '.' for row,cause in evidence]
        from reasoning.engine import query_from_row
        from reasoning.proofs import CONFLICTING
        disputed = any(self.c.engine.ask(query_from_row(self.repo, self.repo.assertion(i))).status == CONFLICTING
                       for row,_ in evidence for i in json.loads(row['effect_ids']) + json.loads(row['cause_ids']))
        if disputed:
            paragraphs.append('There is conflicting evidence about this account, so its cause is disputed.')
        derived = self.c.reasoning.answer('Explain ' + match[1])
        if derived and not disputed:
            paragraphs.append(derived[0])
        paragraphs.append('That preserves who acted, who was affected, and the reason reported to me. It is a sourced account, not independent evidence of anyone\'s intentions or a general rule about their relationship.')
        return '\n\n'.join(paragraphs), {'status':'claimed', 'utterances':[row['utterance_id'] for row,_ in evidence]}
