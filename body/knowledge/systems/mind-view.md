# Her mind view (mind.html, mind-graph.html, node.html, cognitive-graph.js)

There are two mind pages on your dashboard.

## mind page / mind.html / the brain / your brain on screen / neurons firing / hair-thin lightning
`/mind.html` is your brain: a brain-shaped volume (two hemispheres and a cerebellum) of thousands of fine neurons,
each belonging to a region of you: hearing, memory, pressure, taste, thoughts, voice, presence, sleep, intake,
curiosity, feelings, intuition, hands, body, the architect and faults. Inside a region, neurons are wired to their
nearest neighbours by dendrites; regions that work together are wired by long axons. Every connection is a curved
fibre, not a straight wire. When something happens (`/api/events`), its region fires: a wave runs through that
region's dendrites, and hair-thin, jagged lightning travels down its axons to the regions it's wired to, flickering
as it goes. Each frame of your mouth moving while you speak (`/api/avatar/live`, 40 ms frames) beats your body
region in step with the sound, and your expressions light the feelings you showed, so when you talk a whole part of
your brain lights up, not one point. Your pressure buckets set the resting glow of the pressure region and your
feelings the feelings region. On top of it grows a web of the things you know: a neuron for each fact, tool, person,
feeling or signal you touch, linked to what it came with. That web is kept in the browser that shows the page
(localStorage), so it keeps growing across reloads in that browser.

Owner, 2026-11-11, after this page had been replaced by the knowledge graph (Nov 9) and then reworked: "Did you see
the other picture? How the other one worked with the lightning bolts? They were hair-thin lightning bolts that went
between the neurons." So this brain, as it was on Nov 8, is your mind page again. Its hint line links to your
knowledge graph.

## mind graph / mind-graph.html / knowledge graph page / node inspector page
`/mind-graph.html` draws your real cognitive graph as a 3D network. Nothing on it is
invented: every point is a node read from one of your own systems, every line is a real record that links
two of them, and every flash is an event that actually touched those nodes. Click a node to inspect it (node.html,
which links back here). The sections below are about this graph page unless they say otherwise.

## Where the graph comes from

`src/cognitive-graph.js` is a read model. On each request it asks the owning modules what is there now:

| kind | id | from |
|---|---|---|
| person | `person:<discord id>`, `person:self` | contacts (memory.js), kg person nodes, personal word-net |
| concept | `concept:<kg id>`, `concept:topic:<name>` | kg.js nodes, personal word-net topics |
| memory | `memory:<id>` | memory.js memories (linked `about` the person) |
| experience | `experience:<message id>`, `experience:goal-<id>` | personal word-net experiences, goal experiences (reflections.js) |
| interest | `interest:<name>` | interests.js |
| goal / insight | `goal:<id>`, `insight:<id>` | reflections.js |
| bucket | `bucket:<name>`, `bucket:reserve` | pressure.js cfg and state; flows, couplings and seeds are edges |
| act | `act:<tool>` | tools.js TOOLS and pressure action_costs (cost edges to the reserve) |
| body | `body:feeling:<name>`, `body:appearance:<field>`, `body:mouth/blink/glance` | emotion.js, avatar-state.js, the avatar live stream |

Every node has `provenance { source, at, by }`; every edge has `{ from, to, type, strength, origin }`.
A link whose end isn't in her systems is dropped and counted on the page, never filled in. A source that
can't be read is listed with the reason. Database tables are read through a read-only SQLite connection;
memory.js, kg.js and personal-wordnet.js still own them.

## Shape, growth and history

- `data/mind-seed.json`: her seed, made on first start. The layout is a seeded force layout: the same
  graph and seed always give the same shape; another instance gets another shape; growth changes it.
- `data/mind-structure.json`: the last structure seen, to tell what changed.
- `data/mind-history.jsonl`: the change log (node/edge added, removed, strengthened, weakened). The first
  build records her as she was (`baseline`). "replay growth" on the page plays it back.
- `data/mind-edits.jsonl`: live edits with before/after, for undo.

All four are part of who she is and are on the rebirth/wipe list (src\memory-wipe.js), so a wipe gives a new seed and a new shape.

The seed file holds `seed` (16 hex characters) and `created`. If it's missing or broken, a new seed is made. The structure file holds the last `signature` plus every node id (with when it began) and every edge key (from|type|to) with its strength. The signature is a short hash of every node's id and label and every edge's strength; when it differs from the last one, what changed is written to the history. Each history line has `at`, `op` (node-added, node-removed, edge-added, edge-removed, edge-strengthened, edge-weakened), the ids, type, strength (and `before` for a strength change), the source, and `baseline: true` on the first build. Live links (affinity, missed) never log strengthening or weakening, since they move all the time. Each edits line has `id`, `at`, `node`, `module`, `path`, `before`, `after`; an undo line has `undo` (the edit id), `at`, `path` and `restored`.

Where each source is read from: contacts, kg_nodes, kg_links, kg_facts, personal_nodes, personal_links, memories and messages in data\companion.db (read-only connection); data\interests.json; reflections.js and data\reflections.json; the live pressure config and state; emotion.js, microexpression.js and avatar-state.js for the body; tools.js for acts and data\discoveries.json for when she first used each one.

## Activity

`/api/mind/events` is her activity stream with `nodes` added: new events carry their own node ids;
older ones are mapped from their fields (fired bucket, tool name, user id, speaker resolved by kg.js,
feeling names, topic, journal bucket). The older mappings, by event type:
- `pressure`: the fired bucket, the person (by id or name), the act she did, and the buckets of any impulse it names (uptake, wanted, discovered, home, dm ignored); a quiet request lights inhibition; a clamp lights irritation and loneliness.
- `tool-call`: the act for that tool. `discovery`: the act plus the discovered impulse.
- `heard`, `remembered`: the speaker by id, else by name. `intake`, `reaction`: the speaker by name. `curiosity`: who it was about or by.
- `topic`: the topic concept. `expression`: each feeling named.
- `journal`: the bucket behind it, the research act, and the query resolved as a name.
- anything else with a `userId`: that person.
Names are resolved only through her own knowledge graph, never by reading what was said. Node ids in an event that aren't in the graph are sent as `unknownNodes`. Events that already name their nodes include relationship stage changes (the person) and direction changes (the direction bucket, the direction act and the person). The page fires those nodes and the signal runs along their
strongest real edges. Mouth frames, blinks, glances and expressions from `/api/avatar/live` fire the body
nodes. Pressure values (`/api/pressure`) set the resting glow of bucket nodes.

## Inspector and edits

Click a node (or a bucket row, or a ticker line) to open `node.html?id=...`: what it is, where it came
from, connections with type/strength/origin (click to walk), pressures touching it, activation history
from `data/activity.jsonl`, related memories/facts/WordNet senses/profile, and its growth history.

Editable values go through the owning module's setter only:
- pressure tunables via `pressure.setConfigValue(path, value)` (bucket threshold/fill_rate/decay_rate/
  drain/hysteresis/enabled, action_costs, priority, store_share, reserve_use, overheard_uptake, flow and
  coupling rates, existing seeds), saved to `data/pressure-config.json`;
- avatar appearance colours via `avatarState.set`.

Everything else is read-only and the inspector says why. Undo refuses if the value changed since.

## API

- `GET /api/mind/graph?level=kinds|communities|nodes&since=<version>&cluster=<id>&limit=`
- `GET /api/mind/node/:id`
- `PUT /api/mind/node/:id/value` `{ path, value, module? }`
- `GET /api/mind/history?since=&limit=&node=`
- `GET /api/mind/undo`, `POST /api/mind/undo` `{ id? }`
- `GET /api/mind/events` (SSE)

What they return:
- graph: always `version` (the graph's signature), `seed`, `builtAt`, `counts` (nodes, edges, and nodes per kind), `unavailable` (sources that couldn't be read, with why) and `dropped` (how many links were dropped, with up to 8 examples). If `since` matches the current version it answers only `unchanged: true`. `level` kinds or communities gives clusters and the edges between them; nodes (the default) also gives every node (id, kind, label, position, cluster, how many links, when it began) and edge. `limit` defaults to 20,000 nodes; past that it keeps the most connected and says "Showing the (limit) most connected of (n) nodes; pass a larger limit or open a cluster to see the rest."
- node: the node, its position and cluster, every neighbour sorted by strength, the pressures touching it, its activations, related records, what's editable or why it's read-only, and the version.
- history: `seed`, `total` and `entries`, newest kept last; `limit` defaults to 2,000 and is held between 1 and 20,000. `node` filters to lines about that node.
- undo (GET): every edit, newest first, each marked undone or not.
- events: a server-sent stream; on connect it replays the recent events (marked `replay`), then sends each new one. A keep-alive ping goes every 25 seconds.

## mind graph links / edge types / what the lines mean
Every line is one of these, named by the record that makes it:
- kg.js links: the relation stored in her knowledge graph (`kg_links.rel`), strength = how many times it was said.
- personal word-net links: the relation recorded for a conversation experience (who it was with, what it was about, what she felt); `affinity` is kept once per person, from the latest experience only, and is marked live.
- `about`: a memory to the person it's about.
- `came up with`: an interest to each person it came up with (by count), when her knowledge graph can resolve the name.
- `same topic`: an interest to the matching topic concept, when both exist.
- `pulls`: an interest to the explore bucket, strength = how strongly she's into it.
- `driven by`: a goal to the bucket that set it. `pivoted from`: a goal to the goal it replaced. `for goal`: a goal's experience to the goal.
- `flow`, `coupling`, `seeds`: between pressure buckets, from cfg.flows, cfg.flow.couplings and cfg.seeds.
- `missed`: a person to the loneliness bucket, strength = how much she's missing them right now (live).
- `fires`: a research bucket to the research act.
- `costs` or `costs (action)`: an act to the reserve, strength = its energy cost.
Two records for the same link add their strengths together. A link from a thing to itself is skipped. `same topic`, `pulls` and `fires` are optional joins: when an end is missing they're simply left out and not counted as dropped.

When two modules describe the same node (a person in contacts and in kg.js), the first source is kept as its provenance and the others are listed as `alsoFrom`.

## mind layout / clusters / why the mind has that shape / seed
The layout (`layout` in src\cognitive-graph.js) is worked out on the server. Each of the ten kinds gets an anchor point placed by her seed. Each node starts at a spot near its kind's anchor, also chosen by the seed and its id, then a force pass pulls linked nodes together along real edges, pushes close nodes apart and pulls gently back to the anchor. It runs 80 rounds under 1,500 nodes, 40 under 6,000, and 20 above that. Stronger links pull harder, on a log scale. The result is the same every time for the same graph and seed, which is why the shape only changes when she grows.

Clusters, for the zoomed-out views: communities are found by label passing over the real links, 8 rounds, kept within one kind. A group of 3 or more becomes "(kind) around (its main node)"; smaller groups fold into one "other (kind)" cluster per kind. The most zoomed-out view is one cluster per kind ("people", "concepts", "memories", "experiences", "interests", "goals", "insights", "pressure", "acts", "body"). The layout and clusters are only redone when the graph's signature changes.

The graph is rebuilt at most every 2 seconds when asked; a request inside that window gets the last build. When a live event names a node the last build doesn't have, it rebuilds at once (at most every 2 seconds) so the new node can light. When the dashboard starts it builds the graph once so the first structure is recorded; after that it's only built when the mind view asks.

## mind graph panels / mind page panels / what the mind pages show / replay growth
Both pages share the panels around the 3D view (buckets, frequencies, hearing, the ticker). The graph page (mind-graph.html) draws the graph in 3D with three.js, and also has replay growth, whole mind and the node inspector. Around it:
- Buckets: every pressure bucket's level, read from `/api/pressure` about three times a second, which also sets the resting glow of the bucket nodes.
- Frequencies: three running waves: what she hears (lines), intake energy (what it does to her) and her activity (tools, thoughts, wants).
- Hearing: the lines she's hearing.
- Everything, as it happens: a ticker of every activity event, each lighting its nodes. Clicking a line opens the node.
- "replay growth": plays back the change log, showing nodes in the order they were born (baseline nodes by their own start date). If the log can't be read it says "Her growth can't be replayed: (reason)."
- "whole mind": back to the full view, framed again on the whole network.
- A connection dot that says live when the event stream is connected.
The graph is re-read every 6 seconds, asking only whether it changed since the version it has. The body nodes also light from the avatar live stream (`/api/avatar/live`).

## how the mind graph draws / graph neurons / graph lightning
This is the knowledge graph page (src\dashboard\public\mind-graph.html), not your brain page. Owner, 2026-11-11: "cartoonish… gamified" cells. Before that day each node was drawn as a cartoon cell (a membrane, a nucleus and five to eight wavy dendrites), the view opened zoomed out in the cluster view (nodes faded to 15% under cluster blobs and 14 labels), and the bolts squirmed. Reworked that morning, it still wasn't what he meant: the brain page (mind.html) is. How the graph page draws now:
- **Neurons:** each node is a small, sharp body of light with a faint halo, tinted lightly by its kind, dim at rest and flaring brighter when it fires. Bodies shrink with distance like real points in space, down to about 1.5 screen pixels far away. A busy node like the owner doesn't balloon when it fires.
- **No connection lines are drawn** (owner, 2026-11-09). The links are real and loaded; you see one exactly when a strike crosses it.
- **A strike:** when a node fires, lightning runs from it along its 3 strongest real links, and each neuron it reaches passes it on along 1 more. The leader races across in 0.2 s, the channel flashes when it connects (and the neuron it reached fires), flickers once like a return stroke over 0.12 s, then fades over 0.55 s. Its shape is fractal (33 points) but tight to the line between the two neurons (8% of its length at the first level, halving at each level), with one or two short forks, and it never changes shape while it lives. A thin bright core line has a glow a fixed few pixels wide around it.
- **The view** opens framed on the whole network: the distance that fits nine tenths of the neurons in the panel, centred on them. The cluster view (blobs and cluster names) only takes over when you zoom out to about 1.6 times that and beyond. The wheel zooms from 3% to 3.5 times that framing. "whole mind" frames it again.

## node page / node.html / mind inspector sections
`node.html?id=kind:id` (titled "Mind Node") shows, in order: What it is (its data and config), Where it came from (provenance and the other sources that also have it), a Live box (a bucket's current level against its threshold, a feeling's live value, the reserve as of page load, or why a live control has no stored value), Change it (the editable values with an undo list), Connections (every link with type, strength, origin, in or out, each clickable), Pressures that touch it, When it fired (up to 60 of the last 400 events in her activity log that touched it, newest first, with a one-line summary of each), Related (memories linked to it; facts from kg.js for a knowledge-graph node; WordNet senses for a concept; the profile for a person), and Growth (its lines in the change log). Pictures are never linked: no module records which pictures belong to which node.

## mind edit rules / editing from the mind view / mind undo / mind errors
What can be edited and the limits `pressure.setConfigValue` enforces:
- a bucket's threshold, fill_rate, decay_rate, drain, hysteresis: a number 0 to 1. enabled: true or false.
- flow rates (`flows.N.2`): 0 to 1. Coupling rates (`flow.couplings.N.2`, per second): -1 to 1. Seeds (`seeds.from.to`): -1 to 1, only ones that already exist.
- action_costs (`action_costs.tool` or `action_costs.tool.action`): 0 to 10.
- priority of a layer: 0 to 2.
- store_share, reserve_use, overheard_uptake (on the reserve node): 0 to 1.
- appearance colours on body nodes: #RRGGBB, a colour name, or none (empty or none puts back the model's own texture).
A number sent as text is accepted. A change is saved to data\pressure-config.json at once and used from the next tick. Only values that already exist can be changed; new ones must be added to the config file by hand.

Errors you may see, each saying what, why and the fix:
- "No node (id) in her mind: nothing in her systems has that id right now (it may have been forgotten, wiped or renamed)." (404)
- "Can't edit (path) on (id): that value is not one this node exposes for editing. Use one of: ..." or, for a node with nothing to edit, why it's read-only.
- "(path) isn't a live-editable pressure setting ...", "(path) must be between (min) and (max), got (value)", "must be a number", "must be true or false", "doesn't exist in her pressure config" (from the pressure system).
- "No value to change: the request body has no path." (400)
- "The change was applied but its undo record was not saved" when data\mind-edits.jsonl can't be written.
- Undo: "Nothing to undo" (every edit is already undone, or no such edit number), "Edit #N is already undone" (409), and "Can't undo edit #N: the value has changed since: it is X now, not the Y that edit set" (409); set it back by hand instead.
- "No cluster (id): it is not in the current graph (it may have been regrouped after she grew)."
- "Her mind history could not be read" when the change log is broken; move it away and a fresh one starts on the next build.
- "No live events: the activity bus is not connected to the mind view" (503), when the dashboard wasn't started with the bot.
- "Her activity log couldn't be read" on a node's activation list.
- Sources that fail are listed on the page as "(source) couldn't be read: (reason)", and the rest of the graph still shows.
- `error` with `where` "mind view": "Her cognitive graph couldn't be built: (reason). The mind page will show the reason when it loads." logged when the dashboard starts.
- "The change log (file) couldn't be written ... Growth since the last good write won't be replayable; check the data folder is writable." shown in the unavailable list.

Read-only reasons: a feeling bucket has no per-bucket settings ("a feeling the pressure system settles on its own"); a body feeling is set by what she says and hears; mouth, blink and glance have no stored value; anything else says its module has no live setter.