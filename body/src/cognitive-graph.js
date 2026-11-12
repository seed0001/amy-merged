import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

// Her mind as one graph, for the mind view (dashboard/public/mind.html and node.html). This is a READ
// MODEL: it never keeps its own copy of her state. Every build asks the modules that own each part of her
// (kg.js, personal-wordnet.js, memory.js, interests.js, reflections.js, pressure.js, emotion.js,
// avatar-state.js, tools.js, discoveries.js) what is there right now, and turns it into nodes and edges.
// Every node says where it came from (provenance: source, when, who) and every edge says which record
// makes it (origin). Nothing is invented for display: a link with a missing end is dropped and counted,
// a part that can't be read is listed as unavailable with the reason.
//
// What it keeps on disk (all under the data folder, all part of who she is, so a rebirth/wipe clears them):
//   mind-seed.json       her per-instance seed: the same graph lays out the same way, another instance differently
//   mind-structure.json  the last structure seen (node ids, edge keys and strengths), to tell what grew
//   mind-history.jsonl   the structural change log: nodes and edges added, removed, strengthened, weakened
//   mind-edits.jsonl     live edits made from the mind view, with before/after, for undo
//
// Node ids are "kind:id". Kinds: person, concept, memory, experience, interest, goal, insight, bucket, act, body.

export const KINDS = ['person', 'concept', 'memory', 'experience', 'interest', 'goal', 'insight', 'bucket', 'act', 'body'];
export const KIND_LABEL = {
  person: 'people', concept: 'concepts', memory: 'memories', experience: 'experiences', interest: 'interests',
  goal: 'goals', insight: 'insights', bucket: 'pressure', act: 'acts', body: 'body',
};
export const FILES = {
  seed: 'mind-seed.json', structure: 'mind-structure.json', history: 'mind-history.jsonl', edits: 'mind-edits.jsonl',
};

// An error that says what failed, why, and how to fix it, with an HTTP status for the dashboard.
const fail = (status, what, why, fix) => Object.assign(new Error(`${what}: ${why}. ${fix}`), { status });

// ---------- deterministic randomness ----------
export function hash32(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h >>> 0;
}
export function rng(seedText) {
  let a = hash32(seedText);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- assembly: her real systems into nodes and edges ----------

// Each source is read on its own; one that throws is reported (what and why), never papered over.
function read(unavailable, name, fn, fallback) {
  try {
    const out = fn?.();
    return out ?? fallback;
  } catch (err) {
    unavailable.push({ source: name, error: `${name} couldn't be read: ${err.message}` });
    return fallback;
  }
}

const personalToGraph = (id) => {
  const s = String(id);
  if (s === 'self') return 'person:self';
  if (s.startsWith('person:')) return s;
  if (s.startsWith('topic:')) return `concept:${s}`;
  if (s.startsWith('feeling:')) return `body:${s}`;
  if (s.startsWith('experience:')) return s;
  return `concept:personal:${s}`;
};
const short = (text, n = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const edgeKey = (e) => `${e.from}|${e.type}|${e.to}`;

// Paths of pressure tunables shown as editable on a node; pressure.setConfigValue is the authority that
// validates them. min/max here are hints for the inspector's inputs.
const BUCKET_FIELDS = ['threshold', 'fill_rate', 'decay_rate', 'drain', 'hysteresis'];
const RESERVE_FIELDS = ['store_share', 'reserve_use', 'overheard_uptake'];

// The mind-view node for a thing her brain knows of (brain-mind.js): herself, a person (the Discord contact of the
// same name when there is one), or a thing. contactByName: lower-cased name -> "person:<discord id>".
export function brainNodeId(thing, contactByName = new Map()) {
  if (thing.self) return 'person:self';
  if (thing.person) return contactByName.get(String(thing.name).toLowerCase()) ?? `person:brain:${thing.key}`;
  return `concept:brain:${thing.key}`;
}

export function assemble(sources = {}, { now = Date.now } = {}) {
  const unavailable = [];
  const nodes = new Map();
  const edges = new Map();
  const dropped = { count: 0, examples: [] };

  const addNode = (id, kind, label, provenance, data = {}) => {
    const existing = nodes.get(id);
    if (existing) {
      // Same thing seen by another module: keep the first provenance, record the other, merge its data.
      existing.data = { ...data, ...existing.data };
      if (!existing.alsoFrom.some((p) => p.source === provenance.source)) existing.alsoFrom.push(provenance);
      if ((!existing.label || existing.label === existing.id) && label) existing.label = label;
      return existing;
    }
    const node = { id, kind, label: short(label || id, 80), provenance: clean(provenance), data, alsoFrom: [] };
    nodes.set(id, node);
    return node;
  };
  const pending = [];
  const addEdge = (from, to, type, strength, origin, extra = {}) => pending.push({ from, to, type, strength: Number(strength) || 0, origin: clean(origin), ...extra });

  const selfName = read(unavailable, 'selfName', sources.selfName, 'self'); // the live source is config.botName

  // People: contacts (memory.js), plus herself.
  const contacts = read(unavailable, 'contacts (memory.js)', sources.contacts, []);
  for (const c of contacts) {
    addNode(`person:${c.user_id}`, 'person', c.name, { source: 'memory.js contacts', at: c.first_seen },
      { name: c.name, username: c.username ?? null, tier: c.tier ?? null, lastSeen: c.last_seen ?? null, discordId: c.user_id });
  }
  addNode('person:self', 'person', selfName, { source: 'kg.js SELF (herself)' }, { self: true });

  // Her knowledge graph (kg.js): people and things, with the facts on them and how they connect.
  const kg = read(unavailable, 'knowledge graph (kg.js)', sources.kg, { nodes: [], links: [], facts: [] });
  const factsByNode = new Map();
  for (const f of kg.facts ?? []) (factsByNode.get(f.node_id) ?? factsByNode.set(f.node_id, []).get(f.node_id)).push(f);
  // A kg id is a person when kg.js says so, or when it is the Discord id of someone she knows (contacts).
  const kgId = (id, type) => (id === 'self' ? 'person:self' : type === 'person' || (type === undefined && nodes.has(`person:${id}`)) ? `person:${id}` : `concept:${id}`);
  const kgTypes = new Map((kg.nodes ?? []).map((n) => [n.id, n.type]));
  for (const n of kg.nodes ?? []) {
    const facts = (factsByNode.get(n.id) ?? []).sort((a, b) => a.at - b.at);
    addNode(kgId(n.id, n.type), n.type === 'person' || n.id === 'self' ? 'person' : 'concept', n.name,
      { source: 'kg.js kg_nodes', at: n.first_seen, by: facts[0]?.said_by || undefined },
      { kgId: n.id, type: n.type, aliases: n.aliases ?? [], mentions: n.mentions, lastSeen: n.last_seen, facts: facts.length });
  }
  for (const l of kg.links ?? []) {
    addEdge(kgId(l.from_id, kgTypes.get(l.from_id)), kgId(l.to_id, kgTypes.get(l.to_id)), l.rel, l.count ?? 1,
      { source: 'kg.js kg_links', ref: `L${l.id}`, by: l.said_by || undefined, place: l.place || undefined, at: l.at });
  }

  // Her personal word-net (personal-wordnet.js): each conversation experience, who it was with, what
  // it was about, what she felt during it, and her affinity for the person.
  const personal = read(unavailable, 'personal word-net (personal-wordnet.js)', sources.personal, { nodes: [], links: [], experiences: [] });
  const expInfo = new Map((personal.experiences ?? []).map((m) => [`experience:${m.id}`, m]));
  for (const n of personal.nodes ?? []) {
    const id = personalToGraph(n.id);
    if (n.kind === 'experience') {
      const m = expInfo.get(n.id);
      addNode(id, 'experience', m ? `${m.name ?? 'someone'}, ${new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')}` : n.label,
        { source: 'personal-wordnet.js personal_nodes', at: m?.created_at, by: m?.name ?? undefined },
        { messageId: Number(String(n.id).split(':')[1]), conversation: m?.conversation ?? null, evidence: m?.evidence ?? null });
    } else if (n.kind === 'feeling') {
      addNode(id, 'body', n.label, { source: 'personal-wordnet.js personal_nodes' }, { feeling: n.label, group: 'feeling' });
    } else if (n.kind === 'person') {
      addNode(id, 'person', n.label, { source: 'personal-wordnet.js personal_nodes' }, { name: n.label });
    } else {
      addNode(id, 'concept', n.label, { source: 'personal-wordnet.js personal_nodes' }, { type: n.kind });
    }
  }
  const affinity = new Map();
  for (const l of personal.links ?? []) {
    const from = personalToGraph(l.source), to = personalToGraph(l.target);
    const at = expInfo.get(`experience:${l.experience}`)?.created_at;
    if (l.relation === 'affinity') {
      // One affinity edge per person: the latest reading, from the latest experience.
      const prev = affinity.get(to);
      if (!prev || l.experience > prev.experience) affinity.set(to, { ...l, from, to, at });
      continue;
    }
    addEdge(from, to, l.relation, l.strength ?? 1, { source: 'personal-wordnet.js personal_links', ref: `experience:${l.experience}`, at });
  }
  for (const a of affinity.values()) {
    addEdge(a.from, a.to, 'affinity', a.strength ?? 0, { source: 'personal-wordnet.js personal_links (latest affinity)', ref: `experience:${a.experience}`, at: a.at }, { live: true });
  }

  // Memories (memory.js): what she remembers about each person.
  const memories = read(unavailable, 'memories (memory.js)', sources.memories, []);
  const memoryNames = read(unavailable, 'memory names (memory.js)', sources.memoryNames, {});
  for (const m of memories) {
    const person = `person:${m.user_id}`;
    if (!nodes.has(person)) addNode(person, 'person', memoryNames[m.user_id] ?? m.user_id, { source: 'memory.js memories (no contact row)', at: m.created_at }, { discordId: m.user_id });
    addNode(`memory:${m.id}`, 'memory', m.content, { source: 'memory.js memories', at: m.created_at, by: memoryNames[m.user_id] ?? m.user_id }, { text: m.content, userId: m.user_id });
    addEdge(`memory:${m.id}`, person, 'about', 1, { source: 'memory.js memories', ref: `memory ${m.id}`, at: m.created_at });
  }

  // Her own brain (brain-mind.js; config.brain === 'amy', no language model): what the Python Amy holds. Every thing
  // she knows of is a node, every fact is a link between two of them saying who told her, and every rule she learned
  // is an insight tied to what it is about. A fact about one thing alone ("friend_3 does not know") has nothing to link
  // to, so it hangs on that thing as a memory. A person she knows by the same name as a Discord contact is that contact.
  const brainMind = read(unavailable, 'her brain (brain-mind.js)', sources.brain, null);
  if (brainMind) {
    const when = (text) => (text ? Date.parse(`${String(text).replace(' ', 'T')}Z`) || undefined : undefined);
    const contactByName = new Map(contacts.map((c) => [String(c.name ?? '').toLowerCase(), `person:${c.user_id}`]));
    const idOf = new Map();
    for (const t of brainMind.things ?? []) {
      const person = t.self || t.person;
      const id = brainNodeId(t, contactByName);
      idOf.set(t.key, id);
      addNode(id, person ? 'person' : 'concept', t.name, { source: 'her brain (things she knows of)', at: when(t.at) }, { brainKey: t.key, named: Boolean(t.named), ...(t.self && { self: true }) });
    }
    for (const f of brainMind.facts ?? []) {
      const from = idOf.get(f.from), to = idOf.get(f.to);
      const origin = { source: 'her brain (a fact she holds)', ref: `fact ${f.id}: ${f.text ?? f.relation}`, by: f.said_by ?? undefined, at: when(f.at) };
      if (from && to) addEdge(from, to, f.relation, f.confidence ?? 1, origin, { fact: f.id, ...(f.denied && { denied: true }) });
      else if (from) {
        addNode(`memory:brain:${f.id}`, 'memory', f.text ?? f.relation, { source: 'her brain (a fact she holds)', at: when(f.at), by: f.said_by ?? undefined }, { text: f.text, confidence: f.confidence, denied: Boolean(f.denied) });
        addEdge(`memory:brain:${f.id}`, from, 'about', f.confidence ?? 1, origin);
      }
    }
    for (const r of brainMind.rules ?? []) {
      const id = `insight:brain:rule:${r.id}`;
      addNode(id, 'insight', r.text ?? `rule ${r.id}`, { source: 'her brain (a rule she learned)' }, { text: r.text, confidence: r.confidence, status: r.status, rule: r.id });
      for (const key of r.terms ?? []) if (idOf.get(key)) addEdge(id, idOf.get(key), 'about', r.confidence ?? 1, { source: 'her brain (a rule she learned)', ref: `rule ${r.id}` });
    }
  }

  // Interests (interests.js): what she's into, how much, and who it came up with.
  const interests = read(unavailable, 'interests (interests.js)', sources.interests, []);
  const resolvePerson = (name) => {
    try { return sources.resolvePerson?.(name) ?? null; } catch { return null; }
  };
  for (const t of interests) {
    const id = `interest:${String(t.name).toLowerCase()}`;
    const people = Object.entries(t.people ?? {}).sort((a, b) => b[1] - a[1]);
    addNode(id, 'interest', t.name, { source: 'interests.js interests.json', at: t.last, by: people[0]?.[0] },
      { interest: t.interest, mentions: t.mentions, sources: t.sources ?? {}, people: Object.fromEntries(people), retired: Boolean(t.retired) });
    for (const [name, count] of people) {
      const pid = resolvePerson(name);
      if (pid) addEdge(id, pid === 'self' ? 'person:self' : `person:${pid}`, 'came up with', count, { source: 'interests.js people', by: name, at: t.last });
    }
    // The same topic tag (topics.js) also recorded in her personal word-net: one topic, two records.
    addEdge(id, `concept:topic:${String(t.name).toLowerCase()}`, 'same topic', 1, { source: 'topics.js tag recorded by interests.js and personal-wordnet.js' }, { optional: true });
    addEdge(id, 'bucket:explore', 'pulls', t.interest ?? 0, { source: 'pressure.js explore bucket (fills toward her strongest interests)', at: t.last }, { optional: true });
  }

  // Goals and insights (reflections.js), and the experiences her goals produced.
  const refl = read(unavailable, 'goals (reflections.js)', sources.reflections, { items: [], experiences: [] });
  for (const item of refl.items ?? []) {
    const kind = item.kind === 'goal' ? 'goal' : 'insight';
    const status = item.done ? 'done' : item.dropped ? 'dropped' : item.paused ? 'paused' : 'open';
    addNode(`${kind}:${item.id}`, kind, item.text, { source: 'reflections.js reflections.json', at: item.at, by: selfName },
      { text: item.text, status, activity: item.activity ?? null, criteria: item.criteria ?? null, bucket: item.bucket ?? null,
        progress: item.progress?.length ?? 0, dropReason: item.dropReason ?? null, previousGoal: item.previousGoal ?? null });
    if (kind === 'goal' && item.bucket) addEdge(`goal:${item.id}`, `bucket:${item.bucket}`, 'driven by', 1, { source: 'reflections.js goal.bucket', at: item.at });
    if (item.previousGoal) addEdge(`goal:${item.id}`, `goal:${item.previousGoal}`, 'pivoted from', 1, { source: 'reflections.js goal.previousGoal', at: item.at });
  }
  for (const e of refl.experiences ?? []) {
    const id = `experience:goal-${e.id}`;
    addNode(id, 'experience', e.summary || e.goalText || `goal ${e.goalId} ${e.outcome ?? ''}`, { source: 'reflections.js experiences', at: e.at, by: selfName },
      { goalId: e.goalId, outcome: e.outcome ?? null, summary: e.summary ?? e.reason ?? null, satisfaction: e.satisfaction ?? null, evidence: e.evidence ?? null });
    addEdge(id, `goal:${e.goalId}`, 'for goal', 1, { source: 'reflections.js experiences', at: e.at });
  }

  // Pressure (pressure.js): every bucket, the reserve, and the flows, couplings and seeds between them.
  const pressure = read(unavailable, 'pressure (pressure.js)', sources.pressure, null);
  if (pressure?.cfg) {
    const { cfg, state = {} } = pressure;
    const feelings = new Set(Object.keys(cfg.feelings?.tau ?? {}));
    const names = [...new Set([...Object.keys(cfg.buckets ?? {}), ...Object.keys(state.buckets ?? {}), ...feelings])].sort();
    const at = pressure.configAt;
    for (const name of names) {
      const b = cfg.buckets?.[name];
      const layer = pressure.layerOf ? pressure.layerOf(name) ?? null : null;
      const editable = b ? [
        ...BUCKET_FIELDS.filter((f) => typeof b[f] === 'number').map((f) => ({ module: 'pressure', path: `buckets.${name}.${f}`, value: b[f], type: 'number', min: 0, max: 1, label: f.replace(/_/g, ' ') })),
        ...(typeof b.enabled === 'boolean' ? [{ module: 'pressure', path: `buckets.${name}.enabled`, value: b.enabled, type: 'boolean', label: 'enabled' }] : []),
      ] : [];
      (cfg.flows ?? []).forEach(([from, to, rate], i) => {
        if (from === name && typeof rate === 'number') editable.push({ module: 'pressure', path: `flows.${i}.2`, value: rate, type: 'number', min: 0, max: 1, label: `flow rate to ${to}` });
      });
      (cfg.flow?.couplings ?? []).forEach(([from, to, rate], i) => {
        if (from === name && typeof rate === 'number') editable.push({ module: 'pressure', path: `flow.couplings.${i}.2`, value: rate, type: 'number', min: -1, max: 1, label: `coupling to ${to} (per second)` });
      });
      for (const [to, v] of Object.entries(cfg.seeds?.[name] ?? {})) {
        if (typeof v === 'number') editable.push({ module: 'pressure', path: `seeds.${name}.${to}`, value: v, type: 'number', min: -1, max: 1, label: `seed into ${to} when it fires` });
      }
      addNode(`bucket:${name}`, 'bucket', name.replace(/_/g, ' '), { source: b ? 'pressure.js cfg.buckets' : feelings.has(name) ? 'pressure.js cfg.feelings' : 'pressure.js state.buckets', at, by: 'pressure-config.json' },
        { bucket: name, value: state.buckets?.[name] ?? null, threshold: b?.threshold ?? null, enabled: b?.enabled ?? null, config: b ?? null,
          feeling: feelings.has(name), label: pressure.labels?.[name] ?? null, layer,
          layerNote: pressure.layerOf ? null : 'pressure.js keeps its layers (needs/desires/outcomes/budget) in an unexported LAYER table, so the layer is not shown',
          editable });
    }
    const reserveEditable = [
      ...RESERVE_FIELDS.filter((f) => typeof cfg[f] === 'number').map((f) => ({ module: 'pressure', path: f, value: cfg[f], type: 'number', min: 0, max: 1, label: f.replace(/_/g, ' ') })),
      ...Object.entries(cfg.priority ?? {}).filter(([, v]) => typeof v === 'number').map(([layer, v]) => ({ module: 'pressure', path: `priority.${layer}`, value: v, type: 'number', min: 0, max: 2, label: `priority of ${layer}` })),
    ];
    addNode('bucket:reserve', 'bucket', 'reserve (stored energy)', { source: 'pressure.js state.reserve', at, by: 'pressure-config.json' },
      { bucket: 'reserve', value: state.reserve ?? 0, reserve: true, editable: reserveEditable });
    (cfg.flows ?? []).forEach(([from, to, rate], i) => addEdge(`bucket:${from}`, `bucket:${to}`, 'flow', rate, { source: 'pressure.js cfg.flows', ref: `flows.${i}` }));
    (cfg.flow?.couplings ?? []).forEach(([from, to, rate], i) => addEdge(`bucket:${from}`, `bucket:${to}`, 'coupling', rate, { source: 'pressure.js cfg.flow.couplings', ref: `flow.couplings.${i}` }));
    for (const [from, targets] of Object.entries(cfg.seeds ?? {})) {
      for (const [to, v] of Object.entries(targets ?? {})) addEdge(`bucket:${from}`, `bucket:${to}`, 'seeds', v, { source: 'pressure.js cfg.seeds', ref: `seeds.${from}.${to}` });
    }
    for (const [id, p] of Object.entries(state.loneliness ?? {})) {
      addEdge(`person:${id}`, 'bucket:loneliness', 'missed', p?.value ?? 0, { source: 'pressure.js state.loneliness', by: p?.name }, { live: true });
    }
    for (const name of pressure.research ?? []) addEdge(`bucket:${name}`, 'act:research', 'fires', 1, { source: 'pressure.js RESEARCH (fires a research pass)' }, { optional: true });
    // What acting costs her, from the reserve.
    for (const [tool, cost] of Object.entries(cfg.action_costs ?? {})) {
      const parts = typeof cost === 'number' ? [[null, cost]] : Object.entries(cost ?? {});
      for (const [action, c] of parts) addEdge(`act:${tool}`, 'bucket:reserve', action ? `costs (${action})` : 'costs', c, { source: 'pressure.js cfg.action_costs', ref: action ? `action_costs.${tool}.${action}` : `action_costs.${tool}` });
    }
  }

  // Acts: her tools (tools.js) and anything with an action cost, with when she first used it (discoveries.js).
  const tools = read(unavailable, 'tools (tools.js)', sources.tools, []);
  const tried = read(unavailable, 'discoveries (discoveries.js)', sources.discoveries, {})?.tried ?? {};
  const costs = pressure?.cfg?.action_costs ?? {};
  const actNames = [...new Set([...tools.map((t) => t.name), ...Object.keys(costs)])].sort();
  const toolInfo = new Map(tools.map((t) => [t.name, t]));
  for (const name of actNames) {
    const cost = costs[name];
    const editable = typeof cost === 'number'
      ? [{ module: 'pressure', path: `action_costs.${name}`, value: cost, type: 'number', min: 0, max: 10, label: 'energy cost' }]
      : Object.entries(cost ?? {}).filter(([, v]) => typeof v === 'number').map(([a, v]) => ({ module: 'pressure', path: `action_costs.${name}.${a}`, value: v, type: 'number', min: 0, max: 10, label: `energy cost of ${a}` }));
    addNode(`act:${name}`, 'act', name.replace(/_/g, ' '),
      { source: toolInfo.has(name) ? 'tools.js TOOLS' : 'pressure.js cfg.action_costs', at: tried[name] },
      { tool: name, description: toolInfo.get(name)?.description ?? null, cost: cost ?? null, firstUsed: tried[name] ?? null, editable });
  }

  // Body (emotion.js, microexpression.js, avatar-state.js) and the live channels the avatar stream carries.
  const body = read(unavailable, 'body (emotion.js / avatar-state.js)', sources.body, null);
  if (body) {
    for (const [name, description] of Object.entries(body.emotions ?? {})) {
      addNode(`body:feeling:${name}`, 'body', name, { source: 'emotion.js EMOTIONS' },
        { feeling: name, group: 'feeling', description, value: body.feelings?.[name] ?? 0, valueSource: 'microexpression.js expressionState(main)' });
    }
    for (const field of body.appearanceFields ?? []) {
      addNode(`body:appearance:${field}`, 'body', field, { source: 'avatar-state.js', at: body.appearance?.updatedAt, by: body.appearance?.updatedAt ? 'saved override' : undefined },
        { control: field, group: 'appearance', value: body.appearance?.[field] ?? null,
          editable: [{ module: 'avatar', path: field, value: body.appearance?.[field] ?? null, type: 'color', label: `${field} colour (#RRGGBB, a colour name, or none)` }] });
    }
  }
  for (const [ctl, why] of [
    ['mouth', 'Her mouth frames arrive with each spoken line on the avatar live stream; no level is stored between lines.'],
    ['blink', 'Blinks are timed inside the Studio page (avatar.js) and only reported as counts through /api/avatar/beat; there is no stored value to show or edit.'],
    ['glance', 'Glances are timed inside the Studio page (avatar.js) and only reported as counts through /api/avatar/beat; there is no stored value to show or edit.'],
  ]) addNode(`body:${ctl}`, 'body', ctl, { source: '/api/avatar/live stream' }, { control: ctl, group: 'live', readOnly: why });

  // Edges only between nodes that exist: a link to something missing is dropped and counted, never filled in.
  for (const e of pending) {
    if (e.from === e.to) continue; // a link from a thing to itself draws nothing
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      if (e.optional) continue; // a join between two records (same topic, a bucket that's off); absent means no link
      dropped.count++;
      if (dropped.examples.length < 8) dropped.examples.push(`${e.from} -${e.type}-> ${e.to} (${e.origin?.source})`);
      continue;
    }
    const key = edgeKey(e);
    const prev = edges.get(key);
    if (prev) { prev.strength += e.strength; continue; }
    edges.set(key, e);
  }

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edgeList = [...edges.values()].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));
  return index({ nodes: nodeList, edges: edgeList, unavailable, dropped, builtAt: now() });
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function index(g) {
  g.byId = new Map(g.nodes.map((n, i) => [n.id, i]));
  g.adj = g.nodes.map(() => []);
  g.edges.forEach((e, i) => { g.adj[g.byId.get(e.from)].push(i); g.adj[g.byId.get(e.to)].push(i); });
  const h = createHash('sha1');
  for (const n of g.nodes) h.update(`${n.id}=${n.label}\n`);
  for (const e of g.edges) h.update(`${edgeKey(e)}=${e.live ? '' : e.strength.toFixed(3)}\n`);
  g.signature = h.digest('hex').slice(0, 16);
  g.counts = { nodes: g.nodes.length, edges: g.edges.length, byKind: Object.fromEntries(KINDS.map((k) => [k, g.nodes.filter((n) => n.kind === k).length])) };
  return g;
}

// ---------- layout: deterministic from (graph, seed) ----------

// A seeded force layout. Each kind gets an anchor placed by the seed (so two instances grow differently
// shaped minds), every node starts at a seeded spot near its anchor, then springs along real edges,
// local repulsion (grid-hashed, so thousands of nodes stay fast) and a weak pull to the anchor settle it.
// Same graph + same seed = same positions; a new node or edge changes the shape.
export function layout(g, seed) {
  const n = g.nodes.length;
  const pos = new Float64Array(n * 3);
  const anchors = {};
  for (const kind of KINDS) {
    const r = rng(`${seed}|anchor|${kind}`);
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), rad = 0.45 + 0.4 * r();
    anchors[kind] = [Math.cos(th) * s * rad * 1.3, u * rad * 0.9, Math.sin(th) * s * rad];
  }
  for (let i = 0; i < n; i++) {
    const node = g.nodes[i], r = rng(`${seed}|${node.id}`), a = anchors[node.kind] ?? [0, 0, 0];
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), rad = 0.35 * Math.cbrt(r());
    pos[i * 3] = a[0] + Math.cos(th) * s * rad; pos[i * 3 + 1] = a[1] + u * rad; pos[i * 3 + 2] = a[2] + Math.sin(th) * s * rad;
  }
  const L = Math.max(0.025, 0.5 / Math.cbrt(Math.max(1, n)));
  const iterations = n < 1500 ? 80 : n < 6000 ? 40 : 20;
  const disp = new Float64Array(n * 3);
  const weight = (e) => Math.min(1, 0.25 + Math.log1p(Math.abs(e.strength)) * 0.5);
  const edgeIdx = g.edges.map((e) => [g.byId.get(e.from), g.byId.get(e.to), weight(e)]);
  let temp = 0.08;
  const cellSize = L * 2.5;
  const PER_CELL = 24;
  for (let it = 0; it < iterations; it++) {
    disp.fill(0);
    // repulsion within each cell and its neighbours (each pair once)
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(pos[i * 3] / cellSize)},${Math.floor(pos[i * 3 + 1] / cellSize)},${Math.floor(pos[i * 3 + 2] / cellSize)}`;
      const cell = grid.get(k);
      if (cell) { if (cell.length < PER_CELL) cell.push(i); } else grid.set(k, [i]);
    }
    for (const [k, cell] of grid) {
      const [cx, cy, cz] = k.split(',').map(Number);
      for (let dx = 0; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && (dy < 0 || (dy === 0 && dz < 0))) continue; // half the neighbourhood: each pair of cells once
        const other = dx === 0 && dy === 0 && dz === 0 ? cell : grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!other) continue;
        for (let a = 0; a < cell.length; a++) {
          const i = cell[a];
          for (let b = other === cell ? a + 1 : 0; b < other.length; b++) {
            const j = other[b];
            let ex = pos[i * 3] - pos[j * 3], ey = pos[i * 3 + 1] - pos[j * 3 + 1], ez = pos[i * 3 + 2] - pos[j * 3 + 2];
            let d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < 1e-10) { ex = ((i * 31 + j) % 7 - 3) * 1e-4; ey = ((i + j * 17) % 5 - 2) * 1e-4; ez = 1e-4; d2 = ex * ex + ey * ey + ez * ez; }
            const f = (L * L) / d2 * 0.5;
            disp[i * 3] += ex * f; disp[i * 3 + 1] += ey * f; disp[i * 3 + 2] += ez * f;
            disp[j * 3] -= ex * f; disp[j * 3 + 1] -= ey * f; disp[j * 3 + 2] -= ez * f;
          }
        }
      }
    }
    // springs along real edges
    for (const [i, j, w] of edgeIdx) {
      const ex = pos[j * 3] - pos[i * 3], ey = pos[j * 3 + 1] - pos[i * 3 + 1], ez = pos[j * 3 + 2] - pos[i * 3 + 2];
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6;
      const f = ((d - L) / d) * 0.3 * w;
      disp[i * 3] += ex * f; disp[i * 3 + 1] += ey * f; disp[i * 3 + 2] += ez * f;
      disp[j * 3] -= ex * f; disp[j * 3 + 1] -= ey * f; disp[j * 3 + 2] -= ez * f;
    }
    // a weak pull home, and a step capped by the temperature
    for (let i = 0; i < n; i++) {
      const a = anchors[g.nodes[i].kind] ?? [0, 0, 0];
      for (let c = 0; c < 3; c++) disp[i * 3 + c] += (a[c] - pos[i * 3 + c]) * 0.02;
      const dl = Math.hypot(disp[i * 3], disp[i * 3 + 1], disp[i * 3 + 2]);
      if (dl > 0) { const s = Math.min(dl, temp) / dl; for (let c = 0; c < 3; c++) pos[i * 3 + c] += disp[i * 3 + c] * s; }
    }
    temp *= 0.95;
  }
  // centre and scale so most of her fits a radius of 1.2
  const out = new Map();
  if (!n) return out;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / n;
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]));
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor((n - 1) * 0.95)] || 1;
  const scale = 1.2 / r95;
  for (let i = 0; i < n; i++) {
    out.set(g.nodes[i].id, [0, 1, 2].map((k) => Math.round((pos[i * 3 + k] - c[k]) * scale * 1e4) / 1e4));
  }
  return out;
}

// ---------- clustering: what the zoomed-out view shows ----------

// Communities by seeded label propagation over the real edges, split by kind. Small groups fold into one
// "loose" cluster per kind. Cluster edges are sums of the member edges they stand for.
export function cluster(g, seed, positions, { minSize = 3 } = {}) {
  const n = g.nodes.length;
  const label = g.nodes.map((node) => node.id);
  const order = [...g.nodes.keys()].sort((a, b) => hash32(`${seed}|order|${g.nodes[a].id}`) - hash32(`${seed}|order|${g.nodes[b].id}`) || a - b);
  for (let round = 0; round < 8; round++) {
    let changed = 0;
    for (const i of order) {
      const votes = new Map();
      for (const ei of g.adj[i]) {
        const e = g.edges[ei];
        const j = g.byId.get(e.from === g.nodes[i].id ? e.to : e.from);
        votes.set(label[j], (votes.get(label[j]) ?? 0) + Math.min(1, 0.25 + Math.log1p(Math.abs(e.strength)) * 0.5));
      }
      let best = label[i], bestV = -1;
      for (const [l, v] of votes) if (v > bestV || (v === bestV && l < best)) { best = l; bestV = v; }
      if (best !== label[i]) { label[i] = best; changed++; }
    }
    if (!changed) break;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${g.nodes[i].kind}|${label[i]}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(i);
  }
  const clusterOf = new Array(n);
  const clusters = new Map();
  for (const [key, members] of groups) {
    const kind = key.split('|')[0];
    const rep = label[members[0]];
    const id = members.length >= minSize ? `cluster:${kind}:${rep}` : `cluster:${kind}:loose`;
    let c = clusters.get(id);
    if (!c) {
      const repNode = g.nodes[g.byId.get(rep)];
      c = { id, kind, label: members.length >= minSize ? `${KIND_LABEL[kind]} around ${repNode?.label ?? rep}` : `other ${KIND_LABEL[kind]}`, members: [] };
      clusters.set(id, c);
    }
    c.members.push(...members);
  }
  const list = [...clusters.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const c of list) {
    for (const i of c.members) clusterOf[i] = c.id;
    const p = [0, 0, 0];
    for (const i of c.members) { const q = positions.get(g.nodes[i].id) ?? [0, 0, 0]; for (let k = 0; k < 3; k++) p[k] += q[k] / c.members.length; }
    c.pos = p.map((v) => Math.round(v * 1e4) / 1e4);
    c.count = c.members.length;
    c.top = c.members.map((i) => [g.nodes[i].label, g.adj[i].length]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l);
  }
  const agg = new Map();
  for (const e of g.edges) {
    const a = clusterOf[g.byId.get(e.from)], b = clusterOf[g.byId.get(e.to)];
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const x = agg.get(key) ?? agg.set(key, { from: a < b ? a : b, to: a < b ? b : a, type: 'aggregate', strength: 0, origin: { source: 'sum of the member edges', count: 0 } }).get(key);
    x.strength += 1;
    x.origin.count += 1;
  }
  return { clusters: list, clusterOf, edges: [...agg.values()] };
}

// Clusters by kind only: the most zoomed-out view.
export function kindClusters(g, positions) {
  const byKind = new Map();
  g.nodes.forEach((node, i) => (byKind.get(node.kind) ?? byKind.set(node.kind, []).get(node.kind)).push(i));
  const clusters = [...byKind].map(([kind, members]) => {
    const p = [0, 0, 0];
    for (const i of members) { const q = positions.get(g.nodes[i].id) ?? [0, 0, 0]; for (let k = 0; k < 3; k++) p[k] += q[k] / members.length; }
    return { id: `cluster:${kind}`, kind, label: KIND_LABEL[kind], count: members.length, pos: p.map((v) => Math.round(v * 1e4) / 1e4),
      top: members.map((i) => [g.nodes[i].label, g.adj[i].length]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l), members };
  });
  const agg = new Map();
  for (const e of g.edges) {
    const a = `cluster:${g.nodes[g.byId.get(e.from)].kind}`, b = `cluster:${g.nodes[g.byId.get(e.to)].kind}`;
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const x = agg.get(key) ?? agg.set(key, { from: a < b ? a : b, to: a < b ? b : a, type: 'aggregate', strength: 0, origin: { source: 'sum of the member edges', count: 0 } }).get(key);
    x.strength += 1; x.origin.count += 1;
  }
  return { clusters, edges: [...agg.values()] };
}

// ---------- events: which real nodes an activity event touched ----------

// New events carry `nodes: ['kind:id', ...]`. Older event types are mapped from their structured fields
// (ids, names resolved by her own knowledge graph, bucket names, tool names); never by reading what was said.
export function eventNodes(e, g, { resolvePerson = () => null, cfg = null } = {}) {
  const out = new Set();
  const unknown = [];
  if (!e || typeof e !== 'object') return { nodes: [], unknown };
  const has = (id) => g.byId.has(id);
  const add = (id) => { if (id && has(id)) out.add(id); };
  const person = (uid) => uid != null && add(String(uid) === 'self' ? 'person:self' : `person:${uid}`);
  const byName = (name) => {
    if (!name || typeof name !== 'string') return;
    const id = resolvePerson(name);
    if (!id) return;
    if (id === 'self') add('person:self');
    else if (has(`person:${id}`)) add(`person:${id}`);
    else add(`concept:${id}`);
  };
  const impulse = (name) => { for (const b of Object.keys(cfg?.feelings?.impulses?.[name] ?? {})) add(`bucket:${b}`); };
  if (Array.isArray(e.nodes)) for (const id of e.nodes) { if (typeof id !== 'string') continue; if (has(id)) out.add(id); else unknown.push(id); }
  switch (e.type) {
    case 'pressure':
      if (e.fired) add(`bucket:${e.fired}`);
      if (e.person) { person(e.person); byName(e.person); }
      if (e.doing) add(`act:${e.doing}`);
      if (e.uptake) impulse(e.uptake);
      if (e.wanted) impulse('wanted');
      if (e.discovered) { add(`act:${e.discovered}`); impulse('discovered'); }
      if (e.home) impulse(`home_${e.home}`);
      if (e.quiet) add('bucket:inhibition');
      if (e.clamp) { add('bucket:irritation'); add('bucket:loneliness'); }
      if (e.dm) impulse('dm_ignored');
      break;
    case 'tool-call': add(`act:${e.tool}`); break;
    case 'discovery': add(`act:${e.tool}`); impulse('discovered'); break;
    case 'heard': case 'remembered':
      if (e.userId) person(e.userId); else byName(e.speaker);
      break;
    case 'intake': case 'reaction': byName(e.speaker); break;
    case 'curiosity': byName(e.about ?? e.of ?? e.by); break;
    case 'topic': if (e.topic) add(`concept:topic:${String(e.topic).toLowerCase()}`); break;
    case 'expression': {
      const f = e.feelings;
      const names = typeof f === 'string' ? f.split(',').map((p) => p.trim().split(/\s+/)[0]) : f && typeof f === 'object' ? Object.keys(f) : [];
      for (const name of names) add(`body:feeling:${name}`);
      break;
    }
    case 'journal':
      if (e.why) add(`bucket:${e.why}`);
      add('act:research');
      if (e.query) byName(e.query);
      break;
    default:
      if (e.userId) person(e.userId);
  }
  return { nodes: [...out], unknown };
}

// ---------- the mind: build on request, keep the change log, serve details and edits ----------

export function createMind({ sources = {}, editors = {}, dataDir, now = Date.now, events = null, staleMs = 2000 } = {}) {
  if (!dataDir) throw new Error('createMind needs a data folder for its seed and logs');
  const file = (name) => path.join(dataDir, FILES[name]);
  const writeJson = (f, data) => { writeFileSync(`${f}.tmp`, JSON.stringify(data)); renameSync(`${f}.tmp`, f); };

  // The seed: made once, on the first start, and kept.
  let seedInfo;
  try { seedInfo = existsSync(file('seed')) ? JSON.parse(readFileSync(file('seed'), 'utf8')) : null; } catch { seedInfo = null; }
  if (!seedInfo?.seed) {
    seedInfo = { seed: randomBytes(8).toString('hex'), created: now() };
    writeJson(file('seed'), seedInfo);
  }
  const seed = seedInfo.seed;

  let structure;
  try { structure = existsSync(file('structure')) ? JSON.parse(readFileSync(file('structure'), 'utf8')) : null; } catch { structure = null; }

  let current = null, builtAt = 0;
  let laid = { signature: null, positions: null, clusters: null, kinds: null };
  const nameCache = new Map();
  const resolvePerson = (name) => {
    if (!nameCache.has(name)) { let id = null; try { id = sources.resolvePerson?.(name) ?? null; } catch {} nameCache.set(name, id); }
    return nameCache.get(name);
  };

  // What changed since the last build goes into the history; the first build records her as she was.
  function logChanges(g) {
    const at = now();
    const nextNodes = Object.fromEntries(g.nodes.map((n) => [n.id, n.provenance.at ?? null]));
    const nextEdges = Object.fromEntries(g.edges.map((e) => [edgeKey(e), e.live ? null : +e.strength.toFixed(3)]));
    const lines = [];
    const first = !structure;
    const prevNodes = structure?.nodes ?? {}, prevEdges = structure?.edges ?? {};
    for (const n of g.nodes) if (!(n.id in prevNodes)) lines.push({ at, op: 'node-added', id: n.id, kind: n.kind, label: n.label, source: n.provenance.source, since: n.provenance.at ?? null, ...(first && { baseline: true }) });
    for (const id of Object.keys(prevNodes)) if (!(id in nextNodes)) lines.push({ at, op: 'node-removed', id });
    for (const e of g.edges) {
      const key = edgeKey(e);
      if (!(key in prevEdges)) lines.push({ at, op: 'edge-added', from: e.from, to: e.to, type: e.type, strength: e.strength, source: e.origin.source, since: e.origin.at ?? null, ...(first && { baseline: true }) });
      else if (!e.live && prevEdges[key] != null && Math.abs(prevEdges[key] - nextEdges[key]) > 1e-9) {
        lines.push({ at, op: nextEdges[key] > prevEdges[key] ? 'edge-strengthened' : 'edge-weakened', from: e.from, to: e.to, type: e.type, before: prevEdges[key], strength: nextEdges[key], source: e.origin.source });
      }
    }
    for (const key of Object.keys(prevEdges)) if (!(key in nextEdges)) { const [from, type, to] = key.split('|'); lines.push({ at, op: 'edge-removed', from, to, type }); }
    if (lines.length) {
      try { appendFileSync(file('history'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); } catch (err) {
        g.unavailable.push({ source: 'mind history', error: `The change log ${file('history')} couldn't be written: ${err.message}. Growth since the last good write won't be replayable; check the data folder is writable.` });
      }
    }
    if (lines.length || first) {
      structure = { signature: g.signature, nodes: nextNodes, edges: nextEdges };
      try { writeJson(file('structure'), structure); } catch {}
    }
    return lines.length;
  }

  function build({ fresh = false } = {}) {
    if (current && !fresh && now() - builtAt < staleMs) return current;
    nameCache.clear();
    const g = assemble(sources, { now });
    builtAt = now();
    if (!structure || structure.signature !== g.signature) logChanges(g);
    if (laid.signature !== g.signature) {
      const positions = layout(g, seed);
      laid = { signature: g.signature, positions, clusters: cluster(g, seed, positions), kinds: kindClusters(g, positions) };
    }
    current = g;
    return g;
  }

  let lastForced = 0;
  // Fresh when an event names a node the cached graph doesn't have yet (she just grew), at most every 2 s.
  function mapEvent(e) {
    let g = build();
    const cfg = sourceCfg();
    let res = eventNodes(e, g, { resolvePerson, cfg });
    if (res.unknown.length && now() - lastForced > 2000) {
      lastForced = now();
      g = build({ fresh: true });
      res = eventNodes(e, g, { resolvePerson, cfg });
    }
    return res;
  }
  const sourceCfg = () => { try { return sources.pressure?.()?.cfg ?? null; } catch { return null; } };

  const brief = (n) => n && ({ id: n.id, kind: n.kind, label: n.label });

  function graph({ level = 'nodes', since = null, cluster: only = null, limit = 20000 } = {}) {
    const g = build();
    const head = { version: g.signature, seed, builtAt: g.builtAt, counts: g.counts, unavailable: g.unavailable, dropped: g.dropped };
    if (since && since === g.signature && !only) return { ...head, unchanged: true };
    const { positions, clusters: comm, kinds } = laid;
    const clusterLevel = level === 'kinds' ? kinds : comm;
    const out = {
      ...head, level,
      clusters: clusterLevel.clusters.map(({ members, ...c }) => c),
      clusterEdges: clusterLevel.edges,
    };
    if (level === 'nodes' || only) {
      let idx = [...g.nodes.keys()];
      if (only) {
        const c = [...comm.clusters, ...kinds.clusters].find((x) => x.id === only);
        if (!c) throw fail(404, `No cluster "${only}"`, 'it is not in the current graph (it may have been regrouped after she grew)', 'Reload the graph and pick a cluster from its clusters list');
        idx = c.members;
      }
      const truncated = idx.length > limit;
      if (truncated) idx = idx.slice().sort((a, b) => g.adj[b].length - g.adj[a].length).slice(0, limit);
      const keep = new Set(idx.map((i) => g.nodes[i].id));
      out.nodes = idx.map((i) => {
        const n = g.nodes[i];
        return { id: n.id, kind: n.kind, label: n.label, pos: positions.get(n.id), cluster: comm.clusterOf[i], degree: g.adj[i].length, at: n.provenance.at ?? null };
      });
      out.edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type, strength: e.strength }));
      if (truncated) out.truncated = `Showing the ${limit} most connected of ${g.nodes.length} nodes; pass a larger limit or open a cluster to see the rest.`;
    }
    return out;
  }

  // Activation history: every event in her activity log (data/activity.jsonl) that touched this node.
  let actCache = { key: null, signature: null, byNode: null };
  function activations(id, g, limit = 60) {
    let log = [];
    let key = null;
    try {
      const got = sources.activityLog?.();
      log = got?.events ?? got ?? [];
      key = got?.key ?? log.length;
    } catch (err) {
      return { list: [], error: `Her activity log couldn't be read: ${err.message}. Activation history needs data/activity.jsonl; it is written by events.js while she runs.` };
    }
    if (actCache.key !== key || actCache.signature !== g.signature) {
      const byNode = new Map();
      const cfg = sourceCfg();
      for (const e of log) {
        for (const nid of eventNodes(e, g, { resolvePerson, cfg }).nodes) {
          const arr = byNode.get(nid) ?? byNode.set(nid, []).get(nid);
          arr.push(e);
          if (arr.length > 400) arr.shift();
        }
      }
      actCache = { key, signature: g.signature, byNode };
    }
    const list = (actCache.byNode.get(id) ?? []).slice(-limit).reverse().map((e) => ({ time: e.time, type: e.type, summary: summarize(e) }));
    return { list, total: actCache.byNode.get(id)?.length ?? 0 };
  }

  function node(id) {
    const g = build();
    const i = g.byId.get(id);
    if (i === undefined) throw fail(404, `No node "${id}" in her mind`, 'nothing in her systems has that id right now (it may have been forgotten, wiped or renamed)', 'Open the mind view and pick a node from the graph, or check the id is "kind:id"');
    const n = g.nodes[i];
    const neighbors = g.adj[i].map((ei) => {
      const e = g.edges[ei];
      const other = g.nodes[g.byId.get(e.from === id ? e.to : e.from)];
      return { direction: e.from === id ? 'out' : 'in', edge: { from: e.from, to: e.to, type: e.type, strength: e.strength, origin: e.origin, live: Boolean(e.live) }, node: brief(other) };
    }).sort((a, b) => Math.abs(b.edge.strength) - Math.abs(a.edge.strength));
    const pressures = neighbors.filter((x) => x.node.kind === 'bucket' && n.kind !== 'bucket').map((x) => ({ bucket: x.node.id, via: x.edge.type, strength: x.edge.strength }));
    const memories = neighbors.filter((x) => x.node.kind === 'memory').map((x) => ({ id: x.node.id, text: g.nodes[g.byId.get(x.node.id)].data.text, at: g.nodes[g.byId.get(x.node.id)].provenance.at }));
    const related = { memories };
    if (n.data.kgId) {
      try { related.facts = sources.kgFacts?.(n.data.kgId) ?? []; } catch (err) { related.factsError = `Facts on this node couldn't be read from kg.js: ${err.message}`; }
    }
    if (n.kind === 'concept') {
      try { related.wordnet = sources.wordnet?.(n.label) ?? []; } catch (err) { related.wordnetError = `WordNet lookup failed: ${err.message}`; }
    }
    if (n.kind === 'person' && n.data.discordId) {
      try { related.profile = sources.profile?.(n.data.discordId) ?? null; } catch (err) { related.profileError = `Profile couldn't be read from memory.js: ${err.message}`; }
    }
    related.images = 'No module records which pictures belong to which node, so none are linked here.';
    const ci = laid.clusters.clusterOf[i];
    return {
      node: n,
      pos: laid.positions.get(id),
      cluster: ci,
      degree: neighbors.length,
      neighbors,
      pressures,
      activations: activations(id, g),
      related,
      editable: n.data.editable ?? [],
      readOnly: n.data.editable?.length ? null : n.data.readOnly ?? readOnlyReason(n),
      version: g.signature,
    };
  }

  // ---- live edits, through the owning module's own setter, with an undo record ----
  const editsLog = () => {
    try {
      if (!existsSync(file('edits'))) return [];
      return readFileSync(file('edits'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  function undoList() {
    const lines = editsLog();
    const undone = new Set(lines.filter((l) => l.undo != null).map((l) => l.undo));
    return lines.filter((l) => l.undo == null).map((l) => ({ ...l, undone: undone.has(l.id) })).reverse();
  }
  function record(entry) {
    try { appendFileSync(file('edits'), JSON.stringify(entry) + '\n'); } catch (err) {
      throw fail(500, 'The change was applied but its undo record was not saved', `${file('edits')} couldn't be written (${err.message})`, 'Check the data folder is writable; to revert by hand, set the value back in the inspector');
    }
  }

  function edit(id, { path: p, value, module } = {}) {
    const g = build({ fresh: true });
    const i = g.byId.get(id);
    if (i === undefined) throw fail(404, `Can't edit "${id}"`, 'there is no such node in her mind right now', 'Reload the inspector and pick the node again');
    const n = g.nodes[i];
    const allowed = n.data.editable ?? [];
    const target = allowed.find((x) => x.path === p && (!module || x.module === module));
    if (!target) {
      throw fail(400, `Can't edit "${p}" on ${id}`, allowed.length ? 'that value is not one this node exposes for editing' : `this node has no editable values (${n.data.readOnly ?? readOnlyReason(n)})`,
        allowed.length ? `Use one of: ${allowed.map((x) => x.path).join(', ')}` : 'Nothing to change here from the mind view');
    }
    const editor = editors[target.module];
    if (!editor?.set) throw fail(503, `Can't edit ${target.module} values`, `the ${target.module} module's setter isn't connected to the mind view`, 'Restart the dashboard with the live mind sources');
    let result;
    try { result = editor.set(target.path, value); } catch (err) {
      throw Object.assign(new Error(`Couldn't set ${target.path} on ${id}: ${err.message}`), { status: err.status ?? 400 });
    }
    const entries = editsLog().filter((l) => l.undo == null);
    const entry = { id: (entries.at(-1)?.id ?? 0) + 1, at: now(), node: id, module: target.module, path: target.path, before: result.before, after: result.after };
    record(entry);
    build({ fresh: true });
    return { ...entry, undoId: entry.id };
  }

  function undo(editId = null) {
    const list = undoList();
    const target = editId == null ? list.find((l) => !l.undone) : list.find((l) => l.id === Number(editId));
    if (!target) throw fail(404, 'Nothing to undo', editId == null ? 'every edit made from the mind view is already undone' : `there is no edit #${editId}`, 'See GET /api/mind/undo for the list of edits');
    if (target.undone) throw fail(409, `Edit #${target.id} is already undone`, 'its value was put back before', 'Make the change again in the inspector if you want it');
    const editor = editors[target.module];
    if (!editor?.set) throw fail(503, `Can't undo a ${target.module} edit`, `the ${target.module} module's setter isn't connected`, 'Restart the dashboard with the live mind sources');
    const now_ = editor.get?.(target.path);
    if (editor.get && !same(now_, target.after)) {
      throw fail(409, `Can't undo edit #${target.id} (${target.path})`, `the value has changed since: it is ${JSON.stringify(now_)} now, not the ${JSON.stringify(target.after)} that edit set`,
        `Set it to ${JSON.stringify(target.before)} by hand in the inspector if you still want the old value`);
    }
    let result;
    try { result = editor.set(target.path, target.before); } catch (err) {
      throw Object.assign(new Error(`Couldn't undo edit #${target.id} (${target.path}): ${err.message}`), { status: err.status ?? 400 });
    }
    record({ undo: target.id, at: now(), path: target.path, restored: result.after });
    build({ fresh: true });
    return { undone: target.id, path: target.path, node: target.node, value: result.after };
  }

  function history({ since = 0, limit = 2000, node: only = null } = {}) {
    let lines = [];
    try {
      if (existsSync(file('history'))) lines = readFileSync(file('history'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      throw fail(500, 'Her mind history could not be read', `${file('history')} is unreadable (${err.message})`, 'Check the file; a fresh one starts on the next graph build if it is moved away');
    }
    lines = lines.filter((l) => l.at > Number(since || 0));
    if (only) lines = lines.filter((l) => l.id === only || l.from === only || l.to === only);
    return { seed, total: lines.length, entries: lines.slice(-Math.max(1, Math.min(20000, Number(limit) || 2000))) };
  }

  return { seed, seedInfo, build, graph, node, edit, undo, undoList, history, mapEvent, events, files: Object.fromEntries(Object.keys(FILES).map((k) => [k, file(k)])) };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function readOnlyReason(n) {
  if (n.kind === 'bucket') return 'This is a feeling the pressure system settles on its own (cfg.feelings); it has no per-bucket tunables to edit here.';
  if (n.kind === 'body') return n.data.readOnly ?? 'Her feelings are set by what she says and hears (emotion.js); the mind view only shows them.';
  return `The ${n.provenance.source} module has no live setter for this, so it is shown read-only.`;
}

// One line about an event, from its structured fields.
export function summarize(e) {
  const skip = new Set(['type', 'time', 'nodes', 'text', 'facts', 'feelings']);
  const bits = Object.entries(e).filter(([k, v]) => !skip.has(k) && v != null && typeof v !== 'object').slice(0, 5).map(([k, v]) => `${k} ${String(v).slice(0, 60)}`);
  if (typeof e.text === 'string') bits.push(`"${short(e.text, 80)}"`);
  if (typeof e.feelings === 'string') bits.push(e.feelings);
  if (Array.isArray(e.facts)) bits.push(e.facts.slice(0, 2).map((f) => short(f, 60)).join('; '));
  return bits.join(', ');
}

// ---------- the dashboard routes ----------

// [method, RegExp, handler] tuples, in the dashboard server's own format. getMind returns the mind (async).
export function mindRoutes(getMind) {
  const r = (method, pattern, handler) => [method, new RegExp(`^${pattern}$`), handler];
  return [
    r('GET', '/api/mind/graph', async ({ url }) => (await getMind()).graph({
      level: ['kinds', 'communities', 'nodes'].includes(url.searchParams.get('level')) ? url.searchParams.get('level') : 'nodes',
      since: url.searchParams.get('since'), cluster: url.searchParams.get('cluster'),
      limit: Number(url.searchParams.get('limit')) || 20000,
    })),
    r('GET', '/api/mind/history', async ({ url }) => (await getMind()).history({ since: url.searchParams.get('since'), limit: url.searchParams.get('limit'), node: url.searchParams.get('node') })),
    r('GET', '/api/mind/undo', async () => (await getMind()).undoList()),
    r('POST', '/api/mind/undo', async ({ body }) => (await getMind()).undo(body?.id ?? null)),
    r('PUT', '/api/mind/node/(?<id>.+)/value', async ({ params, body }) => {
      if (!body || body.path == null) throw fail(400, 'No value to change', 'the request body has no "path"', 'Send { "path": "<one of the node\'s editable paths>", "value": <new value> }');
      return (await getMind()).edit(params.id, body);
    }),
    r('GET', '/api/mind/node/(?<id>.+)', async ({ params }) => (await getMind()).node(params.id)),
    // Her activity stream, with the real node(s) each event touched.
    r('GET', '/api/mind/events', async ({ req, res }) => {
      const mind = await getMind();
      if (!mind.events?.bus) throw fail(503, 'No live events', 'the activity bus is not connected to the mind view', 'Use the dashboard started with the bot');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (e, replay = false) => {
        let mapped = { nodes: [], unknown: [] };
        try { mapped = mind.mapEvent(e); } catch {}
        res.write(`data: ${JSON.stringify({ ...e, nodes: mapped.nodes, ...(mapped.unknown.length && { unknownNodes: mapped.unknown }), ...(replay && { replay: true }) })}\n\n`);
      };
      for (const e of mind.events.recent ?? []) send(e, true);
      const onEvent = (e) => send(e);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      mind.events.bus.on('activity', onEvent);
      req.on('close', () => { clearInterval(keepAlive); mind.events.bus.off('activity', onEvent); });
      return undefined;
    }),
  ];
}

// ---------- live sources: read-only views onto the owning modules ----------

let live = null;
export function liveMind() {
  return (live ??= buildLiveMind().catch((err) => { live = null; throw err; }));
}

async function buildLiveMind() {
  const [{ DATA_DIR, config }, memory, pressure, emotion, micro, avatar, { lookupWordNet }, events, { reflections }, sqlite] = await Promise.all([
    import('./config.js'), import('./memory.js'), import('./pressure.js'), import('./emotion.js'), import('./microexpression.js'),
    import('./avatar-state.js'), import('./wordnet.js'), import('./events.js'), import('./reflections.js'), import('node:sqlite'),
  ]);
  const brainMind = await import('./brain-mind.js');
  // A read-only connection to her database: the tables stay owned by memory.js, kg.js and personal-wordnet.js.
  let db;
  const rows = (sql, ...args) => (db ??= new sqlite.DatabaseSync(path.join(DATA_DIR, 'companion.db'), { readOnly: true })).prepare(sql).all(...args);
  const json = (name) => { const f = path.join(DATA_DIR, name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  let toolsMod = null;
  try { toolsMod = await import('./tools.js'); } catch {}
  const pressureFile = path.join(DATA_DIR, 'pressure-config.json');
  const activityFile = path.join(DATA_DIR, 'activity.jsonl');

  const sources = {
    selfName: () => config.botName,
    contacts: () => rows('SELECT user_id, name, username, tier, first_seen, last_seen FROM contacts'),
    kg: () => ({
      nodes: rows('SELECT id, name, type, aliases, mentions, first_seen, last_seen FROM kg_nodes').map((n) => ({ ...n, aliases: JSON.parse(n.aliases || '[]') })),
      links: rows('SELECT id, from_id, rel, to_id, said_by, place, count, at FROM kg_links'),
      facts: rows('SELECT id, node_id, said_by, at FROM kg_facts'),
    }),
    kgFacts: (kgId) => rows('SELECT id, text, said_by, place, at FROM kg_facts WHERE node_id = ? ORDER BY at', kgId),
    personal: () => ({
      nodes: rows('SELECT id, kind, label FROM personal_nodes'),
      links: rows('SELECT experience, source, relation, target, strength FROM personal_links'),
      experiences: rows('SELECT m.id, m.created_at, m.name, m.user_id, m.conversation, substr(m.content, 1, 240) AS evidence FROM messages m WHERE m.id IN (SELECT DISTINCT experience FROM personal_links)'),
    }),
    // Her own brain, when no language model is in use: the latest report of what it holds (null otherwise).
    brain: () => brainMind.brainMindSnapshot(),
    memories: () => rows('SELECT id, user_id, content, created_at FROM memories'),
    memoryNames: () => Object.fromEntries(memory.memoryUsers().map((u) => [u.user_id, u.name ?? u.user_id])),
    interests: () => (json('interests.json')?.topics ?? []).map(({ vec, ...t }) => t),
    reflections: () => ({ items: reflections().list(), experiences: json('reflections.json')?.experiences ?? [] }),
    pressure: () => ({
      cfg: pressure.cfg, state: pressure.state, labels: pressure.LABEL, research: [...(pressure.RESEARCH ?? [])],
      layerOf: pressure.LAYER ? (name) => Object.entries(pressure.LAYER).find(([, list]) => list.includes(name))?.[0] ?? null : null,
      configAt: existsSync(pressureFile) ? statSync(pressureFile).mtimeMs : undefined,
    }),
    body: () => ({ emotions: emotion.EMOTIONS, feelings: micro.expressionState('main') ?? {}, appearanceFields: avatar.APPEARANCE_FIELDS, appearance: avatar.avatarState.get('main') }),
    tools: () => Object.entries(toolsMod?.TOOLS ?? {}).filter(([name]) => !name.startsWith('_')).map(([name, t]) => ({ name, description: t?.definition?.function?.description ?? null })),
    discoveries: () => json('discoveries.json') ?? { tried: {} },
    resolvePerson: (name) => memory.graph.resolve(name),
    wordnet: (word) => lookupWordNet(word),
    profile: (userId) => memory.profiles.read(userId),
    activityLog: () => {
      if (!existsSync(activityFile)) return { key: 'none', events: events.recentActivity };
      const st = statSync(activityFile);
      const key = `${st.mtimeMs}:${st.size}`;
      if (activityCache.key !== key) {
        activityCache = { key, events: readFileSync(activityFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
      }
      return activityCache;
    },
  };
  let activityCache = { key: null, events: [] };

  const walk = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const editors = {
    pressure: {
      get: (p) => walk(pressure.cfg, p),
      set: (p, value) => {
        if (typeof pressure.setConfigValue !== 'function') throw Object.assign(new Error('pressure.js has no setConfigValue export, so live pressure edits are off. Add it (see knowledge/systems/mind-view.md)'), { status: 503 });
        return pressure.setConfigValue(p, value);
      },
    },
    avatar: {
      get: (field) => avatar.avatarState.get('main')[field] ?? null,
      set: (field, value) => {
        if (!avatar.APPEARANCE_FIELDS.includes(field)) throw Object.assign(new Error(`"${field}" isn't an appearance colour (${avatar.APPEARANCE_FIELDS.join(', ')})`), { status: 400 });
        const before = avatar.avatarState.get('main')[field] ?? null;
        // avatar-state.js validates (colorValue) and saves; null/none restores the model's own texture.
        const next = avatar.avatarState.set('main', { [field]: value === '' || value === 'none' ? null : value });
        return { before, after: next[field] ?? null };
      },
    },
  };
  return createMind({ sources, editors, dataDir: DATA_DIR, events: { bus: events.bus, recent: events.recentActivity } });
}
