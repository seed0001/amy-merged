# Amy in a 3D world: Rust plan (for Owner to review)

Status: **plan only, no code written yet.** Written by the doctor on 2026-10-29 from the voice
conversation with Owner and friend_6. Items marked *(verify)* came from memory without a live web
check, so confirm versions and APIs before building.

- Sections 0–2: what we're building and the one big design choice.
- Sections 3–6: crates, her model and animations, movement, voice.
- Section 7: the small changes needed on Amy's side (Node), file by file.
- Sections 8–9: performance, risks.
- **Section 10: build order, one small milestone at a time.**

---

## 0. The honest bit first

- The task said "Prison or similar". From the call, the engine being discussed is **friend_6's**
  Rust engine (DirectX natively, WebGL in the browser, GameMaker-style scripting), and Owner then
  said "you and Claude are gonna do it". So this plan builds **Amy's own small Rust world**, and
  keeps the link to Amy engine-neutral so the same body could later live inside friend_6's engine.
- A small correction for when it comes up again: three.js *does* use the graphics card. It's a
  WebGL library, and her current avatar studio already renders on the GPU with it. What Rust buys us
  is native speed, native DirectX 12/Vulkan, no browser, and one codebase that can also target the
  web. It's not "GPU vs no GPU".
- **Amy's brain stays where it is.** Memory, persona, LLM, speech-to-text and voices all stay in
  the Node bot. The Rust app is only her **body**: it draws the world, plays her animations and
  voice, and walks where she's told. Rewriting the brain in Rust would be months of work for nothing.
- **The LLM does not steer her feet.** "Come here" is turned into a move command by plain code in
  milliseconds. The LLM decides what she *says*, and can ask for moves through a tool, but the
  walking itself (paths, turning, stopping) is deterministic game code.

---

## 1. What "done" looks like for v1

1. A window opens on Owner's PC showing a small room or yard, lit and textured.
2. Amy stands in it, using her **existing** model (`data/avatar.glb`): same face, blinking, mood
   and lip sync as in the avatar studio.
3. She idles naturally, and walks with a real walk cycle (no sliding, no T-pose).
4. Owner holds a key and says "come here, Amy". She turns, walks around obstacles to the front of
   the camera, stops, faces him, and answers out loud.
5. "Stop", "follow me", "go to the couch", "wave", "sit down" also work.
6. Later: the same app builds for the browser (WebGL2/WebGPU), and the Discord voice channel can
   command her too.

---

## 2. Architecture

```
 ┌────────────── Amy (Node, this project) ───────────────┐        ┌──────── amy-world (Rust, new) ────────┐
 │ voice/session.js   Discord voice → STT (speaker id)   │        │ Bevy app                              │
 │ dashboard/server.js                                   │  HTTP  │  ├ brain_link: HTTP + event stream    │
 │   /api/avatar/model    her .glb                 ──────┼───────▶│  ├ avatar: skeleton, clips, face      │
 │   /api/avatar/listen   PCM in → transcript      ◀─────┼────────│  ├ mic: push-to-talk (cpal)           │
 │   /api/avatar/chat     NDJSON: sentence+mp3+mood ─────┼───────▶│  ├ speech: mp3 playback + lip sync    │
 │   /api/world/events    NEW: move/emote commands  ─────┼───────▶│  ├ nav: navmesh + path follow         │
 │   /api/world/state     NEW: where she is, arrived ◀───┼────────│  ├ locomotion: idle/walk/turn blend   │
 │ src/world.js           NEW: intents + world state     │        │  └ scene: room, colliders, camera     │
 └───────────────────────────────────────────────────────┘        └───────────────────────────────────────┘
```

**The key shortcut:** the avatar studio already exposes everything a body needs. The Rust app can
be one more client of the same dashboard API:

| Need | Already there | Notes |
|---|---|---|
| Her model | `GET /api/avatar/model` | Serves `data/avatar.glb` (or a cast member's). |
| Hear Owner | `POST /api/avatar/listen` | Raw 48 kHz mono 16-bit PCM in, transcript out. |
| Her reply + voice | `POST /api/avatar/chat` | NDJSON lines: `speaker`, `state` (feelings), `sentence` (text, base64 mp3, feelings, gestures), `done`. |
| Her mood | `GET /api/avatar/emotion` | Same ~25 emotions that drive the studio face. |
| Password | dashboard password | Same Basic auth the recorder uses. |

So talking works with **zero Node changes**. Only movement needs new code (section 7).

**Why HTTP + an event stream instead of a WebSocket:** the dashboard already streams with
Server-Sent Events (`/api/events`) and NDJSON, and the Node side has no WebSocket package. Using the
same pattern means no new dependency for Amy. A WebSocket can come later if needed.

**Message shapes (new, small, JSON):**

Brain → body (`/api/world/events`):
```json
{ "type": "move",  "id": 17, "to": "caller", "caller": "910602602512784016", "stopAt": 1.2 }
{ "type": "move",  "id": 18, "to": "spot", "spot": "couch" }
{ "type": "follow","id": 19, "caller": "910602602512784016" }
{ "type": "stop",  "id": 20 }
{ "type": "emote", "id": 21, "name": "wave" }
{ "type": "look",  "id": 22, "at": "caller" }
```
Body → brain (`/api/world/state`, every ~0.5 s and on changes):
```json
{ "position": [1.2, 0, -3.4], "facing": 1.57, "doing": "walking", "command": 17,
  "result": "arrived" | "blocked" | "cancelled" | null, "spots": ["couch", "door", "window"] }
```
"caller" means "the person who said it". In the Rust app the local person **is the camera**, so v1
just resolves any caller to "a point 1.2 m in front of the camera, on the floor".

---

## 3. Crates

Engine choice: **Bevy**. It renders through **wgpu**, which uses **DirectX 12** (or Vulkan) on
Windows and **WebGL2 / WebGPU** in the browser from the same code. That's exactly the
"DirectX + WebGL" pair friend_6 described, without writing two renderers. It loads glTF with
skeletons, skins, morph targets (her face shapes) and animation clips out of the box.

| Crate | What for | Notes |
|---|---|---|
| `bevy` (current stable, pin it) | Window, renderer (wgpu), glTF, skeletal animation, morph targets, ECS | Bevy breaks APIs every release; pin the exact version and upgrade on purpose. *(verify version)* |
| `avian3d` or `bevy_rapier3d` | Colliders, keeping her on the floor, not walking through walls | Pick one; avian is more "Bevy-native". *(verify)* |
| `vleue_navigator` or `oxidized_navigation` | Navmesh from the room's colliders + pathfinding | Either works for a small room. Fallback: a hand-made grid with A* (`pathfinding` crate). *(verify)* |
| `reqwest` (blocking or with `tokio`) | Talk to Amy's dashboard API | Run it on a background thread; send results into Bevy through a channel. |
| `reqwest-eventsource` or a 30-line SSE reader | `/api/world/events` | SSE is just `data: ...\n\n` lines; hand-rolling is fine. |
| `serde`, `serde_json`, `base64` | Messages, decoding the mp3 clips | |
| `cpal` | Microphone for push-to-talk | Resample to 48 kHz mono i16 to match `/api/avatar/listen`. |
| `rodio` (with `symphonia` mp3) or `bevy_kira_audio` | Play her voice clips | We also need the decoded samples for lip sync (section 4.4). |
| `crossbeam-channel` | Network thread ↔ game thread | |
| `bevy-inspector-egui` (dev only) | Tweak walk speed, stop distance, camera live | Saves a lot of rebuilds. |

Alternative engine if Bevy feels too heavy: **Fyrox** (has an editor, also does skinned glTF/FBX).
Raw `wgpu` + `gltf` crate is possible but we'd be writing skinning, blending and morph code by hand.
Not worth it for v1.

---

## 4. Her model, skeleton and animations

### 4.1 Keep the model she already has
- Source: `data/avatar.glb` (Avaturn / Ready Player Me style), served by `/api/avatar/model`.
  **We never edit that file.** The world app gets its own copy with walk clips added (4.2).
- It already has what we need: a humanoid skeleton (`Hips`, `Spine`, `Head`, `LeftArm`...),
  ARKit face shapes and `viseme_*` mouth shapes. The studio code finds bones by stripping prefixes
  like `mixamorig:` (`avatar.js`, `c.bones[o.name.replace(/^.*[:|]/, '')]`). Do the same in Rust.
- The studio flips the model if its left arm is on screen-left. Copy that check, so she doesn't
  walk backwards.

### 4.2 Getting walk animations onto her skeleton
Her .glb almost certainly has **no body clips** (the studio animates her procedurally: breathing,
head motion, arm rest pose). For walking we need real clips:

1. Get clips: **Mixamo** (free, needs an Adobe login) or the **Ready Player Me animation library**
   (made for that exact skeleton). Need: `idle`, `walk`, `walk_back` (optional), `turn_left_90`,
   `turn_right_90`, `wave`, `sit_down`, `sitting_idle`, `stand_up`, `talk_idle`.
   Download **"in place"** versions of the walk.
2. In **Blender**: import her .glb, import each clip, retarget onto her armature (bone names
   match RPM/Mixamo after stripping the prefix; if not, the free "Rokoko Retargeting" add-on maps
   them). Keep **the same armature and bone names**. Bevy targets animations by bone-name path, so
   a mismatch just means nothing moves.
3. Export one file, `amy-world.glb`: her mesh + skeleton + face shapes + all clips. Check
   "export shape keys" and "export skins", and turn off "optimize animation size" if clips break.
4. Test it in a glTF viewer (e.g. the three.js editor or the studio itself) before touching Rust.

This preserves her look and face exactly. Only bodies get new motion.

### 4.3 Animation in Bevy
- One `AnimationGraph` per character: a **blend** between `idle` and `walk` driven by her current
  speed (0 → idle, walk speed → full walk). Scale the walk clip's playback speed to her real speed,
  which removes foot sliding.
- Turns: if the target is more than ~100° away, play a turn clip in place, then walk. Smaller
  angles: rotate smoothly while walking (max ~180°/s).
- One-shots (`wave`, `sit_down`) play on top and return to the locomotion blend when done.
- Upper-body extras from the studio (head look-at, breathing) are layered **after** the animation
  each frame, the same way `avatar.js` does now (it resets bones to rest, then adds its drivers).

### 4.4 Face: port from the avatar studio, don't reinvent
`src/dashboard/public/avatar.js` already has working, tuned drivers:
- **Blink** and **gaze** (eyes follow the camera / the person talking).
- **Mood → face**: `feelings` from `/api/avatar/chat` set ARKit shapes (`mouthSmile`, `browInnerUp`...).
- **Lip sync from audio** (around line 1244): analyses the clip as it plays (loudness, open/round/
  bright/hissy) and maps it to `viseme_aa`, `viseme_O`... or builds them from ARKit jaw/lip shapes.
- **Gestures**: the `sentence` lines already carry `gestures`.

In Bevy these become systems that write `MorphWeights` on her face meshes. The math ports almost
line for line. To do lip sync we decode the mp3 ourselves (symphonia), keep the samples, and read a
window around the playback position every frame, just like the studio does with WebAudio.

---

## 5. The world and movement

### 5.1 A contained environment
- v1: one room, about 8 × 8 m: floor, four walls, a couch, a table, a window, a door. Build it in
  Blender (or start from free **Kenney** / **Quaternius** furniture packs) and export `room.glb`.
- Name empties in Blender `spot_couch`, `spot_window`, `spot_door`. The app reads those as places
  she can be sent to, and sends the list to Amy (so she only offers places that exist).
- Colliders: simple boxes for walls and furniture. The navmesh is baked from them at startup.

### 5.2 "Come here, Amy"
1. Owner holds the talk key. `cpal` records → `POST /api/avatar/listen` → "come here amy".
2. The Rust app (v1) or Node (v2) runs the **fast intent check** (section 6) and finds `come`.
3. Target = floor point 1.2 m in front of the camera, snapped onto the navmesh.
4. Pathfind → list of waypoints. She turns toward the first one, walk blend ramps up.
5. Each frame: steer toward the next waypoint, slow down over the last ~1 m, stop at `stopAt`.
6. Arrived → turn to face the camera, blend to idle, eyes on camera. Report `arrived`.
7. Meanwhile the same transcript goes to `/api/avatar/chat`, so she answers ("Coming!") while
   walking. Her voice plays and her lips move during the walk.

If no path exists (target inside furniture, etc.): walk to the nearest reachable point and report
`blocked`, so she can say "I can't get any closer".

### 5.3 Other commands
- **Follow me**: re-target "in front of the camera" every 0.5 s while the camera moves; idle when
  close enough.
- **Stop**: cancel the path, blend to idle.
- **Go to the couch**: target = `spot_couch`. If it's a seat, play `sit_down` on arrival.
- **Wander** (when nobody's talking to her for a while): pick a random spot, walk, idle, repeat.
  Makes her feel alive. Turn it off while she's talking.

### 5.4 Camera and controls
- Default: a first-person camera at standing eye height (the "screen" is Owner). WASD + mouse to
  move, so "follow me" and "come here" have something to follow.
- A toggle for an orbit camera to watch her from the side.

---

## 6. Voice commands → movement

**Two layers, fast first:**

1. **Fast intent check (plain code, no LLM).** A short list of patterns, run on every transcript:

   | Says something like | Intent |
   |---|---|
   | "come here", "come over", "come to me", "over here" | `move to caller` |
   | "follow me", "keep up", "come with me" | `follow caller` |
   | "stop", "wait", "stay", "hold on" | `stop` |
   | "go to the {spot}", "sit on the {spot}" | `move to spot` (+ sit) |
   | "wave", "say hi" | `emote wave` |
   | "look at me" | `look at caller` |

   Rules: only fires if she's addressed (wake word / her name, the same check `voice/session.js`
   already does) or if Owner is holding the talk key in the world app. Match whole phrases, so
   "I'll stop by later" doesn't freeze her. This takes under a millisecond, so she starts moving
   before the LLM has even started answering.

2. **A `world_action` tool for the LLM**, for anything fuzzier ("can you go sit by the window and
   chill"). Same command shapes as section 2. Her tool description only appears while a world app
   is connected, so she never claims she walked somewhere when no body exists (her claim check
   already enforces "only say what your tools returned").

**Who is the caller?**
- In the world app: the camera, always.
- From Discord voice (later): `voice/session.js` already knows the speaker's user id. Give each
  known person a spot in the world (`spot_owner`, or "in front of the camera" for the owner,
  `spot_guest` for others). "Come here" from friend_6 walks her to friend_6's spot.

**STT:** reuse what she has. The world app sends PCM to `/api/avatar/listen`, which goes through
her configured speech-to-text (Whisper / Parakeet / Groq). No STT in Rust.

---

## 7. Changes on Amy's side (Node), file by file

Small, and none are needed for milestones 1–3.

| File | Change |
|---|---|
| `src/world.js` (new) | Keeps the connected world clients, the last reported state, and `sendWorld(command)`. Holds the fast intent check (`worldIntent(text)` → command or null), with a test file next to it (`src/world.test.js`) like the other modules. |
| `src/dashboard/server.js` | `GET /api/world/events`: SSE stream of commands, same pattern as `/api/events`. `POST /api/world/state`: the body reports where she is. Both behind the dashboard password. |
| `src/dashboard/server.js` (`/api/avatar/chat`) | Before the LLM call, run `worldIntent(text)`; if it matches and a world is connected, `sendWorld` it. The chat reply continues as normal. |
| `src/voice/session.js` | After a transcript passes the wake-word check, the same `worldIntent` call, with the speaker's user id as `caller` (milestone 6). |
| `src/tools.js` | `world_action` tool (`move` / `follow` / `stop` / `emote` / `look`, `spot` must be in the reported list). Returns the result when the body reports `arrived` / `blocked`, or "on my way" after ~2 s. |
| `src/capabilities.js` | Only when a world is connected: "You have a body in your 3D room. You're at the {spot}, {doing}. Places: ...". |
| `knowledge/tools.md`, `README.md` | Document the tool and the world app. |

The Rust project itself lives **outside this folder** (see 9: OneDrive).

---

## 8. Performance and RAM

Her PC already runs a lot: Ollama (LLM), Whisper/Parakeet (STT), Kokoro/XTTS (voice), sometimes
FLUX image generation. **Graphics memory is the real limit, not the CPU.**

| Thing | Rough cost | What to do |
|---|---|---|
| Bevy app, one avatar + one room | ~150–400 MB RAM, ~200–600 MB VRAM | Fine. Keep textures ≤ 2K, use KTX2 compressed textures for the room. |
| Her avatar | 30–80k triangles, ~50–70 bones, ~70 morph targets | Fine for one character. Morph targets cost GPU memory per vertex; don't add more cast members to the world than needed. |
| Ollama + FLUX at the same time | Several GB VRAM each | Renderer can't fix that. If FLUX runs while the world is open, drop to 30 fps or pause rendering. |
| Frame rate | GPU time | Cap at 60 fps (vsync). Pause or drop to ~5 fps when the window is minimized or unfocused. Shadows: one light, low resolution. |
| Bevy compile times | 1–3 min first build, slow incremental | `dynamic_linking` feature in dev, `opt-level = 1` for our crate and `3` for dependencies, the `lld`/`rust-lld` linker. |
| Disk | `target/` grows to 5–15 GB | See below. |

Latency budget for "come here": STT ~0.3–1 s → intent < 1 ms → she starts turning within one frame.
Her spoken answer comes when the LLM + TTS are ready, usually 1–3 s later, while she's already walking.

---

## 9. Risks and gotchas

- **OneDrive.** This project is inside OneDrive. A Rust `target/` folder is gigabytes of small files
  that OneDrive will try to sync, which is slow and can lock files mid-build. Put `amy-world` in
  e.g. `C:\dev\amy-world`, not on the Desktop.
- **Skeleton mismatch.** If the Blender export renames bones or adds a root, clips play on nothing.
  Check bone names after export, before blaming the code. Milestone 2 exists to catch this early.
- **Bevy version churn.** Tutorials and crates are often one version behind. Pin Bevy and choose
  physics/navmesh crates that support that exact version.
- **Facing / scale.** glTF is +Y up, facing +Z; Mixamo clips sometimes come in 100× scale or facing
  the other way. Fix it in Blender, not in code.
- **False triggers.** "Stop" in normal talk. Keep the address requirement (name / talk key) and
  whole-phrase matching. Log every fired intent to `data/activity.jsonl` like other events so
  misfires are easy to spot.
- **Two places drawing her.** If the avatar studio and the world app are both open, both may speak
  the same reply. v1: the world app is the only listener while it's open.
- **Browser build later.** WebGL2 has lower limits (fewer bones/morph targets per draw on some
  GPUs, no compute). Test her model in the web build early in milestone 7, before adding features.
- **friend_6's engine.** If we later move her into his engine, sections 2 and 7 (the HTTP protocol)
  stay the same. Only the Rust "body" side gets rewritten in his engine's terms.

---

## 10. Build order (each step is usable on its own)

| # | Milestone | Done when | Node changes |
|---|---|---|---|
| 1 | **Empty world.** `cargo new amy-world`, Bevy window, floor, light, first-person camera. | Window opens at 60 fps; check it's using DX12 (`WGPU_BACKEND=dx12`). | None |
| 2 | **Her model, still.** Load `amy-world.glb` (her .glb + clips from Blender). Play `idle`. | She stands and breathes with a real idle, right way round, right size. | None |
| 3 | **Her voice and face.** Push-to-talk → `/api/avatar/listen` → `/api/avatar/chat`; play mp3s; port blink, mood face and lip sync from `avatar.js`. | You can talk with her in the world like in the studio. | None |
| 4 | **Room and walking.** `room.glb` with colliders and `spot_*` empties; navmesh; idle/walk blend; a debug key "walk to where I click". | She walks around the couch to a clicked point, no sliding. | None |
| 5 | **"Come here."** Fast intent check (in Rust for now) on her transcripts: come / follow / stop / go to spot / wave. | "Come here, Amy" → she walks to the camera, faces you, and answers. | None |
| 6 | **Amy knows her body.** `src/world.js`, `/api/world/events` + `/api/world/state`, `world_action` tool, capability line; move the intent check into Node; Discord voice commands with speaker spots. | She can say where she is, and Discord "come here" works. | Section 7 |
| 7 | **Browser build.** `wasm32-unknown-unknown` target with `trunk`, WebGL2 (WebGPU when available), served from the dashboard. | Same world in Chrome. | Serve the files |
| 8 | **Nice-to-haves.** Wander when idle, sitting, picking things up, look-at, more rooms, other cast members. | | As needed |

Suggested first session: milestones 1 and 2 only. The Blender step in 2 is the riskiest part, and
everything after it depends on her skeleton and clips being right.
