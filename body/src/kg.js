// Her knowledge graph, ported from Amy-Voice: how the things she knows connect. Her memories hold
// facts about each person (memory.js); this holds the rest of the picture. Every person, pet, place,
// project, game, thing and idea is a node (a person she knows on Discord is their Discord ID, so a
// garbled or changed name never splits them in two; she herself is "self"). Things carry facts of
// their own ("Rex is a white pit bull"), and links say how nodes connect ("Owner owns Rex",
// "friend_2 is dating Katie", "Owner is making the Lyra game"). People have the other names they go
// by, and the dates that matter to them (birthdays, anniversaries).
//
// Every fact, link, name and date says who told her, where, and when, and carries a meaning-vector,
// so it's found by meaning and she can always say where she got it. Nothing here guesses from
// keywords: what goes in comes from her memory pass (extract.js), grounded in what a person actually
// said; what comes out is found by meaning.

export const SELF = 'self';
export const TYPES = ['person', 'pet', 'place', 'project', 'game', 'thing', 'idea', 'event', 'group', 'work'];
const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };
const SAME = 0.92; // a fact this close to one already on the node is the same fact
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function createGraph(db, { embedder, now = Date.now, selfName = () => 'self', contacts = () => [] } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'thing', aliases TEXT NOT NULL DEFAULT '[]', mentions INTEGER NOT NULL DEFAULT 1, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kg_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, text TEXT NOT NULL, said_by TEXT NOT NULL DEFAULT '', place TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, vec TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kg_links (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, rel TEXT NOT NULL, to_id TEXT NOT NULL, said_by TEXT NOT NULL DEFAULT '', place TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, vec TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kg_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, what TEXT NOT NULL, month INTEGER NOT NULL, day INTEGER NOT NULL, year INTEGER, said_by TEXT NOT NULL DEFAULT '', place TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS kg_facts_node ON kg_facts(node_id);
    CREATE INDEX IF NOT EXISTS kg_links_from ON kg_links(from_id);
    CREATE INDEX IF NOT EXISTS kg_links_to ON kg_links(to_id);
  `);
  const parse = (n) => (n ? { ...n, aliases: JSON.parse(n.aliases) } : null);
  const node = (id) => parse(db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id));
  const nodes = (type) => db.prepare(type ? 'SELECT * FROM kg_nodes WHERE type = ? ORDER BY last_seen DESC' : 'SELECT * FROM kg_nodes ORDER BY last_seen DESC').all(...(type ? [type] : [])).map(parse);

  // Who told her, where and when, on every line she's shown.
  const when = (at) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const tag = (r) => `(${r.said_by ? `${r.said_by} told you` : 'you noticed it yourself'}${r.place ? (/^(while|when) /.test(r.place) ? ` ${r.place}` : ` in ${r.place}`) : ''}, ${when(r.at)})`;

  // A name to the node it means: herself, a person she knows (by name, username or another name they
  // go by), or a node already named that. Exact first, then a clear prefix ("Trav" for Owner).
  function resolve(name) {
    const n = norm(name);
    if (!n) return null;
    if (n === norm(selfName())) return SELF;
    const known = [
      ...contacts().flatMap((c) => [[c.id, c.name], [c.id, c.username]]),
      ...nodes('person').filter((p) => p.id !== SELF).flatMap((p) => [[p.id, p.name], ...p.aliases.map((a) => [p.id, a])]),
    ].filter(([, p]) => norm(p));
    return known.find(([, p]) => norm(p) === n)?.[0]
      ?? known.find(([, p]) => norm(p).length > 2 && n.length > 2 && (norm(p).startsWith(n) || n.startsWith(norm(p))))?.[0]
      ?? (db.prepare('SELECT id FROM kg_nodes WHERE id = ?').get(slug(name))?.id ?? null);
  }

  // Find or make the node for a name.
  function ensure(name, type = 'thing') {
    const clean = String(name ?? '').trim().slice(0, 80);
    if (!/[a-z0-9]/i.test(clean)) return null;
    const at = now();
    const kind = TYPES.includes(type) ? type : 'thing';
    const found = resolve(clean);
    const id = found ?? slug(clean);
    const existing = node(id);
    if (existing) {
      // A vague kind gets sharpened when it's learned ("thing" -> "pet"); a known kind stays.
      db.prepare("UPDATE kg_nodes SET mentions = mentions + 1, last_seen = ?, type = CASE WHEN type = 'thing' AND ? != 'thing' THEN ? ELSE type END WHERE id = ?").run(at, kind, kind, id);
    } else {
      const contact = contacts().find((c) => c.id === id);
      db.prepare('INSERT INTO kg_nodes (id, name, type, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
        .run(id, id === SELF ? selfName() : contact?.name ?? clean, contact || id === SELF ? 'person' : kind, at, at);
    }
    return id;
  }

  const facts = () => db.prepare('SELECT f.*, n.name FROM kg_facts f JOIN kg_nodes n ON n.id = f.node_id').all().map((f) => ({ ...f, vec: JSON.parse(f.vec) }));
  const links = () => db.prepare('SELECT l.*, a.name AS from_name, b.name AS to_name FROM kg_links l JOIN kg_nodes a ON a.id = l.from_id JOIN kg_nodes b ON b.id = l.to_id').all()
    .map((l) => ({ ...l, text: `${l.from_name} ${l.rel} ${l.to_name}`, vec: JSON.parse(l.vec) }));

  // [{ name, type, text, saidBy, place }]: facts on things (people's own facts live in memory.js).
  async function addFacts(list) {
    const fresh = list.map((f) => ({ ...f, text: String(f.text ?? '').trim().slice(0, 240) })).filter((f) => f.text.length > 3 && f.name);
    if (!fresh.length) return [];
    const vecs = await embedder(fresh.map((f) => `${f.name}: ${f.text}`));
    const saved = [];
    fresh.forEach((f, i) => {
      const id = ensure(f.name, f.type);
      if (!id) return;
      const onNode = db.prepare('SELECT vec FROM kg_facts WHERE node_id = ?').all(id).map((r) => JSON.parse(r.vec));
      if (onNode.some((v) => cosine(v, vecs[i]) >= SAME)) return;
      db.prepare('INSERT INTO kg_facts (node_id, text, said_by, place, at, vec) VALUES (?, ?, ?, ?, ?, ?)').run(id, f.text, f.saidBy ?? '', f.place ?? '', now(), JSON.stringify(vecs[i]));
      saved.push({ name: node(id).name, text: f.text });
    });
    return saved;
  }

  // [{ from, fromType, rel, to, toType, saidBy, place }] by name. The same link again just counts up.
  async function addLinks(list) {
    const fresh = list.map((l) => ({ ...l, rel: String(l.rel ?? '').trim().toLowerCase().slice(0, 60) }))
      .map((l) => ({ ...l, a: ensure(l.from, l.fromType), b: ensure(l.to, l.toType) }))
      .filter((l) => l.a && l.b && l.rel && l.a !== l.b);
    if (!fresh.length) return [];
    const vecs = await embedder(fresh.map((l) => `${node(l.a).name} ${l.rel} ${node(l.b).name}`));
    const saved = [];
    fresh.forEach((l, i) => {
      const existing = db.prepare('SELECT id FROM kg_links WHERE from_id = ? AND rel = ? AND to_id = ?').get(l.a, l.rel, l.b);
      if (existing) { db.prepare('UPDATE kg_links SET count = count + 1, at = ? WHERE id = ?').run(now(), existing.id); return; }
      db.prepare('INSERT INTO kg_links (from_id, rel, to_id, said_by, place, at, vec) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.a, l.rel, l.b, l.saidBy ?? '', l.place ?? '', now(), JSON.stringify(vecs[i]));
      saved.push(`${node(l.a).name} ${l.rel} ${node(l.b).name}`);
    });
    return saved;
  }

  // Another name a person goes by. Never her own name, never their own.
  function addAlias(personId, alias) {
    const a = String(alias ?? '').trim().slice(0, 40);
    if (!personId || personId === SELF || a.length < 2 || norm(a) === norm(selfName())) return null;
    const id = ensure(personId, 'person');
    const p = node(id);
    if (norm(a) === norm(p.name) || p.aliases.some((x) => norm(x) === norm(a))) return null;
    db.prepare('UPDATE kg_nodes SET aliases = ? WHERE id = ?').run(JSON.stringify([...p.aliases, a].slice(-6)), id);
    return a;
  }

  // A date that matters to someone: { about (node id or name), what, date: "MM-DD" or "YYYY-MM-DD", saidBy, place }.
  function addDate({ about, what, date, saidBy = '', place = '' }) {
    const m = String(date ?? '').match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
    const w = String(what ?? '').trim().slice(0, 80);
    if (!m || !w) return null;
    const [year, month, day] = [m[1] ? Number(m[1]) : null, Number(m[2]), Number(m[3])];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const id = node(about) ? about : ensure(about, 'person');
    if (!id) return null;
    const same = db.prepare('SELECT id FROM kg_dates WHERE node_id = ? AND month = ? AND day = ?').get(id, month, day);
    if (same) db.prepare('UPDATE kg_dates SET what = ?, year = COALESCE(?, year), said_by = ?, place = ?, at = ? WHERE id = ?').run(w, year, saidBy, place, now(), same.id);
    else db.prepare('INSERT INTO kg_dates (node_id, what, month, day, year, said_by, place, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, w, month, day, year, saidBy, place, now());
    return { name: node(id).name, what: w, date: `${MONTHS[month - 1]} ${day}` };
  }

  // Dates coming up in the next few days (today counts), soonest first.
  function upcoming(days = 7, ids = null) {
    const today = new Date(now()); today.setHours(0, 0, 0, 0);
    return db.prepare('SELECT d.*, n.name FROM kg_dates d JOIN kg_nodes n ON n.id = d.node_id').all()
      .filter((d) => !ids || ids.includes(d.node_id))
      .map((d) => {
        let next = new Date(today.getFullYear(), d.month - 1, d.day);
        if (next < today) next = new Date(today.getFullYear() + 1, d.month - 1, d.day);
        return { ...d, inDays: Math.round((next - today) / 86_400_000), turning: d.year ? next.getFullYear() - d.year : null };
      })
      .filter((d) => d.inDays <= days).sort((a, b) => a.inDays - b.inDays);
  }

  // Everything on one node, as readable lines with where each came from.
  function about(name) {
    const id = resolve(name);
    const n = id && node(id);
    if (!n) return null;
    return {
      id, name: n.name, type: n.type, aliases: n.aliases,
      facts: db.prepare('SELECT * FROM kg_facts WHERE node_id = ? ORDER BY at').all(id).map((f) => ({ id: f.id, text: f.text, from: tag(f) })),
      links: links().filter((l) => l.from_id === id || l.to_id === id).map((l) => ({ id: `L${l.id}`, text: l.text, from: tag(l) })),
      dates: db.prepare('SELECT * FROM kg_dates WHERE node_id = ?').all(id).map((d) => ({ id: `D${d.id}`, text: `${d.what}: ${MONTHS[d.month - 1]} ${d.day}${d.year ? `, ${d.year}` : ''}`, from: tag(d) })),
    };
  }

  // The facts and links that matter most to what's being said, nodes for the people present boosted.
  function relevant(query, { ids = [], min = 0.45, limit = 8 } = {}) {
    const boost = new Set(ids);
    return [...facts().map((f) => ({ ...f, line: `${f.name}: ${f.text}`, ids: [f.node_id] })), ...links().map((l) => ({ ...l, line: l.text, ids: [l.from_id, l.to_id] }))]
      .map((k) => ({ k, score: cosine(query, k.vec) + (k.ids.some((i) => boost.has(i)) ? 0.08 : 0) }))
      .filter((s) => s.score >= min).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.k);
  }

  // Something she was told is wrong: one fact (12), link (L12) or date (D12) by id, or a thing by
  // name with everything on it. Says what went; throws with the reason if nothing matched.
  function forget(what) {
    const s = String(what ?? '').trim();
    const m = s.match(/^([LD]?)(\d+)$/i);
    if (m) {
      const [table, label] = { '': ['kg_facts', 'fact'], L: ['kg_links', 'link'], D: ['kg_dates', 'date'] }[m[1].toUpperCase()];
      const gone = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(m[2])).changes;
      if (!gone) throw new Error(`There's no ${label} ${s} in what you know, so nothing was forgotten. Look it up with about first to get its id.`);
      dropOrphans();
      return [`${label} ${s}`];
    }
    const id = resolve(s);
    const contact = contacts().find((c) => c.id === id);
    if (contact) throw new Error(`${contact.name} is a person you know; forget single facts or links about them by id instead (about shows the ids).`);
    const n = id && id !== SELF ? node(id) : null;
    if (!n) throw new Error(`"${s}" isn't something you have in your knowledge, so nothing was forgotten.`);
    const ties = links().filter((l) => l.from_id === id || l.to_id === id).map((l) => l.text);
    for (const t of ['kg_facts', 'kg_dates']) db.prepare(`DELETE FROM ${t} WHERE node_id = ?`).run(id);
    db.prepare('DELETE FROM kg_links WHERE from_id = ? OR to_id = ?').run(id, id);
    db.prepare('DELETE FROM kg_nodes WHERE id = ?').run(id);
    return [n.name, ...ties];
  }
  // Things left with nothing on them and nothing connecting them are let go.
  function dropOrphans() {
    db.prepare(`DELETE FROM kg_nodes WHERE type != 'person' AND id NOT IN (SELECT node_id FROM kg_facts) AND id NOT IN (SELECT node_id FROM kg_dates)
      AND id NOT IN (SELECT from_id FROM kg_links) AND id NOT IN (SELECT to_id FROM kg_links)`).run();
  }

  // For her prompt: what she knows that connects to what's being said, and dates coming up for the
  // people here. Each line says who told her.
  function promptSection(query, { ids = [] } = {}) {
    const lines = query ? relevant(query, { ids }).map((k) => `- ${k.line} ${tag(k)}`) : [];
    const names = ids.map((id) => node(id)).filter(Boolean).filter((p) => p.aliases.length).map((p) => `- ${p.name} also goes by ${p.aliases.join(', ')}`);
    // Anyone's in the next three days; the people here, a week ahead.
    const near = [...upcoming(7, ids.length ? ids : []), ...upcoming(3)].filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i).sort((a, b) => a.inDays - b.inDays);
    const soon = near.map((d) => `- ${d.name}'s ${d.what} is ${d.inDays === 0 ? 'TODAY' : d.inDays === 1 ? 'tomorrow' : `in ${d.inDays} days`} (${MONTHS[d.month - 1]} ${d.day}${d.turning ? `, turning ${d.turning}` : ''}) ${tag(d)}`);
    return [...lines, ...names, ...soon].join('\n');
  }

  function stats() {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { nodes: count('kg_nodes'), facts: count('kg_facts'), links: count('kg_links'), dates: count('kg_dates') };
  }

  return { resolve, ensure, node, nodes, addFacts, addLinks, addAlias, addDate, upcoming, about, relevant, forget, promptSection, stats };
}
