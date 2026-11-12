// Motion smoothing: the last stage before a frame is drawn. Everything that moves her (feelings,
// thinking cues, gaze, gestures, nods, the idle sway) only says where each bone and face shape
// *should* be this frame. This stage moves her there through a critically damped filter, so no
// source can make her snap, jump or start and stop abruptly: a sudden change of target becomes a
// glide that eases in, travels and eases out, with velocity that never jumps.
//
// Each channel runs two exponential stages in series (equivalent to a critically damped second-order
// system). tau is each stage's time constant in seconds: the motion settles in roughly 4 x tau.

// Bones: the torso is heavy and slow, the neck and head a little quicker, the arms quicker still so
// gestures still read, hands quickest so a wave keeps its wave.
const BONE_TAU = {
  Spine1: 0.22, Spine2: 0.2,
  Neck: 0.16, Head: 0.14,
  LeftShoulder: 0.12, RightShoulder: 0.12,
  LeftArm: 0.1, RightArm: 0.1, LeftForeArm: 0.08, RightForeArm: 0.08,
  LeftHand: 0.05, RightHand: 0.05,
  // Legs follow her steps closely so walking keeps its rhythm; hips and spine a touch slower.
  // Eyes move fast: a saccade is a quick snap, so they're barely smoothed.
  LeftEye: 0.015, RightEye: 0.015,
  Hips: 0.06, Spine: 0.08, LeftUpLeg: 0.035, RightUpLeg: 0.035, LeftLeg: 0.035, RightLeg: 0.035, LeftFoot: 0.035, RightFoot: 0.035,
};
const DEFAULT_BONE_TAU = 0.12;

// Face shapes: expression shapes glide; speech, blinks and jaw stay quick (lip sync and blinks have
// their own timing, and smoothing them would make speech mushy and blinks lazy).
const FAST = /^(viseme_|jaw|eyeBlink|mouthClose|mouthFunnel|mouthPucker|mouthRoll|mouthLower|mouthUpper|mouthStretch|mouthShrug|mouthPress|tongue)/;
const EYES = /^eyeLook/;
const SHAPE_TAU = { eyes: 0.035, expression: 0.07 };

const alpha = (tau, dt) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

// Call once per character per frame, after every bone has been posed for this frame.
// c.rest holds every bone the avatar drives; c.bones maps names to bones.
// quickNeck: a yes or no is underway. The neck and head follow it closely so a full nod or shake
// keeps its size; the gesture's own curve already starts and ends smoothly. The switch itself is
// eased, so the filter tightening and relaxing never shows as a jolt.
const QUICK_NECK = 0.2; // fraction of the usual time constant while nodding or shaking
export function smoothBones(c, dt, { quickNeck = false } = {}) {
  if (!c.rest?.size) return;
  const state = (c.smooth ??= { bones: new Map(), shapes: new Map() });
  state.quick = (state.quick ?? 0) + ((quickNeck ? 1 : 0) - (state.quick ?? 0)) * alpha(0.12, dt);
  const names = new Map(Object.entries(c.bones ?? {}).map(([name, bone]) => [bone, name]));
  for (const bone of c.rest.keys()) {
    const target = bone.quaternion;
    let s = state.bones.get(bone);
    if (!s) { state.bones.set(bone, (s = { a: target.clone(), b: target.clone() })); continue; }
    const name = names.get(bone);
    // Neck, head, shoulders and upper spine all follow closely during a nod, shake, laugh or sob.
    const neck = ['Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'Spine2'].includes(name);
    const tau = (BONE_TAU[name] ?? DEFAULT_BONE_TAU) * (neck ? 1 - (1 - QUICK_NECK) * state.quick : 1);
    const k = alpha(tau, dt);
    s.a.slerp(target, k);
    s.b.slerp(s.a, k);
    bone.quaternion.copy(s.b);
  }
}

// Call with this frame's face weights (name -> weight) before they are written to the meshes.
// Returns the smoothed weights in the same map. Shapes that stop being driven glide back to zero.
export function smoothShapes(c, weights, dt) {
  const state = (c.smooth ??= { bones: new Map(), shapes: new Map() });
  for (const name of new Set([...weights.keys(), ...state.shapes.keys()])) {
    if (FAST.test(name)) { state.shapes.delete(name); continue; }
    const target = weights.get(name) || 0;
    let s = state.shapes.get(name);
    if (!s) state.shapes.set(name, (s = { a: 0, b: 0 }));
    const k = alpha(EYES.test(name) ? SHAPE_TAU.eyes : SHAPE_TAU.expression, dt);
    s.a += (target - s.a) * k;
    s.b += (s.a - s.b) * k;
    if (target === 0 && s.b < 0.0005) { state.shapes.delete(name); weights.delete(name); continue; }
    weights.set(name, s.b);
  }
  return weights;
}

// After a model swap or a jump cut, start the filters fresh from the new pose.
export function resetSmoothing(c) { c.smooth = null; }
