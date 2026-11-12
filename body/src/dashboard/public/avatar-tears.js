// Tears: real drops that well up on the lower lid, spill over, and run down her cheeks, leaving a
// wet trail that slowly fades. They ride on her head, so they follow every movement of a sob.
//
// The model has no tear geometry, so each drop is a tiny clear, glossy bead parented to the head
// bone. Its path is laid out in the head's own space from where her eyes are: down from the lower
// lid, a little outward, and curving in with the cheek. Distances scale with the gap between her
// eyes, so they fit any face size.
import * as THREE from 'three';

let dropMaterial = null, trailMaterial = null;
function materials() {
  dropMaterial ??= new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.02, metalness: 0, transmission: 0.9, thickness: 0.002, ior: 1.33,
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.2, transparent: true, opacity: 0.9, depthWrite: false,
  });
  trailMaterial ??= new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
    envMapIntensity: 1.8, transparent: true, opacity: 0.35, depthWrite: false,
  });
  return { dropMaterial, trailMaterial };
}
const sphere = new THREE.SphereGeometry(1, 12, 10);

// Where her eyes are and which way is down/out/forward, in head space, from the rest pose.
function frameFor(c) {
  if (c.tearFrame !== undefined) return c.tearFrame;
  const head = c.bones.Head, L = c.bones.LeftEye, R = c.bones.RightEye;
  if (!head || !L || !R) return (c.tearFrame = null);
  c.root.updateMatrixWorld(true);
  const w = (o) => o.getWorldPosition(new THREE.Vector3());
  const lw = w(L), rw = w(R), gap = lw.distanceTo(rw);
  const local = (v) => head.worldToLocal(v.clone());
  const dir = (from, worldDelta) => local(from.clone().add(worldDelta)).sub(local(from)).normalize();
  const mid = lw.clone().add(rw).multiplyScalar(0.5);
  // World axes of the face at rest: down is world down; forward is from the head's centre out through
  // the eyes (bone axes differ between rigs, but the eyes are always in front).
  const forwardWorld = mid.clone().sub(w(head)); forwardWorld.y = 0;
  if (forwardWorld.lengthSq() < 1e-8) forwardWorld.set(0, 0, 1);
  forwardWorld.normalize();
  const down = dir(mid, new THREE.Vector3(0, -gap, 0)), forward = dir(mid, forwardWorld.multiplyScalar(gap));
  const scale = local(mid).distanceTo(local(mid.clone().add(new THREE.Vector3(0, gap, 0)))); // gap in head units
  const eyes = [L, R].map((eye) => {
    const p = local(w(eye));
    const out = p.clone().sub(local(mid)).normalize(); // away from the nose
    return { p, out };
  });
  return (c.tearFrame = { eyes, down, forward, gap: scale });
}

// Path of one drop at s (0..1 of its run): welling at the lid, then sliding down the cheek.
function along(f, eye, s, wobble) {
  const g = f.gap;
  const run = Math.max(0, s);
  return eye.p.clone()
    .addScaledVector(f.down, g * (0.32 + 1.25 * run))            // from the lower lid down to the jaw line
    .addScaledVector(eye.out, g * (0.08 + 0.12 * run + 0.02 * Math.sin(wobble + run * 9))) // drifts outward, a slight wander
    .addScaledVector(f.forward, g * (0.42 - 0.3 * run * run));   // sits on the skin, following the cheek back
}

// Tears per eye and how long the crying lasts (ms), by how hard she's crying.
const PLAN = { teary: { per: 1, over: 2600 }, cry: { per: 3, over: 3600 }, sob: { per: 5, over: 5000 } };

export function startTears(c, kind) {
  const f = frameFor(c), plan = PLAN[kind];
  if (!f || !plan) return false;
  const now = performance.now();
  c.tears ??= [];
  f.eyes.forEach((eye, side) => {
    for (let i = 0; i < plan.per; i++) {
      const delay = 400 + (plan.over / plan.per) * i + Math.random() * 500 + side * 250;
      c.tears.push({ eye, born: now + delay, well: 700 + Math.random() * 500, run: 2600 + Math.random() * 1400, wobble: Math.random() * 6, size: 0.75 + Math.random() * 0.5, mesh: null, trail: [] });
    }
  });
  return true;
}

// Each frame: grow, slide, leave a trail, fade. Drops eased with smoothstep so they never jump.
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
export function updateTears(c, now = performance.now()) {
  if (!c.tears?.length) return;
  const f = frameFor(c), head = c.bones.Head;
  if (!f || !head) return;
  const { dropMaterial: dm, trailMaterial: tm } = materials();
  const g = f.gap;
  for (let i = c.tears.length - 1; i >= 0; i--) {
    const d = c.tears[i];
    const age = now - d.born;
    if (age < 0) continue;
    if (!d.mesh) { d.mesh = new THREE.Mesh(sphere, dm); d.mesh.renderOrder = 3; head.add(d.mesh); }
    const welling = smooth(age / d.well);
    const s = smooth((age - d.well) / d.run); // 0 while welling, then 0..1 down the cheek
    const fade = 1 - smooth((age - d.well - d.run) / 900);
    const r = g * 0.045 * d.size * (0.35 + 0.65 * welling) * (1 - 0.35 * s); // gets a little smaller as it spreads
    d.mesh.position.copy(along(f, d.eye, s, d.wobble));
    d.mesh.scale.set(r, r * (1 + 0.9 * s), r * 0.55); // stretches as it runs, flat against the skin
    d.mesh.visible = fade > 0.01;
    // Trail: a wet streak behind it, dropped every little way, each fading on its own.
    if (s > 0 && (!d.trail.length || s - d.trail.at(-1).s > 0.04) && s < 0.98) {
      const m = new THREE.Mesh(sphere, tm.clone());
      m.position.copy(along(f, d.eye, s, d.wobble));
      m.scale.set(r * 0.55, r * 1.3, r * 0.3);
      m.renderOrder = 2;
      head.add(m);
      d.trail.push({ s, mesh: m, at: now });
    }
    for (const t of d.trail) t.mesh.material.opacity = 0.32 * (1 - smooth((now - t.at) / 4000)) * Math.max(0, fade + 0.6);
    if (fade <= 0 && d.trail.every((t) => t.mesh.material.opacity < 0.01)) {
      head.remove(d.mesh);
      for (const t of d.trail) { head.remove(t.mesh); t.mesh.material.dispose(); }
      c.tears.splice(i, 1);
    }
  }
}

// Model swapped: drop everything (the old head is gone).
export function resetTears(c) {
  for (const d of c.tears ?? []) { d.mesh?.parent?.remove(d.mesh); for (const t of d.trail) { t.mesh.parent?.remove(t.mesh); t.mesh.material.dispose(); } }
  c.tears = [];
  c.tearFrame = undefined;
}

// For the self-test: can this model cry real tears?
export const canCry = (c) => Boolean(frameFor(c));
