// Amy's beach house: the one description of her home, ported from her earlier world (Amy-Voice
// world-layout.js) and kept as the plan she already knows. Everything here is plain numbers and pure
// functions (no three.js), so the framing plan can be tested on the server as well as drawn in the page.
//
// Units are metres. y is up. The ocean is toward +z; the front door and the road are toward -z.
//
//          road / front (-z)
//   z=-8 +----------+-----------+------------------+
//        |  entry   |  bathroom |     bedroom      |
//   z=-3 +---  ----+----  -----+------  ----------+
//        |                hallway                  |
//   z=-1 +------------+  open  +--------+--  -----+
//        |  kitchen   |                 |  studio  |
//        |  & dining  |   living room   |          |
//   z= 6 +==glass====glass====glass=====+==window==+
//        |                  deck (railing)          |
//   z=10 +-----------------  steps  ----------------+
//                     sand ... down to the water (z~32) ... ocean
//       x=-10        x=-2             x=5          x=10

export const PAD = 0.18;       // the flat sand her house stands on
export const FLOOR = 1.1;      // the finished floor: a pier-framed house stands well up off the sand
export const WALL = 3.1;       // wall height at the back (road) wall; the roof rises toward the water
export const WATERLINE = 32;   // where the sand meets the sea
export const SEA_LEVEL = -0.45;
export const HOUSE = { x: [-10, 10], z: [-8, 6] }; // the heated footprint
export const DECK = { x: [-10, 10], z: [6, 10] };

// Floor areas: what each one is called and what it is for.
export const ROOMS = {
  kitchen: { name: 'kitchen & dining', x: [-10, -2], z: [-1, 6], about: 'open kitchen with a long counter, the big fridge, and the long wooden table looking at the water' },
  living: { name: 'living room', x: [-2, 5], z: [-1, 6], about: 'the heart of the house: the deep low sofa, the reading chair facing the water, and Chance\'s bed by the sofa' },
  studio: { name: 'studio', x: [5, 10], z: [-1, 6], about: 'where she works, under a window onto the sea' },
  hall: { name: 'hall', x: [-10, 10], z: [-3, -1], about: 'the hall that joins the front of the house to the rooms' },
  bedroom: { name: 'bedroom', x: [2, 10], z: [-8, -3], about: 'her bedroom' },
  bathroom: { name: 'bath', x: [-3, 2], z: [-8, -3], about: 'a small bright bathroom' },
  entry: { name: 'entry', x: [-10, -3], z: [-8, -3], about: 'the front entry from the road' },
  deck: { name: 'deck', x: [-10, 10], z: [6, 10], outdoor: true, about: 'a wide deck right over the sand' },
};

// Walls: a line from a to b, with its openings along it as [from, to, kind] in metres from a.
// kind: door | slider (full-height) | window (sill at SILL) | open (a wide cased opening, header only).
// exterior: true for the shell (2x6 studs); the rest are 2x4 partitions.
// glass: true for the ocean wall: no studs between the openings, only mullion posts under a long beam.
export const WALLS = [
  // back of the house (road side)
  { a: [-10, -8], b: [10, -8], exterior: true, openings: [[3.4, 4.4, 'door'], [13.4, 15.2, 'window']] },
  { a: [-10, -8], b: [-10, 6], exterior: true, openings: [[9, 12, 'window']] },                        // west
  { a: [10, -8], b: [10, 6], exterior: true, openings: [[2, 4, 'window'], [9, 12, 'window']] },        // east
  // ocean side: the glass wall across the kitchen and living room, a wide window over the studio desk
  { a: [-10, 6], b: [5, 6], exterior: true, glass: true, openings: [[8.2, 11.8, 'slider']] },
  { a: [5, 6], b: [10, 6], exterior: true, openings: [[1, 4.5, 'window']] },
  // inside
  { a: [-10, -3], b: [10, -3], openings: [[3, 4.2, 'door'], [8.6, 9.6, 'door'], [14, 15.2, 'door']] }, // entry, bath, bedroom doors
  { a: [-3, -8], b: [-3, -3] },
  { a: [2, -8], b: [2, -3] },
  { a: [-10, -1], b: [10, -1], openings: [[5, 11, 'open'], [15.5, 16.7, 'door']] },                    // great room opens to the hall; studio door
  { a: [5, -1], b: [5, 6], openings: [[2.4, 3.6, 'door']] },                                            // living room <-> studio
];

// Lumber sizes (metres): nominal 2x4, 2x6, 2x8, 2x10 and 6x6, as cut.
export const LUMBER = {
  stud4: { t: 0.038, d: 0.089 },   // 2x4 partitions
  stud6: { t: 0.038, d: 0.140 },   // 2x6 exterior shell
  joist: { t: 0.038, d: 0.235 },   // 2x10 floor joists and rim
  rafter: { t: 0.038, d: 0.184 },  // 2x8 roof joists
  header: { t: 0.038, d: 0.235 },  // doubled 2x10 over every opening
  post: { t: 0.14, d: 0.14 },      // 6x6 posts under the floor and the deck, and the glass-wall mullions
  beam: { t: 0.089, d: 0.286 },    // built-up LVL beam under the floor and over the glass wall
  deckJoist: { t: 0.038, d: 0.184 },
  board: { t: 0.025, d: 0.14 },    // 5/4 deck boards
};
export const STUD_SPACING = 0.406;   // 16 inches on centre
export const JOIST_SPACING = 0.406;
export const RAFTER_SPACING = 0.61;  // 24 inches
export const DOOR_H = 2.15, SILL = 0.9, WINDOW_TOP = 2.4;
export const PLATE_T = 0.038;        // one 2x plate
export const SUBFLOOR_T = 0.018;     // 3/4 inch plywood
export const ROOF_PITCH = 1 / 12;    // a low shed roof rising toward the water: clean lines, tall at the glass
export const OVERHANG = 1.2;         // the roof runs past the ocean wall to shade the glass
export const STEP_RISE = 0.18;

// The top of a wall (top of the top plate) at z: the roof plane, rising from WALL at the back wall.
export const wallTopAt = (z) => WALL + (z - HOUSE.z[0]) * ROOF_PITCH;

// ---------------------------------------------------------------- the framing plan
// A list of pieces: { kind, x, y, z, l, h, w, yaw, pitch, tag }. (x, y, z) is the centre; l runs along the
// piece's own long axis (tilted by pitch, then turned by yaw around y), h is up, w is across. y is
// measured from the finished floor (0 = top of the subfloor); the sand is at PAD - FLOOR. tag names the
// layer the piece belongs to, so the page can switch layers on and off.

const along = (a, b) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]); return { len, ux: (b[0] - a[0]) / len, uz: (b[1] - a[1]) / len, yaw: Math.atan2(-(b[1] - a[1]), b[0] - a[0]) }; };

// One wall as pieces: a bottom plate, a doubled top plate following the roof plane, studs at 16"
// centres (left out where an opening is), a king stud each side of every opening, a doubled 2x10 header
// over it with jack studs under its ends, cripples over the header and under a window sill, and the sill.
export function frameWall(w, out = []) {
  const { len, ux, uz, yaw } = along(w.a, w.b);
  const L = w.exterior ? LUMBER.stud6 : LUMBER.stud4;
  const T = L.t, D = L.d;
  const zAt = (s) => w.a[1] + uz * s;
  const topAt = (s) => wallTopAt(zAt(s));          // top of the top plate at s
  const studTop = (s) => topAt(s) - 2 * PLATE_T;   // under the doubled top plate
  const pos = (s, y) => ({ x: w.a[0] + ux * s, y, z: zAt(s) });
  const slope = Math.atan(ROOF_PITCH) * uz;         // the plates' tilt along this wall (0 for walls along x)
  const piece = (kind, s0, s1, y0, y1, tag, extra = {}) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
    out.push({ kind, ...pos((s0 + s1) / 2, (y0 + y1) / 2), l: s1 - s0, h: y1 - y0, w: D, yaw, pitch: 0, tag, ...extra });
  };
  // a plate that follows the roof plane: its centre at the mean height, tilted by the slope
  const slopedPlate = (yBelowTop0, yBelowTop1) => {
    const y0 = topAt(0) - yBelowTop0, y1 = topAt(len) - yBelowTop0;
    out.push({ kind: 'plate', ...pos(len / 2, (y0 + y1) / 2 - (yBelowTop1 - yBelowTop0) / 2), l: Math.hypot(len, y1 - y0), h: yBelowTop1 - yBelowTop0, w: D, yaw, pitch: -slope, tag: 'walls' });
  };
  const stud = (s, y0, y1, tag = 'walls') => piece('stud', s - T / 2, s + T / 2, y0, y1, tag);
  const openings = [...(w.openings ?? [])].sort((p, q) => p[0] - q[0]);
  const covered = (s) => openings.some(([f, t]) => s > f - 2.5 * T && s < t + 2.5 * T);
  // plates: the bottom one flat, the two top ones on the roof plane
  piece('plate', 0, len, 0, PLATE_T, 'walls');
  slopedPlate(2 * PLATE_T, PLATE_T);
  slopedPlate(PLATE_T, 0);
  if (w.glass) {
    // The glass wall: 6x6 posts at the ends and either side of the slider, a built-up beam the whole
    // length under the plates, and mullion posts every 1.5 m for the panes to hang between. All opening.
    const P = LUMBER.post, B = LUMBER.beam;
    const beamY1 = studTop(0), beamY0 = beamY1 - B.d; // a wall along x: the same height all along
    out.push({ kind: 'beam', ...pos(len / 2, (beamY0 + beamY1) / 2), l: len, h: B.d, w: B.t, yaw, pitch: 0, tag: 'headers' });
    const posts = [P.t / 2, len - P.t / 2];
    for (const [f, t] of openings) posts.push(f - P.t / 2, t + P.t / 2);
    for (let s = 1.5; s < len - 0.5; s += 1.5) if (!posts.some((p) => Math.abs(p - s) < 0.6)) posts.push(s);
    posts.sort((a, b) => a - b);
    for (const s of posts) out.push({ kind: 'post', ...pos(s, PLATE_T + (beamY0 - PLATE_T) / 2), l: P.t, h: beamY0 - PLATE_T, w: P.d, yaw, pitch: 0, tag: 'walls' });
    // the openings between the posts, for the ghost glass: each bay is a pane, the slider a door of glass
    for (let i = 0; i + 1 < posts.length; i++) {
      const f = posts[i] + P.t / 2, t = posts[i + 1] - P.t / 2;
      if (t - f < 0.2) continue;
      const isSlider = openings.some(([of, ot]) => f >= of - 0.01 && t <= ot + 0.01);
      out.push({ kind: 'opening', ...pos((f + t) / 2, PLATE_T + (beamY0 - PLATE_T) / 2), l: t - f, h: beamY0 - PLATE_T, w: 0.02, yaw, pitch: 0, tag: 'openings', opening: isSlider ? 'slider' : 'glass' });
    }
    return out;
  }
  // common studs at 16" centres, skipping the openings, and the end stud
  let last = -1;
  for (let s = T / 2; s < len; s += STUD_SPACING) if (!covered(s)) { stud(s, PLATE_T, studTop(s)); last = s; }
  if (!covered(len - T / 2) && len - T / 2 - last > T * 1.5) stud(len - T / 2, PLATE_T, studTop(len - T / 2));
  // openings: king studs, jacks, header, cripples, sill
  const HD = LUMBER.header.d;
  for (const [f, t, kind] of openings) {
    const top = kind === 'window' ? WINDOW_TOP : kind === 'open' ? Math.min(DOOR_H + 0.25, studTop((f + t) / 2) - HD) : DOOR_H;
    const headerY0 = top, headerY1 = Math.min(top + HD, studTop((f + t) / 2));
    stud(f - T * 1.5, PLATE_T, studTop(f - T * 1.5)); stud(t + T * 1.5, PLATE_T, studTop(t + T * 1.5)); // kings
    stud(f - T / 2, PLATE_T, headerY0); stud(t + T / 2, PLATE_T, headerY0);                               // jacks
    out.push({ kind: 'header', ...pos((f + t) / 2, (headerY0 + headerY1) / 2), l: t - f + T, h: headerY1 - headerY0, w: Math.min(D, 2 * LUMBER.header.t), yaw, pitch: 0, tag: 'headers' });
    for (let s = f + STUD_SPACING / 2; s < t; s += STUD_SPACING) stud(s, headerY1, studTop(s));         // cripples over the header
    if (kind === 'window') {
      piece('sill', f - T, t + T, SILL - PLATE_T, SILL, 'walls');
      for (let s = f + STUD_SPACING / 2; s < t; s += STUD_SPACING) stud(s, PLATE_T, SILL - PLATE_T);    // cripples under the sill
      out.push({ kind: 'opening', ...pos((f + t) / 2, (SILL + headerY0) / 2), l: t - f, h: headerY0 - SILL, w: 0.02, yaw, pitch: 0, tag: 'openings', opening: 'window' });
    } else if (kind !== 'open') {
      out.push({ kind: 'opening', ...pos((f + t) / 2, (PLATE_T + headerY0) / 2), l: t - f, h: headerY0 - PLATE_T, w: 0.02, yaw, pitch: 0, tag: 'openings', opening: kind });
    }
  }
  return out;
}

const GROUND_Y = PAD - FLOOR; // the sand, measured from the finished floor
const PIER_H = 0.5, PIER_ABOVE = 0.35;

// The floor: concrete piers on a grid, 6x6 posts up to a built-up beam under each bearing line, a
// 2x10 rim all round, joists at 16" running the short way (z) over the beams, blocking at mid-spans,
// and the plywood subfloor in 1.2 x 2.4 sheets, staggered, with their seams.
export function frameFloor(out = []) {
  const J = LUMBER.joist, B = LUMBER.beam, P = LUMBER.post;
  const [x0, x1] = HOUSE.x, [z0, z1] = HOUSE.z;
  const sub0 = -SUBFLOOR_T;
  const joistY0 = sub0 - J.d, joistY1 = sub0;
  const beamY1 = joistY0, beamY0 = beamY1 - B.d;
  const postY0 = GROUND_Y + PIER_ABOVE;
  for (const bz of [z0, -3, -1, 2.5, z1]) {
    out.push({ kind: 'beam', x: (x0 + x1) / 2, y: (beamY0 + beamY1) / 2, z: bz, l: x1 - x0, h: B.d, w: B.t, yaw: 0, pitch: 0, tag: 'floor' });
    for (let px = x0 + 0.5; px <= x1 - 0.49; px += 2.4) {
      out.push({ kind: 'post', x: px, y: (postY0 + beamY0) / 2, z: bz, l: P.t, h: beamY0 - postY0, w: P.d, yaw: 0, pitch: 0, tag: 'foundation' });
      out.push({ kind: 'pier', x: px, y: GROUND_Y + PIER_ABOVE - PIER_H / 2, z: bz, l: 0.4, h: PIER_H, w: 0.4, yaw: 0, pitch: 0, tag: 'foundation' });
    }
  }
  // rim joists front and back
  for (const rz of [z0 + J.t / 2, z1 - J.t / 2]) out.push({ kind: 'joist', x: (x0 + x1) / 2, y: (joistY0 + joistY1) / 2, z: rz, l: x1 - x0, h: J.d, w: J.t, yaw: 0, pitch: 0, tag: 'floor' });
  // joists the short way, 16" on centre, and one at the far edge
  const jl = z1 - z0 - 2 * J.t, jz = (z0 + z1) / 2;
  let lastX = -Infinity;
  for (let jx = x0 + J.t / 2; jx <= x1 - J.t / 2 + 0.001; jx += JOIST_SPACING) { out.push({ kind: 'joist', x: jx, y: (joistY0 + joistY1) / 2, z: jz, l: jl, h: J.d, w: J.t, yaw: Math.PI / 2, pitch: 0, tag: 'floor' }); lastX = jx; }
  if (x1 - J.t / 2 - lastX > J.t * 1.5) out.push({ kind: 'joist', x: x1 - J.t / 2, y: (joistY0 + joistY1) / 2, z: jz, l: jl, h: J.d, w: J.t, yaw: Math.PI / 2, pitch: 0, tag: 'floor' });
  // blocking between the joists at mid-spans
  for (const bz of [-5.5, -2, 0.75, 4.25]) for (let jx = x0 + J.t / 2; jx + JOIST_SPACING <= x1; jx += JOIST_SPACING) {
    const l = Math.min(JOIST_SPACING - J.t, x1 - J.t / 2 - (jx + J.t / 2));
    if (l < 0.03) continue;
    out.push({ kind: 'block', x: jx + J.t / 2 + l / 2, y: (joistY0 + joistY1) / 2, z: bz, l, h: J.d * 0.96, w: J.t, yaw: 0, pitch: 0, tag: 'floor' });
  }
  // subfloor sheets, 1.2 x 2.4, staggered by half a sheet every other row
  for (let r = 0, sz = z0; sz < z1 - 0.001; sz += 1.2, r++) {
    const sh = Math.min(1.2, z1 - sz);
    for (let sx = x0 - (r % 2 ? 1.2 : 0); sx < x1 - 0.001; sx += 2.4) {
      const a = Math.max(sx, x0), b = Math.min(sx + 2.4, x1);
      if (b - a < 0.01) continue;
      out.push({ kind: 'sheet', x: (a + b) / 2, y: sub0 + SUBFLOOR_T / 2, z: sz + sh / 2, l: b - a, h: SUBFLOOR_T, w: sh, yaw: 0, pitch: 0, tag: 'subfloor' });
    }
  }
  return out;
}

// The roof: a low shed roof rising toward the water, 2x8 roof joists at 24" on centre running the short
// way, bearing on every wall's top plate, with a fascia front and back and an overhang over the deck.
export function frameRoof(out = []) {
  const R = LUMBER.rafter;
  const [x0, x1] = HOUSE.x, [z0, z1] = HOUSE.z;
  const zFront = z1 + OVERHANG, zBack = z0 - 0.45;
  const pitch = Math.atan(ROOF_PITCH);
  const mid = (zFront + zBack) / 2, len = (zFront - zBack) / Math.cos(pitch);
  const yMid = wallTopAt(mid) + R.d / 2;
  let lastX = -Infinity;
  for (let rx = x0 + R.t / 2; rx <= x1 - R.t / 2 + 0.001; rx += RAFTER_SPACING) { out.push({ kind: 'rafter', x: rx, y: yMid, z: mid, l: len, h: R.d, w: R.t, yaw: Math.PI / 2, pitch, tag: 'roof' }); lastX = rx; }
  if (x1 - R.t / 2 - lastX > R.t * 1.5) out.push({ kind: 'rafter', x: x1 - R.t / 2, y: yMid, z: mid, l: len, h: R.d, w: R.t, yaw: Math.PI / 2, pitch, tag: 'roof' });
  for (const fz of [zFront, zBack]) out.push({ kind: 'fascia', x: (x0 + x1) / 2, y: wallTopAt(fz) + R.d / 2, z: fz, l: x1 - x0, h: R.d, w: R.t, yaw: 0, pitch: 0, tag: 'roof' });
  // blocking over the bearing walls
  for (const bz of [z0, -1, z1]) for (let rx = x0 + R.t / 2; rx + RAFTER_SPACING <= x1; rx += RAFTER_SPACING) {
    const l = Math.min(RAFTER_SPACING - R.t, x1 - R.t / 2 - (rx + R.t / 2));
    if (l < 0.03) continue;
    out.push({ kind: 'block', x: rx + R.t / 2 + l / 2, y: wallTopAt(bz) + R.d / 2, z: bz, l, h: R.d * 0.96, w: R.t, yaw: 0, pitch: 0, tag: 'roof' });
  }
  return out;
}

// The deck: 6x6 posts on piers, a beam front and back, 2x8 joists at 16" running out to the sea, a rim,
// the boards (a layer of their own), and the steps down to the sand in the middle.
export function frameDeck(out = []) {
  const J = LUMBER.deckJoist, B = LUMBER.beam, P = LUMBER.post, Bd = LUMBER.board;
  const [x0, x1] = DECK.x, [z0, z1] = DECK.z;
  const top = -0.02;                          // deck boards a hair under the house floor
  const boardY0 = top - Bd.t, joistY1 = boardY0, joistY0 = joistY1 - J.d;
  const beamY1 = joistY0, beamY0 = beamY1 - B.d;
  const postY0 = GROUND_Y + PIER_ABOVE;
  for (const bz of [z0 + 0.3, z1 - 0.3]) {
    out.push({ kind: 'beam', x: (x0 + x1) / 2, y: (beamY0 + beamY1) / 2, z: bz, l: x1 - x0, h: B.d, w: B.t, yaw: 0, pitch: 0, tag: 'deck' });
    for (let px = x0 + 0.35; px <= x1 - 0.34; px += 2.4) {
      out.push({ kind: 'post', x: px, y: (postY0 + beamY0) / 2, z: bz, l: P.t, h: beamY0 - postY0, w: P.d, yaw: 0, pitch: 0, tag: 'deck' });
      out.push({ kind: 'pier', x: px, y: GROUND_Y + PIER_ABOVE - PIER_H / 2, z: bz, l: 0.4, h: PIER_H, w: 0.4, yaw: 0, pitch: 0, tag: 'deck' });
    }
  }
  let lastX = -Infinity;
  for (let jx = x0 + J.t / 2; jx <= x1 - J.t / 2 + 0.001; jx += JOIST_SPACING) { out.push({ kind: 'joist', x: jx, y: (joistY0 + joistY1) / 2, z: (z0 + z1) / 2, l: z1 - z0, h: J.d, w: J.t, yaw: Math.PI / 2, pitch: 0, tag: 'deck' }); lastX = jx; }
  if (x1 - J.t / 2 - lastX > J.t * 1.5) out.push({ kind: 'joist', x: x1 - J.t / 2, y: (joistY0 + joistY1) / 2, z: (z0 + z1) / 2, l: z1 - z0, h: J.d, w: J.t, yaw: Math.PI / 2, pitch: 0, tag: 'deck' });
  out.push({ kind: 'joist', x: (x0 + x1) / 2, y: (joistY0 + joistY1) / 2, z: z1 - J.t / 2, l: x1 - x0, h: J.d, w: J.t, yaw: 0, pitch: 0, tag: 'deck' });
  // boards run along x with a 6 mm gap
  for (let bz = z0 + Bd.d / 2; bz < z1; bz += Bd.d + 0.006) out.push({ kind: 'board', x: (x0 + x1) / 2, y: boardY0 + Bd.t / 2, z: bz, l: x1 - x0, h: Bd.t, w: Bd.d, yaw: 0, pitch: 0, tag: 'decking' });
  // steps down to the sand: treads 0.3 deep at an even rise, the sand itself the last step
  const drop = top - GROUND_Y, n = Math.max(2, Math.round(drop / STEP_RISE)), rise = drop / n;
  for (let s = 0; s < n - 1; s++) {
    const y = top - rise * (s + 1), z = z1 + 0.15 + s * 0.3;
    out.push({ kind: 'board', x: 0, y: y + Bd.t / 2, z, l: 2.4, h: Bd.t, w: 0.3, yaw: 0, pitch: 0, tag: 'deck' });
    for (const sx of [-1.15, 1.15]) out.push({ kind: 'joist', x: sx, y: y - J.d / 2, z, l: 0.3, h: J.d, w: J.t, yaw: 0, pitch: 0, tag: 'deck' });
  }
  return out;
}

// The whole framing plan, once.
export function framingPlan() {
  const out = [];
  frameFloor(out);
  for (const w of WALLS) frameWall(w, out);
  frameRoof(out);
  frameDeck(out);
  return out;
}

// What the plan is made of, by layer: how many pieces and how many metres of lumber, for the report.
export function planSummary(plan = framingPlan()) {
  const by = {};
  for (const p of plan) { const b = (by[p.tag] ??= { pieces: 0, metres: 0 }); b.pieces++; b.metres += p.l; }
  for (const b of Object.values(by)) b.metres = Math.round(b.metres);
  return by;
}

// ---------------------------------------------------------------- the agreed program, taped out on the subfloor
// Furniture footprints as painter's-tape outlines on the floor: nothing built, only where the agreed
// pieces go, so the layout can be judged. [x, z] centre, [length, depth], turn in degrees (0 faces +z,
// the ocean), the room, and the label.
export const TAPE_OUTS = [
  { name: 'deep low sofa', at: [1.4, 1.3], size: [2.4, 1.0], turn: 0, room: 'living' },
  { name: "Chance's bed", at: [-0.6, 1.0], size: [0.9, 0.7], turn: 0, room: 'living', dog: true },
  { name: 'reading chair (faces the water)', at: [3.9, 3.4], size: [0.9, 0.9], turn: 20, room: 'living' },
  { name: 'long wooden table', at: [-5.8, 3.6], size: [2.6, 1.0], turn: 90, room: 'kitchen' },
  { name: 'kitchen run', at: [-6.6, -0.6], size: [6.4, 0.65], turn: 0, room: 'kitchen' },
  { name: 'big fridge', at: [-9.55, 0.6], size: [0.9, 0.75], turn: 90, room: 'kitchen' },
  { name: 'island', at: [-5.9, 1.4], size: [3.0, 0.9], turn: 0, room: 'kitchen' },
  { name: 'desk under the window', at: [7.7, 5.1], size: [1.8, 0.8], turn: 0, room: 'studio' },
  { name: 'bed', at: [7.4, -6.6], size: [2.1, 1.7], turn: 0, room: 'bedroom' },
  { name: 'bath', at: [-1.5, -7.3], size: [1.7, 0.8], turn: 0, room: 'bathroom' },
];

// Where she stands for this pass: in the living room, facing the water. The page puts her here.
export const STAND = { at: [0.6, 2.4], face: 0, room: 'living' };

// ---------------------------------------------------------------- the land
// The land for miles around: her house and deck on a flat pad, the beach falling gently to the sea,
// dunes rising behind the house, and hills far inland. Under the water it keeps falling away.
const n2 = (x, z) => { // smooth value noise, about 0..1
  const s = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = s(ix, iz), b = s(ix + 1, iz), c = s(ix, iz + 1), d = s(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
};
const fbm2 = (x, z) => n2(x, z) * 0.5 + n2(x * 2.1 + 5, z * 2.1 + 3) * 0.25 + n2(x * 4.3 + 9, z * 4.3 + 1) * 0.125;
export function terrainAt(x, z) {
  if (z >= 10) { // beach and seabed: one steady slope to the waterline, then on down
    const y = PAD - (z - 10) * ((PAD - SEA_LEVEL) / (WATERLINE - 10));
    return z <= WATERLINE ? y + 0.03 * fbm2(x * 0.3, z * 0.3) : SEA_LEVEL - (z - WATERLINE) * 0.08;
  }
  // inland of the beach: dunes that rise the further back you go, then rolling hills
  const back = Math.min(1, (10 - z) / 45);
  let y = PAD + back * (1.2 + 2.6 * fbm2(x / 38, z / 30));
  y += Math.max(0, Math.min(1, (-z - 250) / 900)) * (25 + 45 * fbm2(x / 400, z / 400));
  // her yard: flattened around the house so the house sits level
  const pad = Math.max(Math.abs(x) - 13, (-z - 11), 0) / 10;
  if (pad < 1) y = PAD + (y - PAD) * Math.max(0, pad);
  return y;
}
export function groundAt(x, z) {
  if (z <= 10 && x >= -10 && x <= 10 && z >= -8) return FLOOR; // inside the house and on the deck
  return Math.max(terrainAt(x, z), z > WATERLINE ? SEA_LEVEL : -Infinity);
}

// The sun and moon for an hour of the day (0..24, fractions allowed), as unit direction vectors.
// Sunrise about 6:30, noon about 12:45, sunset about 19:00: the sun rises behind the house (the -z,
// road side, to the left) and sets over the water to the right, so golden hour pours in through the glass.
export function sunAt(hours) {
  const t = (hours - 6.5) / 12.5; // 0 at sunrise, 1 at sunset
  const elev = Math.sin(t * Math.PI) * (64 * Math.PI / 180);
  const az = (-100 + 200 * t) * Math.PI / 180;
  let sun = [Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev) * 0.55 + 0.25];
  if (t < 0 || t > 1) { // night: the sun is below the horizon on the far side
    const nt = t < 0 ? t : t - 1;
    sun[1] = -Math.min(0.9, Math.abs(nt) * 3.0);
  }
  const n = Math.hypot(...sun); sun = sun.map((v) => v / n);
  let moon = [-sun[0] * 0.8, Math.max(0.25, -sun[1] * 0.9), 0.6];
  const m = Math.hypot(...moon); moon = moon.map((v) => v / m);
  return { sun, moon };
}
export const GOLDEN_HOUR = 18.4; // her default mood: the hour the page opens on unless the clock is followed

// What the light is like for a sun height: daylight 0..1, how golden, the sun's colour (linear rgb) and strength.
export function lightFor(sunY) {
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const day = smooth(-0.12, 0.12, sunY);
  const golden = Math.exp(-Math.pow((sunY - 0.02) / 0.13, 2));
  const mix = (a, b, k) => a + (b - a) * k;
  const color = [1.0, mix(0.90, 0.56, golden), mix(0.80, 0.30, golden)];
  return { day, golden, color, intensity: 3.0 * day * (1 - 0.35 * golden), phase: sunY < -0.08 ? 'night' : golden > 0.4 ? 'golden hour' : 'day' };
}
