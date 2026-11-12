import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, upFind } from './config.js';

let db;
export function lookupWordNet(word) {
  const lemma = String(word ?? '').trim().replaceAll(' ', '_');
  if (!/^[a-z][a-z_' -]{0,59}$/i.test(lemma)) return [];
  const file = [process.env.CHAMP_WORDNET_DB, path.join(DATA_DIR, 'wordnet', 'wordnet.db'),
    path.join(ROOT, '..', 'Amy', 'data', 'wordnet', 'wordnet.db'), upFind(path.join('Amy', 'data', 'wordnet', 'wordnet.db'))].find((candidate) => candidate && existsSync(candidate));
  if (!file) return [];
  db ??= new DatabaseSync(file, { readOnly: true });
  const senses = db.prepare(`SELECT s.synset AS id, s.pos, n.definition FROM senses s
    JOIN synsets n ON n.id = s.synset WHERE s.lemma IN (?, ?) ORDER BY s.rank LIMIT 4`)
    .all(lemma, lemma.replaceAll('_', ' '));
  const edges = db.prepare(`SELECT e.relation, e.target,
    (SELECT lemma FROM senses WHERE synset = e.target ORDER BY rank LIMIT 1) AS word
    FROM edges e WHERE e.source = ? LIMIT 6`);
  return senses.map((sense) => ({ ...sense, relations: edges.all(sense.id) }));
}

export function lexicalContext(text) {
  const match = /\b(?:define|meaning of|synonyms? (?:of|for)|what does)\s+["']?([a-z][a-z-]*)/i.exec(text);
  return match ? lookupWordNet(match[1]) : [];
}
