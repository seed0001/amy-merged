// selfName: who this companion is, for its own node (it was a fixed "Amy", so James's self in his word-net was Amy).
export function createPersonalWordNet(db, { selfName = () => 'self' } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_links (
      experience INTEGER NOT NULL, source TEXT NOT NULL, relation TEXT NOT NULL,
      target TEXT NOT NULL, strength REAL,
      PRIMARY KEY (experience, source, relation, target)
    );
    CREATE INDEX IF NOT EXISTS personal_links_target ON personal_links(target, relation);
    CREATE TRIGGER IF NOT EXISTS personal_links_forget_message AFTER DELETE ON messages BEGIN
      DELETE FROM personal_links WHERE experience = OLD.id;
      DELETE FROM personal_nodes WHERE id = 'experience:' || OLD.id;
    END;
  `);
  const node = db.prepare('INSERT INTO personal_nodes VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label');
  const edge = db.prepare('INSERT OR IGNORE INTO personal_links VALUES (?, ?, ?, ?, ?)');
  const lookup = db.prepare(`
    SELECT m.id AS experience, m.created_at AS at, p.label AS person, t.label AS topic,
           f.label AS feeling, felt.strength, bond.strength AS affinity,
           substr(m.content,1,240) AS evidence
    FROM personal_links with_person
    JOIN messages m ON m.id = with_person.experience
    JOIN personal_nodes p ON p.id = with_person.target
    JOIN personal_links about ON about.experience = m.id AND about.relation = 'about'
    JOIN personal_nodes t ON t.id = about.target
    LEFT JOIN personal_links felt ON felt.experience = m.id AND felt.relation = 'felt_during'
    LEFT JOIN personal_nodes f ON f.id = felt.target
    LEFT JOIN personal_links bond ON bond.experience = m.id AND bond.relation = 'affinity'
    WHERE with_person.relation = 'with_person' AND m.conversation = ? AND with_person.target = ?
    ORDER BY m.id DESC, felt.strength DESC LIMIT 120
  `);

  return {
    observe({ messageId, personId, person, topic, feelings, affinity }) {
      if (!messageId || !personId || !topic?.name) return;
      const experience = `experience:${messageId}`;
      const contact = `person:${personId}`;
      const subject = `topic:${topic.name.toLowerCase()}`;
      db.exec('SAVEPOINT personal_observation');
      try {
        node.run(experience, 'experience', 'Conversation experience');
        node.run(contact, 'person', person);
        node.run(subject, 'topic', topic.name);
        edge.run(messageId, experience, 'with_person', contact, null);
        edge.run(messageId, experience, 'about', subject, null);
        if (Number.isFinite(affinity)) {
          node.run('self', 'person', selfName());
          edge.run(messageId, 'self', 'affinity', contact, affinity);
        }
        for (const [name, strength] of Object.entries(feelings)) {
          if (!Number.isFinite(strength) || strength <= 0) continue;
          const emotion = `feeling:${name}`;
          node.run(emotion, 'feeling', name);
          edge.run(messageId, experience, 'felt_during', emotion, strength);
        }
        db.exec('RELEASE personal_observation');
      } catch (error) {
        db.exec('ROLLBACK TO personal_observation; RELEASE personal_observation');
        throw error;
      }
    },
    recall(conversation, text, personId) {
      const words = (value) => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
      const query = words(text);
      if (!query.size) return [];
      return lookup.all(conversation, `person:${personId}`).filter((row) =>
        [...words(row.topic)].some((word) => query.has(word)) &&
        row.feeling).slice(0, 5);
    },
  };
}
