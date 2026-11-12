// Her hands. The rig has every finger bone (Mixamo names: LeftHandThumb1..3, LeftHandIndex1..3, ...)
// and nothing moved them. This drives them: each finger has a curl (0 straight, 1 closed) and a
// spread, the thumb can oppose; named poses set targets, speech and feeling add a little life, and
// everything glides through the bone smoothing like the rest of her. The curl axis of each joint is
// worked out from the rest pose (finger direction against the palm normal), so it fits any rig
// with these bone names, whatever its local axes.

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const JOINT_MAX = { Thumb: [0.55, 0.9, 0.9], Index: [1.35, 1.6, 1.1], Middle: [1.4, 1.65, 1.15], Ring: [1.4, 1.65, 1.15], Pinky: [1.45, 1.7, 1.2] }; // radians at full curl
const SPREAD = { Thumb: 0.0, Index: 0.28, Middle: 0.05, Ring: -0.14, Pinky: -0.35 }; // radians at full spread, about the palm normal

// Pose targets: curl per finger (thumb first), spread 0..1, thumbOut 0..1 (thumb away from the palm), pinch (thumb to index).
export const HAND_POSES = {
  relaxed: { curl: [0.25, 0.22, 0.3, 0.36, 0.42], spread: 0.15 },
  open: { curl: [0.05, 0.02, 0.02, 0.03, 0.05], spread: 0.55 },
  splay: { curl: [0, 0, 0, 0, 0], spread: 1, thumbOut: 1 },
  fist: { curl: [0.85, 1, 1, 1, 1], spread: 0 },
  point: { curl: [0.6, 0.02, 1, 1, 1], spread: 0.1 },
  peace: { curl: [0.75, 0.02, 0.02, 1, 1], spread: 0.7 },
  thumbs_up: { curl: [0, 1, 1, 1, 1], spread: 0, thumbOut: 1 },
  ok_sign: { curl: [0.55, 0.75, 0.15, 0.1, 0.05], spread: 0.3, pinch: 1 },
  pinch: { curl: [0.5, 0.6, 0.55, 0.65, 0.75], spread: 0, pinch: 1 },
  rock_on: { curl: [0.7, 0.02, 1, 1, 0.02], spread: 0.6 },
  wiggle: { curl: [0.2, 0.3, 0.3, 0.3, 0.3], spread: 0.3, wiggle: 1 },
  cup: { curl: [0.4, 0.5, 0.55, 0.55, 0.6], spread: 0.1 },
};
export const HAND_POSE_NAMES = Object.keys(HAND_POSES);

// Finds the finger bones and works out, in the rest pose, each joint's curl axis and the palm normal.
export function setupHands(c, THREE) {
  c.hands = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  c.root.updateMatrixWorld(true);
  for (const side of ['Left', 'Right']) {
    const hand = c.bones[`${side}Hand`];
    const index1 = c.bones[`${side}HandIndex1`], pinky1 = c.bones[`${side}HandPinky1`], thumb2 = c.bones[`${side}HandThumb2`] ?? c.bones[`${side}HandThumb1`];
    if (!hand || !index1 || !pinky1) continue;
    const H = hand.getWorldPosition(new THREE.Vector3()), I = index1.getWorldPosition(new THREE.Vector3()), P = pinky1.getWorldPosition(new THREE.Vector3());
    // The palm plane holds the wrist and the index and pinky knuckles; its normal points to the palm
    // side, which is the side the thumb sits on.
    let palm = new THREE.Vector3().subVectors(I, H).cross(new THREE.Vector3().subVectors(P, H)).normalize();
    if (thumb2) { const T = thumb2.getWorldPosition(new THREE.Vector3()); if (new THREE.Vector3().subVectors(T, H).dot(palm) < 0) palm.negate(); }
    const forward = new THREE.Vector3().subVectors(I.clone().add(P).multiplyScalar(0.5), H).normalize(); // wrist to knuckles
    const fingers = {};
    for (const f of FINGERS) {
      const joints = [1, 2, 3].map((n) => c.bones[`${side}Hand${f}${n}`]).filter(Boolean);
      if (!joints.length) continue;
      const axes = joints.map((bone, i) => {
        const next = joints[i + 1] ?? null;
        bone.getWorldPosition(a);
        if (next) next.getWorldPosition(b); else b.copy(a).add(forward); // the tip bone points on along the finger
        const dir = b.sub(a).normalize();
        // Rotating dir about cross(dir, palm) by a positive angle swings it toward the palm: the curl.
        const axis = new THREE.Vector3().crossVectors(dir, palm).normalize();
        return { axis, dir };
      });
      fingers[f] = { joints, axes };
      for (const bone of joints) if (!c.rest.has(bone)) c.rest.set(bone, bone.quaternion.clone());
    }
    c.hands[side] = { hand, palm, forward, fingers, now: { curl: [0.25, 0.22, 0.3, 0.36, 0.42], spread: 0.15, thumbOut: 0, pinch: 0 }, seed: Math.random() * 100 };
  }
  return Object.keys(c.hands).length > 0;
}

// World-space rotation applied on top of a bone's rest, keeping its parent in mind.
const _p = new (class { constructor() { this.q = null; } })();
function rotateFromRest(bone, restQ, worldRot, THREE) {
  bone.quaternion.copy(restQ);
  bone.updateWorldMatrix(true, false);
  const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  // local = parent^-1 * world * parent  (the rotation expressed in the bone's parent space)
  const m = parentWorld.clone().invert().multiply(worldRot).multiply(parentWorld);
  bone.quaternion.premultiply(m);
}

const lerp = (x, y, k) => x + (y - x) * k;
const alpha = (tau, dt) => 1 - Math.exp(-dt / tau);

// Each frame. control: { name, strength, envelope } from the hands performance channel, or null.
// mood: { energy 0..1, tension 0..1 }; talking: whether she is speaking right now.
export function updateHands(c, dt, now, control, { talking = false, energy = 0.4, tension = 0 } = {}, THREE) {
  if (!c.hands) return;
  const t = now / 1000;
  for (const side of Object.keys(c.hands)) {
    const h = c.hands[side];
    // The target: the controlled pose blended over the resting hand by its envelope and strength.
    const base = HAND_POSES.relaxed;
    const pose = control && HAND_POSES[control.name] ? HAND_POSES[control.name] : null;
    const k = pose ? Math.max(0, Math.min(1, control.strength * control.envelope)) : 0;
    const target = {
      curl: base.curl.map((v, i) => lerp(v, pose ? pose.curl[i] : v, k)),
      spread: lerp(base.spread, pose ? pose.spread ?? 0 : base.spread, k),
      thumbOut: lerp(0, pose?.thumbOut ?? 0, k),
      pinch: lerp(0, pose?.pinch ?? 0, k),
    };
    // Life: a tense hand closes a little; talking hands open and move with the voice; a slow drift
    // between the fingers so they are never frozen; the wiggle pose ripples them.
    const tense = tension * 0.18;
    const talk = talking ? 0.12 * Math.sin(t * 5.3 + h.seed) : 0;
    for (let i = 0; i < 5; i++) {
      const drift = 0.04 * Math.sin(t * (0.35 + i * 0.07) + h.seed * (i + 1)) * (0.5 + energy);
      const ripple = pose?.wiggle ? 0.35 * Math.sin(t * 7 + i * 1.1 + h.seed) * k : 0;
      target.curl[i] = Math.max(0, Math.min(1, target.curl[i] + tense + drift + ripple - (talking ? 0.08 : 0) + (i > 0 ? talk * (i / 5) : 0)));
    }
    target.spread = Math.max(0, Math.min(1, target.spread + (talking ? 0.15 : 0) + energy * 0.05));
    // Ease toward it; the bone smoothing adds its own glide after.
    const tau = pose ? 0.12 : 0.35;
    const a = alpha(tau, dt || 0.016);
    for (let i = 0; i < 5; i++) h.now.curl[i] = lerp(h.now.curl[i], target.curl[i], a);
    h.now.spread = lerp(h.now.spread, target.spread, a);
    h.now.thumbOut = lerp(h.now.thumbOut, target.thumbOut, a);
    h.now.pinch = lerp(h.now.pinch, target.pinch, a);
    // Apply: rest, then curl about each joint's axis, spread/oppose about the palm normal at the first joint.
    const q = new THREE.Quaternion();
    FINGERS.forEach((f, fi) => {
      const finger = h.fingers[f];
      if (!finger) return;
      finger.joints.forEach((bone, ji) => {
        const rest = c.rest.get(bone);
        if (!rest) return;
        const { axis } = finger.axes[ji];
        let angle = h.now.curl[fi] * (JOINT_MAX[f][ji] ?? 1);
        if (f === 'Thumb' && ji === 0) angle = h.now.curl[fi] * JOINT_MAX.Thumb[0] * (1 - h.now.thumbOut) + h.now.pinch * 0.35;
        const world = q.setFromAxisAngle(axis, angle).clone();
        if (ji === 0) {
          // Spread about the palm normal: fingers fan out, the thumb swings away from (or across) the palm.
          const fan = f === 'Thumb' ? (-0.9 * h.now.thumbOut + 0.55 * h.now.pinch) : SPREAD[f] * h.now.spread;
          const sideSign = side === 'Left' ? 1 : -1;
          if (fan) world.premultiply(new THREE.Quaternion().setFromAxisAngle(h.palm, fan * sideSign));
        }
        rotateFromRest(bone, rest, world, THREE);
      });
    });
  }
}
